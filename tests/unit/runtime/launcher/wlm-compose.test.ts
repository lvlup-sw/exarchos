/**
 * Tests for `wlm-compose.ts`, which composes the launcher with the Worktree Lifecycle Manager (WLM).
 * The suite does not test the WLM internals.
 *
 * - The `worktrees@v1` projection folds a `worktree.reserved` event from the launcher.
 * - `adopt` tracks a worktree that the launcher did not create.
 * - `adopt` skips a worktree that the launcher reserved.
 * - An integration merge goes through the `serialize_merge` lease.
 *
 * Each test gets a real `EventStore` and a real git repository in temp directories.
 * The merge test runs the real lease with an injected merge, so it runs no real merge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from '../../../../src/verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';
import type { HandleMergeOrchestrateInput } from '../../../../src/verbs/merge/merge-orchestrate.js';
import { canonicalWorktreeId } from '../../../../src/verbs/worktree/pure/path-containment.js';
import type { CreateLauncherWorktreeDeps } from '../../../../src/runtime/launcher/create-worktree.js';
import { LauncherWlm, createLauncherWlm } from '../../../../src/runtime/launcher/wlm-compose.js';

/** Runs `git <args>` in `cwd` and returns the trimmed stdout. It throws on a git failure. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/** Creates a real repository on branch `work` with one commit, and returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'work']);
  await git(dir, ['config', 'user.email', 'compose@example.com']);
  await git(dir, ['config', 'user.name', 'Compose Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# wlm-compose test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** Adds the base worktree. The launcher derives its sibling worktrees from this path. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  await git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync(base);
}

/** The persisted events on the `worktrees` stream, from the synchronous read backend. */
function worktreeEvents(store: EventStore): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(WORKTREES_STREAM);
}

function eventsOfType(store: EventStore, type: string): WorkflowEvent[] {
  return worktreeEvents(store).filter((e) => e.type === type);
}

function strField(e: WorkflowEvent, key: string): string | null {
  const v = e.data?.[key];
  return typeof v === 'string' ? v : null;
}

/** A live fold of the `worktrees` stream through `worktrees@v1`. */
async function projection(store: EventStore): Promise<WorktreesProjection> {
  const { aggregate } = await store
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

/** An explicit owner identity. With it, the code under test does not probe the OS for its own start time. */
const OWNER: Pick<CreateLauncherWorktreeDeps, 'selfPid' | 'selfStartedAt'> = {
  selfPid: process.pid,
  selfStartedAt: 'compose-boot-fingerprint',
};

describe('LauncherWlm — WLM composition (real git + real event store)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-compose-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'wlm-compose-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
    ctx = { stateDir, eventStore: store, enableTelemetry: false };
    repo = await initRepo(path.join(workdir, 'repo'));
    base = await addBaseWorktree(repo, workdir);
  });

  afterEach(async () => {
    store.close();
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  /** The launcher emits one `worktree.reserved` event, and the projection folds it into a `reserved` entry. */
  it('Compose_LauncherEvents_FoldedByWorktreesProjection', async () => {
    const wlm = createLauncherWlm({ ctx });

    const result = await wlm.createWorktree(
      { baseWorktree: base, id: 'wt-fold', featureId: 'feat-fold', newBranch: 'launch-fold', repoRoot: repo },
      OWNER,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserved = eventsOfType(store, 'worktree.reserved').filter(
      (e) => strField(e, 'worktreeId') === result.worktreeId,
    );
    expect(reserved).toHaveLength(1);

    const proj = await projection(store);
    const entry = proj.worktrees[result.worktreeId];
    expect(entry).toBeDefined();
    expect(entry.state).toBe('reserved');
    expect(entry.featureId).toBe('feat-fold');
    expect(entry.ownerPid).toBe(OWNER.selfPid);
  });

  /**
   * Git adds the worktree directly, at a `.claude/worktrees/` path like a Claude Code agent worktree.
   * That path is outside the repository directory.
   * `adopt` emits one `worktree.adopted` event for that worktree and no `worktree.reserved` event.
   * The folded entry has no owner.
   */
  it('Compose_HarnessCreatedWorktree_TrackedViaAdopt', async () => {
    const nested = path.join(workdir, '.claude', 'worktrees', 'agent-harness');
    await mkdir(path.dirname(nested), { recursive: true });
    await git(repo, ['worktree', 'add', '-q', nested, '-b', 'agent-harness-branch']);
    const nestedId = canonicalWorktreeId(nested);

    const wlm = createLauncherWlm({ ctx });
    const result = await wlm.adopt(repo);

    expect(result.adopted).toContain(nestedId);
    const adoptedForNested = eventsOfType(store, 'worktree.adopted').filter(
      (e) => strField(e, 'worktreeId') === nestedId,
    );
    expect(adoptedForNested).toHaveLength(1);
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(0);
    const proj = await projection(store);
    expect(proj.worktrees[nestedId].state).toBe('adopted');
    expect(proj.worktrees[nestedId].ownerPid).toBeNull();
  });

  /**
   * The launcher creates and reserves a worktree, then `adopt` lists the worktrees on disk.
   * `adopt` skips the reserved worktree because it is already tracked, and its state stays `reserved`.
   * The count of `worktree.adopted` events must increase, which shows that `adopt` ran on the untracked worktrees.
   */
  it('Compose_LauncherCreatedWorktree_NotReAdopted', async () => {
    const wlm = createLauncherWlm({ ctx });

    const created = await wlm.createWorktree(
      { baseWorktree: base, id: 'wt-owned', featureId: 'feat-owned', newBranch: 'launch-owned', repoRoot: repo },
      OWNER,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ownedId = created.worktreeId;

    const adoptedEventsBefore = eventsOfType(store, 'worktree.adopted').length;

    const result = await wlm.adopt(repo);

    expect(result.adopted).not.toContain(ownedId);
    const adoptedForOwned = eventsOfType(store, 'worktree.adopted').filter(
      (e) => strField(e, 'worktreeId') === ownedId,
    );
    expect(adoptedForOwned).toHaveLength(0);
    const proj = await projection(store);
    expect(proj.worktrees[ownedId].state).toBe('reserved');
    expect(proj.worktrees[ownedId].ownerPid).toBe(OWNER.selfPid);
    expect(eventsOfType(store, 'worktree.adopted').length).toBeGreaterThan(
      adoptedEventsBefore,
    );
  });

  /**
   * Only the serializer appends the `worktree.merge_requested` and `worktree.merge_executed` pair.
   * One pair on the stream shows that the merge went through the lease.
   * The test injects the merge, the integration head, and the owner identity, so it runs no real merge.
   * The serializer must pass the integration ref to the merge as `targetBranch`.
   */
  it('Compose_IntegrationMerge_RoutesThroughSerializeMerge', async () => {
    const wlm = new LauncherWlm({ ctx });

    const mergeCalls: HandleMergeOrchestrateInput[] = [];
    const mergeOrchestrate = async (
      input: HandleMergeOrchestrateInput,
    ): Promise<ToolResult> => {
      mergeCalls.push(input);
      return { success: true, data: { phase: 'completed' } };
    };

    const result = await wlm.serializeIntegrationMerge(
      {
        featureId: 'feat-merge',
        integrationRef: 'integration/main',
        sourceBranch: 'task/007',
        strategy: 'squash',
      },
      {
        mergeOrchestrate,
        readIntegrationHead: () => 'deadbeef',
        selfPid: OWNER.selfPid,
        selfStartedAt: OWNER.selfStartedAt,
      },
    );

    expect(result.success).toBe(true);

    const claims = eventsOfType(store, 'worktree.merge_requested').filter(
      (e) => strField(e, 'integrationRef') === 'integration/main',
    );
    const releases = eventsOfType(store, 'worktree.merge_executed').filter(
      (e) => strField(e, 'integrationRef') === 'integration/main',
    );
    expect(claims).toHaveLength(1);
    expect(releases).toHaveLength(1);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.serializedMerge).toMatchObject({ integrationRef: 'integration/main' });

    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toMatchObject({
      featureId: 'feat-merge',
      sourceBranch: 'task/007',
      targetBranch: 'integration/main',
      strategy: 'squash',
    });
  });
});
