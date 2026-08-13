// ─── Launcher ⇄ WLM composition (DR-3) ───────────────────────────────────────
//
// The launcher is a PRODUCER/ACTUATOR; the shipped WLM tracks, verifies, and
// serializes — including for worktrees the launcher does not own. This suite
// pins the COMPOSITION seam (`wlm-compose.ts`), not the WLM internals:
//
//   - a launcher-emitted `worktree.reserved` ownership event is folded by the
//     `worktrees@v1` projection (the launcher is a producer the projection
//     consumes);
//   - a harness-created NESTED worktree is tracked via `adopt`;
//   - a launcher-created worktree (already `reserved`) is NOT re-adopted when a
//     concurrent `adopt` enumerates `git worktree list` (the manager's
//     "already tracked → skip" backstop — the crisp create-vs-adopt boundary);
//   - an integration merge routes through the shipped `serialize_merge` lease
//     (the launcher calls the serializer, never a bypass).
//
// The produce/adopt tests drive a REAL EventStore + REAL git repo (per-test tmp
// dirs) so the fold is pinned against git ground-truth. The merge-routing test
// drives the real lease with deterministic injected seams (no timers, no OS
// probe, no real git/merge) and asserts the lease pair the serializer — and only
// the serializer — appends.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import {
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from '../../verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../verbs/worktree/projections/worktrees.js';
import type { HandleMergeOrchestrateInput } from '../../verbs/merge/merge-orchestrate.js';
import { canonicalWorktreeId } from '../../verbs/worktree/pure/path-containment.js';
import type { CreateLauncherWorktreeDeps } from './create-worktree.js';
import { LauncherWlm, createLauncherWlm } from './wlm-compose.js';

// ─── git + event-store helpers ──────────────────────────────────────────────

/** Run `git <args>` from `cwd`, returning trimmed stdout (throws on failure). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Init a real repo on branch `work` with one commit; returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'work']);
  git(dir, ['config', 'user.email', 'compose@example.com']);
  git(dir, ['config', 'user.name', 'Compose Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# wlm-compose test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** A base sibling worktree the launcher derives siblings off. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync(base);
}

/** Raw persisted events on the `worktrees` stream (sync read backend). */
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

/** Live fold of the `worktrees` stream through `worktrees@v1`. */
async function projection(store: EventStore): Promise<WorktreesProjection> {
  const { aggregate } = await store
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

/** Explicit, non-empty owner identity so the reserve is deterministic + probe-free. */
const OWNER: Pick<CreateLauncherWorktreeDeps, 'selfPid' | 'selfStartedAt'> = {
  selfPid: process.pid,
  selfStartedAt: 'compose-boot-fingerprint',
};

// ─── Suite ──────────────────────────────────────────────────────────────────

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

  // ─── producer: launcher event folded by the projection ────────────────────

  it('Compose_LauncherEvents_FoldedByWorktreesProjection', async () => {
    const wlm = createLauncherWlm({ ctx });

    const result = await wlm.createWorktree(
      { baseWorktree: base, id: 'wt-fold', featureId: 'feat-fold', newBranch: 'launch-fold', repoRoot: repo },
      OWNER,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The producer emitted the ownership event the projection folds.
    const reserved = eventsOfType(store, 'worktree.reserved').filter(
      (e) => strField(e, 'worktreeId') === result.worktreeId,
    );
    expect(reserved).toHaveLength(1);

    // `worktrees@v1` folds the launcher's event into a live `reserved` entry —
    // the launcher is a producer the projection consumes (no fresh scan).
    const proj = await projection(store);
    const entry = proj.worktrees[result.worktreeId];
    expect(entry).toBeDefined();
    expect(entry.state).toBe('reserved');
    expect(entry.featureId).toBe('feat-fold');
    expect(entry.ownerPid).toBe(OWNER.selfPid);
  });

  // ─── retain adopt: harness-created nested worktree is tracked ──────────────

  it('Compose_HarnessCreatedWorktree_TrackedViaAdopt', async () => {
    // A NESTED, harness-created worktree the launcher did NOT make — shaped like
    // a Claude Code agent worktree, added by git directly.
    const nested = path.join(workdir, '.claude', 'worktrees', 'agent-harness');
    await mkdir(path.dirname(nested), { recursive: true });
    git(repo, ['worktree', 'add', '-q', nested, '-b', 'agent-harness-branch']);
    const nestedId = canonicalWorktreeId(nested);

    const wlm = createLauncherWlm({ ctx });
    const result = await wlm.adopt(repo);

    // The harness worktree is tracked via `adopt` (not create).
    expect(result.adopted).toContain(nestedId);
    const adoptedForNested = eventsOfType(store, 'worktree.adopted').filter(
      (e) => strField(e, 'worktreeId') === nestedId,
    );
    expect(adoptedForNested).toHaveLength(1);
    // The launcher created NOTHING — adopt tracks, never creates.
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(0);
    // Folds to state `adopted`, owner cleared.
    const proj = await projection(store);
    expect(proj.worktrees[nestedId].state).toBe('adopted');
    expect(proj.worktrees[nestedId].ownerPid).toBeNull();
  });

  // ─── create-vs-adopt boundary: a reserved launcher worktree is NOT re-adopted ─

  it('Compose_LauncherCreatedWorktree_NotReAdopted', async () => {
    const wlm = createLauncherWlm({ ctx });

    // Launcher creates + reserves its own worktree (now on disk AND `reserved`).
    const created = await wlm.createWorktree(
      { baseWorktree: base, id: 'wt-owned', featureId: 'feat-owned', newBranch: 'launch-owned', repoRoot: repo },
      OWNER,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ownedId = created.worktreeId;

    const adoptedEventsBefore = eventsOfType(store, 'worktree.adopted').length;

    // A concurrent adopt/prune enumerates `git worktree list` — which now
    // includes the launcher-created worktree on disk.
    const result = await wlm.adopt(repo);

    // The "already tracked → skip" backstop: the reserved launcher worktree is
    // NOT re-adopted, so the create-vs-adopt boundary stays crisp.
    expect(result.adopted).not.toContain(ownedId);
    const adoptedForOwned = eventsOfType(store, 'worktree.adopted').filter(
      (e) => strField(e, 'worktreeId') === ownedId,
    );
    expect(adoptedForOwned).toHaveLength(0);
    // Its state is untouched by adopt — still the launcher's `reserved`, never
    // flipped to `adopted`.
    const proj = await projection(store);
    expect(proj.worktrees[ownedId].state).toBe('reserved');
    expect(proj.worktrees[ownedId].ownerPid).toBe(OWNER.selfPid);
    // The main/base worktrees (untracked) WERE adopted — proving adopt ran and
    // only skipped the already-tracked one (not a no-op adopt).
    expect(eventsOfType(store, 'worktree.adopted').length).toBeGreaterThan(
      adoptedEventsBefore,
    );
  });

  // ─── caller: integration merge routes through the shipped serialize_merge ──

  it('Compose_IntegrationMerge_RoutesThroughSerializeMerge', async () => {
    const wlm = new LauncherWlm({ ctx });

    // Spy on the COMPOSED merge to capture the args the serializer threads it.
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
        // Deterministic seams — no real git / OS probe / clock dependency.
        readIntegrationHead: () => 'deadbeef',
        selfPid: OWNER.selfPid,
        selfStartedAt: OWNER.selfStartedAt,
      },
    );

    expect(result.success).toBe(true);

    // Routed THROUGH the lease: the serializer — and only the serializer —
    // appends the CLAIM/RELEASE pair on the `worktrees` stream. A bypass that
    // called `merge_orchestrate` directly would leave the stream empty.
    const claims = eventsOfType(store, 'worktree.merge_requested').filter(
      (e) => strField(e, 'integrationRef') === 'integration/main',
    );
    const releases = eventsOfType(store, 'worktree.merge_executed').filter(
      (e) => strField(e, 'integrationRef') === 'integration/main',
    );
    expect(claims).toHaveLength(1);
    expect(releases).toHaveLength(1);
    // The lease metadata only the serializer annotates rode the result through.
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.serializedMerge).toMatchObject({ integrationRef: 'integration/main' });

    // `merge_orchestrate` was composed UNCHANGED: same featureId/source, and the
    // integration ref threaded as `targetBranch`.
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toMatchObject({
      featureId: 'feat-merge',
      sourceBranch: 'task/007',
      targetBranch: 'integration/main',
      strategy: 'squash',
    });
  });
});
