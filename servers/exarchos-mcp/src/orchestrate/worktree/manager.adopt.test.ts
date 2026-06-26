// ─── WorktreeManager — adopt harness-created worktrees (no pool) + the real
// `git worktree list --porcelain` probe + stale-after-push re-verify (DR-2/DR-12s)
//
// HIGH-tier integration suite across the git↔event-store seam: every assertion
// drives the REAL EventStore / SQLite substrate AND a REAL git repo (per-test
// tmp dirs), so adoption is pinned against the actual `git worktree list
// --porcelain` ground-truth probe — not a mock.
//
// Contract under test:
//   - adopt enumerates on-disk worktrees via the real probe and folds every
//     UNTRACKED one into `worktree.adopted`, without the manager creating it,
//     for ANY harness (Claude Code agent dir / Codex/Cursor / hand-made).
//   - a hand-made / unattached worktree records `featureId: null`.
//   - before reporting a worktree mutable, HEAD/ancestry is re-verified so a
//     worktree reused after an external push is flagged stale (not silently
//     mutated).
//   - a `worktree.released` worktree is GC-eligible, never recycled into a pool.
//   - the real git probe ⊕ event replay equals a fresh from-zero replay
//     (operational cold-rebuild, INV-1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
} from './manager.js';
import {
  createWorktreesReducer,
  type WorktreesProjection,
} from './projections/worktrees.js';

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
  git(dir, ['config', 'user.email', 'wlm@example.com']);
  git(dir, ['config', 'user.name', 'WLM Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# wlm-adopt test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** Number of on-disk worktrees git reports for `repoRoot`. */
function countOnDiskWorktrees(repoRoot: string): number {
  return git(repoRoot, ['worktree', 'list', '--porcelain'])
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

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('WorktreeManager.adopt (real git + real event store)', () => {
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

  // ─── adopt: tracks a worktree the manager did NOT create ──────────────────

  it('Adopt_HarnessOrHandMadeWorktree_AdoptedWithoutManagerCreating', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    // A real hand-made worktree — created by git directly, NOT by the manager.
    const wtPath = path.join(workdir, 'hand-wt');
    git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'hand-branch']);
    const wtId = realpathSync(wtPath);

    const before = countOnDiskWorktrees(repo);

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.adopt(repo);

    // Adoption created NO new worktree on disk — it tracks, never creates.
    expect(countOnDiskWorktrees(repo)).toBe(before);
    // The hand-made worktree was adopted via `worktree.adopted`.
    expect(result.adopted).toContain(wtId);
    const adoptedForWt = eventsOfType(store, 'worktree.adopted').filter(
      (e) => strField(e, 'worktreeId') === wtId,
    );
    expect(adoptedForWt).toHaveLength(1);
    // No `worktree.created` event — adopt is distinct from create.
    expect(eventsOfType(store, 'worktree.created')).toHaveLength(0);
    // Folds to state `adopted`, owner cleared.
    const proj = await projection(store);
    expect(proj.worktrees[wtId].state).toBe('adopted');
    expect(proj.worktrees[wtId].ownerPid).toBeNull();
  });

  // ─── adopt: no harness-specific creation assumption ───────────────────────

  it('Adopt_NoHarnessSpecificCreationAssumption', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    // A Claude Code-shaped path AND an arbitrary path — adoption treats them
    // identically; nothing assumes a specific harness owns creation.
    const agentPath = path.join(workdir, '.claude', 'worktrees', 'agent-xyz');
    await mkdir(path.dirname(agentPath), { recursive: true });
    git(repo, ['worktree', 'add', '-q', agentPath, '-b', 'agent-branch']);
    const plainPath = path.join(workdir, 'totally-arbitrary-checkout');
    git(repo, ['worktree', 'add', '-q', plainPath, '-b', 'plain-branch']);

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.adopt(repo);

    const adoptedIds = new Set(result.adopted);
    expect(adoptedIds.has(realpathSync(agentPath))).toBe(true);
    expect(adoptedIds.has(realpathSync(plainPath))).toBe(true);
    const proj = await projection(store);
    expect(proj.worktrees[realpathSync(agentPath)].state).toBe('adopted');
    expect(proj.worktrees[realpathSync(plainPath)].state).toBe('adopted');
  });

  // ─── adopt: hand-made worktree records featureId null ─────────────────────

  it('Adopt_HandMadeWorktree_RecordsFeatureIdNull', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'unattached-wt');
    git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'unattached-branch']);
    const wtId = realpathSync(wtPath);

    // Default resolver → no harness knowledge → unattached (featureId null).
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

  // ─── adopt: stale-after-push re-verify before mutation ────────────────────

  it('Adopt_StaleAfterExternalPush_ReverifiesHeadBeforeMutation', async () => {
    const originPath = path.join(workdir, 'origin.git');
    git(workdir, ['init', '-q', '--bare', originPath]);

    // Clone A: commits c1 on `work`, pushes with upstream tracking. The clone
    // names the remote `origin`, so `-u origin work` sets a real tracking ref
    // (`@{upstream}` → origin/work) — a raw path would not.
    const repoA = path.join(workdir, 'A');
    git(workdir, ['clone', '-q', originPath, repoA]);
    git(repoA, ['config', 'user.email', 'a@example.com']);
    git(repoA, ['config', 'user.name', 'A']);
    git(repoA, ['config', 'commit.gpgsign', 'false']);
    git(repoA, ['checkout', '-q', '-b', 'work']);
    await writeFile(path.join(repoA, 'f.txt'), 'c1\n');
    git(repoA, ['add', '.']);
    git(repoA, ['commit', '-q', '-m', 'c1']);
    git(repoA, ['push', '-q', '-u', 'origin', 'work']);
    const idA = realpathSync(repoA);

    // Clone B: an EXTERNAL process advances `work` to c2 and pushes.
    const repoB = path.join(workdir, 'B');
    git(workdir, ['clone', '-q', originPath, repoB]);
    git(repoB, ['config', 'user.email', 'b@example.com']);
    git(repoB, ['config', 'user.name', 'B']);
    git(repoB, ['config', 'commit.gpgsign', 'false']);
    git(repoB, ['fetch', '-q', 'origin']);
    git(repoB, ['checkout', '-q', '-B', 'work', 'origin/work']);
    await writeFile(path.join(repoB, 'f.txt'), 'c1\nc2\n');
    git(repoB, ['commit', '-q', '-am', 'c2']);
    git(repoB, ['push', '-q', 'origin', 'work']);

    const manager = new WorktreeManager({ eventStore: store });

    // Before A sees the push: HEAD is at the upstream tip → mutable.
    const before = await manager.adopt(repoA);
    const beforeReport = before.worktrees.find((w) => w.worktreeId === idA);
    expect(beforeReport?.verification.mutable).toBe(true);

    // The external push lands in A's tracking ref.
    git(repoA, ['fetch', '-q', 'origin']);

    // Re-verify (fresh HEAD/ancestry) flags A as stale-after-push → NOT mutable,
    // so a caller cannot silently drop the newly-pushed c2 by committing into A.
    const after = await manager.adopt(repoA);
    const afterReport = after.worktrees.find((w) => w.worktreeId === idA);
    expect(afterReport?.verification.mutable).toBe(false);
    expect(afterReport?.verification.reason).toBe('stale-after-push');
  });

  // ─── released worktree is GC-eligible, not pooled ─────────────────────────

  it('Released_WorktreeIsGcEligible_NotRecycledIntoPool', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'released-wt');
    git(repo, ['worktree', 'add', '-q', wtPath, '-b', 'rel-branch']);
    const wtId = realpathSync(wtPath);

    const manager = new WorktreeManager({ eventStore: store });
    // A finished agent: reserve then release the worktree.
    await manager.reserve({
      worktreeId: wtId,
      path: wtPath,
      featureId: 'feat-rel',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });
    await manager.release(wtId);
    expect((await projection(store)).worktrees[wtId].state).toBe('released');

    // An adopt pass over the live repo must NOT recycle it: no warm pool means
    // the released entry stays `released` (GC-eligible), not re-adopted/reserved.
    const result = await manager.adopt(repo);
    expect(result.adopted).not.toContain(wtId);

    const proj = await projection(store);
    expect(proj.worktrees[wtId].state).toBe('released');
    // GC-eligibility is state-based: released ∈ {released, orphan}.
    expect(['released', 'orphan']).toContain(proj.worktrees[wtId].state);
    // Adoption minted no second reservation (no pool checkout).
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(1);
  });

  // ─── operational cold rebuild: real probe ⊕ replay == fresh replay ────────

  it('Reconcile_RealGitProbePlusReplay_EqualsFreshEventLogReplay', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    git(repo, ['worktree', 'add', '-q', path.join(workdir, 'wt-a'), '-b', 'a']);
    git(repo, ['worktree', 'add', '-q', path.join(workdir, 'wt-b'), '-b', 'b']);

    const manager = new WorktreeManager({ eventStore: store });
    // Operational reconcile = real `git worktree list --porcelain` probe (adopt)
    // ⊕ the heal fold.
    const adoptResult = await manager.adopt(repo);
    await manager.reconcile();

    // The real probe genuinely adopted worktrees (guards a stubbed adopt: a
    // no-op adopt would leave both projections trivially empty-equal).
    expect(adoptResult.adopted.length).toBeGreaterThanOrEqual(3); // main + wt-a + wt-b
    const live = await projection(store);
    expect(Object.keys(live.worktrees).length).toBeGreaterThanOrEqual(3);

    // The live projection equals a fresh from-zero replay of the log alone —
    // no adapter-local state diverges from the event stream (INV-1).
    expect(freshReplay(store)).toEqual(live);
  });
});
