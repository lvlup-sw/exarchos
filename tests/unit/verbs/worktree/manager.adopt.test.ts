// Tests for `WorktreeManager.adopt` against a real git repo and a real EventStore, with no mock of the git probe.
// Adopt folds each untracked on-disk worktree into `worktree.adopted` and creates none, whatever harness made it.
// A hand-made worktree records `featureId: null`.
// Adopt re-verifies HEAD and ancestry, so a worktree reused after an external push is stale, not mutable.
// A released worktree stays GC-eligible and never goes back into a pool.
// The real probe plus event replay equals a fresh replay from zero.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from '../../../../src/verbs/worktree/manager.js';
import {
  createWorktreesReducer,
  type WorktreesProjection,
} from '../../../../src/verbs/worktree/projections/worktrees.js';
import { canonicalWorktreeId } from '../../../../src/verbs/worktree/pure/path-containment.js';

/** Run `git <args>` from `cwd`, returning trimmed stdout (throws on failure). */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/** Creates a real repo on branch `work` with one commit and returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'work']);
  await git(dir, ['config', 'user.email', 'wlm@example.com']);
  await git(dir, ['config', 'user.name', 'WLM Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# wlm-adopt test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** Number of on-disk worktrees git reports for `repoRoot`. */
async function countOnDiskWorktrees(repoRoot: string): Promise<number> {
  return (await git(repoRoot, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
}

/** Raw persisted events on the `worktrees` stream. */
function worktreeEvents(store: EventStore): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(WORKTREES_STREAM);
}

function eventsOfType(store: EventStore, type: string): WorkflowEvent[] {
  return worktreeEvents(store).filter((e) => e.type === type);
}

/** Read a string field off an event payload (null when absent/non-string). */
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

/** Fresh from-zero replay of the event log through a new reducer instance. */
function freshReplay(store: EventStore): WorktreesProjection {
  const reducer = createWorktreesReducer();
  let state = reducer.initial;
  for (const ev of worktreeEvents(store)) {
    state = reducer.apply(state, ev);
  }
  return state;
}

/**
 * Skipped on win32. Each test uses the default process table, and its win32 enumeration is nondeterministic on the shared CI runner.
 * A live process cwd can resolve inside a temp worktree and flip owner liveness at random (#1641).
 */
describe.skipIf(process.platform === 'win32')('WorktreeManager.adopt (real git + real event store)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-adopt-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'wlm-adopt-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  /** Adopt tracks a worktree that git made directly. It creates no worktree on disk and writes no `worktree.created` event. */
  it('Adopt_HarnessOrHandMadeWorktree_AdoptedWithoutManagerCreating', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'hand-wt');
    await git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'hand-branch']);
    const wtId = canonicalWorktreeId(wtPath);

    const before = await countOnDiskWorktrees(repo);

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.adopt(repo);

    expect(await countOnDiskWorktrees(repo)).toBe(before);
    expect(result.adopted).toContain(wtId);
    const adoptedForWt = eventsOfType(store, 'worktree.adopted').filter(
      (e) => strField(e, 'worktreeId') === wtId,
    );
    expect(adoptedForWt).toHaveLength(1);
    expect(eventsOfType(store, 'worktree.created')).toHaveLength(0);
    const proj = await projection(store);
    expect(proj.worktrees[wtId].state).toBe('adopted');
    expect(proj.worktrees[wtId].ownerPid).toBeNull();
  });

  /** Adopt treats a Claude Code agent path and an arbitrary path the same way. */
  it('Adopt_NoHarnessSpecificCreationAssumption', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const agentPath = path.join(workdir, '.claude', 'worktrees', 'agent-xyz');
    await mkdir(path.dirname(agentPath), { recursive: true });
    await git(repo, ['worktree', 'add', '-q', agentPath, '-b', 'agent-branch']);
    const plainPath = path.join(workdir, 'totally-arbitrary-checkout');
    await git(repo, ['worktree', 'add', '-q', plainPath, '-b', 'plain-branch']);

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.adopt(repo);

    const adoptedIds = new Set(result.adopted);
    expect(adoptedIds.has(canonicalWorktreeId(agentPath))).toBe(true);
    expect(adoptedIds.has(canonicalWorktreeId(plainPath))).toBe(true);
    const proj = await projection(store);
    expect(proj.worktrees[canonicalWorktreeId(agentPath)].state).toBe('adopted');
    expect(proj.worktrees[canonicalWorktreeId(plainPath)].state).toBe('adopted');
  });

  /** The default resolver has no harness knowledge, so the worktree is unattached with `featureId` null. */
  it('Adopt_HandMadeWorktree_RecordsFeatureIdNull', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'unattached-wt');
    await git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'unattached-branch']);
    const wtId = canonicalWorktreeId(wtPath);

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.adopt(repo);

    const report = result.worktrees.find((w) => w.worktreeId === wtId);
    expect(report?.featureId).toBeNull();
    const adoptedEvent = eventsOfType(store, 'worktree.adopted').find(
      (e) => strField(e, 'worktreeId') === wtId,
    );
    expect(adoptedEvent).toBeDefined();
    expect(strField(adoptedEvent as WorkflowEvent, 'featureId')).toBeNull();
    const proj = await projection(store);
    expect(proj.worktrees[wtId].featureId).toBeNull();
  });

  /**
   * Clone A pushes `c1` with upstream tracking, and clone B pushes `c2` on the same branch.
   * The clone names the remote `origin`, so `-u origin work` sets a real `@{upstream}`, which a raw path does not.
   * After A fetches, adopt flags A as `stale-after-push`, so a commit into A cannot drop `c2`.
   */
  it('Adopt_StaleAfterExternalPush_ReverifiesHeadBeforeMutation', async () => {
    const originPath = path.join(workdir, 'origin.git');
    await git(workdir, ['init', '-q', '--bare', originPath]);

    const repoA = path.join(workdir, 'A');
    await git(workdir, ['clone', '-q', originPath, repoA]);
    await git(repoA, ['config', 'user.email', 'a@example.com']);
    await git(repoA, ['config', 'user.name', 'A']);
    await git(repoA, ['config', 'commit.gpgsign', 'false']);
    await git(repoA, ['checkout', '-q', '-b', 'work']);
    await writeFile(path.join(repoA, 'f.txt'), 'c1\n');
    await git(repoA, ['add', '.']);
    await git(repoA, ['commit', '-q', '-m', 'c1']);
    await git(repoA, ['push', '-q', '-u', 'origin', 'work']);
    const idA = canonicalWorktreeId(repoA);

    const repoB = path.join(workdir, 'B');
    await git(workdir, ['clone', '-q', originPath, repoB]);
    await git(repoB, ['config', 'user.email', 'b@example.com']);
    await git(repoB, ['config', 'user.name', 'B']);
    await git(repoB, ['config', 'commit.gpgsign', 'false']);
    await git(repoB, ['fetch', '-q', 'origin']);
    await git(repoB, ['checkout', '-q', '-B', 'work', 'origin/work']);
    await writeFile(path.join(repoB, 'f.txt'), 'c1\nc2\n');
    await git(repoB, ['commit', '-q', '-am', 'c2']);
    await git(repoB, ['push', '-q', 'origin', 'work']);

    const manager = new WorktreeManager({ eventStore: store });

    const before = await manager.adopt(repoA);
    const beforeReport = before.worktrees.find((w) => w.worktreeId === idA);
    expect(beforeReport?.verification.mutable).toBe(true);

    await git(repoA, ['fetch', '-q', 'origin']);

    const after = await manager.adopt(repoA);
    const afterReport = after.worktrees.find((w) => w.worktreeId === idA);
    expect(afterReport?.verification.mutable).toBe(false);
    expect(afterReport?.verification.reason).toBe('stale-after-push');
  });

  /** A reserved and released worktree stays `released` after adopt. Adopt does not re-adopt it or write a second reservation. */
  it('Released_WorktreeIsGcEligible_NotRecycledIntoPool', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'released-wt');
    await git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'rel-branch']);
    const wtId = canonicalWorktreeId(wtPath);

    const manager = new WorktreeManager({ eventStore: store });
    await manager.reserve({
      worktreeId: wtId,
      path: wtPath,
      featureId: 'feat-rel',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });
    await manager.release(wtId);
    expect((await projection(store)).worktrees[wtId].state).toBe('released');

    const result = await manager.adopt(repo);
    expect(result.adopted).not.toContain(wtId);

    const proj = await projection(store);
    expect(proj.worktrees[wtId].state).toBe('released');
    expect(['released', 'orphan']).toContain(proj.worktrees[wtId].state);
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(1);
  });

  /**
   * Adopt with the real probe plus `reconcile` gives a live projection equal to a fresh replay from zero.
   * At least three adopted worktrees (main, `wt-a`, `wt-b`) stop a no-op adopt from passing with two empty projections.
   */
  it('Reconcile_RealGitProbePlusReplay_EqualsFreshEventLogReplay', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    await git(repo, ['worktree', 'add', '-q', path.join(workdir, 'wt-a'), '-b', 'a']);
    await git(repo, ['worktree', 'add', '-q', path.join(workdir, 'wt-b'), '-b', 'b']);

    const manager = new WorktreeManager({ eventStore: store });
    const adoptResult = await manager.adopt(repo);
    await manager.reconcile();

    expect(adoptResult.adopted.length).toBeGreaterThanOrEqual(3);
    const live = await projection(store);
    expect(Object.keys(live.worktrees).length).toBeGreaterThanOrEqual(3);

    expect(freshReplay(store)).toEqual(live);
  });
});
