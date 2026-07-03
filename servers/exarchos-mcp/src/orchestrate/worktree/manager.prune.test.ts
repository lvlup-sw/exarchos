// ─── WorktreeManager — prune (GC) handler: adopt-gate + safety ladder + the
// INV-13 two-event deletion (DR-6, Task 007)
//
// HIGH-tier integration suite across the git ↔ event-store seam: every assertion
// drives the REAL EventStore / SQLite substrate AND a REAL git repo (per-test
// tmp dirs), so the prune flow is pinned against actual `git status` /
// `git merge-base` / `git worktree remove` ground truth — not a mock.
//
// Contract under test:
//   - dry-run is the DEFAULT — report candidates + reclaimable bytes + grouped
//     skip reasons, delete nothing, run no recovery side effects.
//   - step-0 adopt-gate tracks every on-disk worktree BEFORE the ladder, so an
//     unadopted active worktree enters as `adopted` (skipped), closing #55724.
//   - eligibility is STATE-BASED (`released` / `orphan` only) — never mtime.
//   - integration ref is resolved PER-WORKTREE from the entry's `featureId` →
//     that workflow's `synthesis.integrationBranch`; null/unresolvable fails
//     closed.
//   - uncommitted OR untracked changes are never deleted (untracked-aware).
//   - orphans delete only under explicit `--prune-orphans --yes`.
//   - origin-unreachable fails closed.
//   - deletion is the INV-13 two-event split (requested → executed), resumes a
//     crash idempotently, re-verifies under the stream lock, and NEVER
//     `git reset --hard`s.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
  defaultGitRunner,
  type GitRunner,
} from './manager.js';
import type { ProcessSource, StartTimeProbe } from './pure/process-identity.js';
import type { WorktreesProjection } from './projections/worktrees.js';
import { canonicalWorktreeId } from './pure/path-containment.js';
import { IndexLockContentionError, type SleepFn } from './git-retry.js';

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
  await writeFile(path.join(dir, 'README.md'), '# wlm-prune test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** Init a repo wired to a reachable (local bare) `origin` remote. */
async function initRepoWithOrigin(
  workdir: string,
  name: string,
): Promise<string> {
  const origin = path.join(workdir, `${name}-origin.git`);
  git(workdir, ['init', '-q', '--bare', origin]);
  const repo = await initRepo(path.join(workdir, name));
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', 'origin', 'work']);
  return repo;
}

/** Add a linked worktree on a fresh branch at `repo`'s current HEAD. */
function addWorktree(repo: string, wtPath: string, branch: string): string {
  git(repo, ['worktree', 'add', '-q', wtPath, '-b', branch]);
  return canonicalWorktreeId(wtPath);
}

/** Raw persisted events on the `worktrees` stream. */
function worktreeEvents(store: EventStore): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(WORKTREES_STREAM);
}

function eventsOfType(store: EventStore, type: string): WorkflowEvent[] {
  return worktreeEvents(store).filter((e) => e.type === type);
}

/** Live fold of the `worktrees` stream through `worktrees@v1`. */
async function projection(store: EventStore): Promise<WorktreesProjection> {
  const { aggregate } = await store
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

/** A ProcessSource backed by a PID→create-time map (absent PID ⇒ exited). */
function sourceFrom(table: Record<number, string>): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      return Object.prototype.hasOwnProperty.call(table, pid)
        ? { status: 'present', startedAt: table[pid] }
        : { status: 'absent' };
    },
  };
}

/** A source under which EVERY pid is dead. */
const ALL_DEAD: ProcessSource = sourceFrom({});

/** Stamp `synthesis.integrationBranch` for `featureId` via a real `state.patched`. */
async function setIntegrationBranch(
  store: EventStore,
  featureId: string,
  branch: string,
): Promise<void> {
  await store.append(featureId, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': branch } },
  });
}

/** Orphan a linked worktree by deleting the backing `.git` admin dir it points at. */
function orphanWorktree(wtPath: string): void {
  const dotGit = readFileSync(path.join(wtPath, '.git'), 'utf8');
  const match = dotGit.match(/^gitdir:\s*(.+)$/m);
  if (!match) throw new Error(`no gitdir pointer in ${wtPath}/.git`);
  rmSync(match[1].trim(), { recursive: true, force: true });
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('WorktreeManager.prune (real git + real event store)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-prune-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'wlm-prune-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  /**
   * Reserve→release a worktree so it folds to `released` with `featureId` set —
   * the precondition for delete-eligibility. Returns the canonical id.
   */
  async function makeReleased(
    manager: WorktreeManager,
    wtPath: string,
    featureId: string | null,
  ): Promise<string> {
    const wtId = canonicalWorktreeId(wtPath);
    await manager.reserve({
      worktreeId: wtId,
      path: wtPath,
      featureId,
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
    });
    await manager.release(wtId);
    return wtId;
  }

  // ─── dry-run default: deletes nothing, reports candidates + bytes ─────────

  it('Prune_DefaultInvocation_DeletesNothing_ReportsCandidatesAndBytes', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']); // integration ref at HEAD
    const wtPath = path.join(workdir, 'wt-eligible');
    addWorktree(repo, wtPath, 'wbranch'); // HEAD == feat/integ → merged
    await setIntegrationBranch(store, 'feat-1', 'feat/integ');

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-1');

    // No explicit apply flag ⇒ dry-run.
    const result = await manager.prune({ repoRoot: repo });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    // Nothing was removed: no remove events, the worktree is still on disk.
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(0);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();

    // The eligible candidate is reported with reclaimable bytes > 0.
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification.action).toBe('delete-eligible');
    expect(report?.deleted).toBe(false);
    expect(report?.reclaimableBytes).toBeGreaterThan(0);
    expect(result.reclaimableBytes).toBeGreaterThan(0);
  });

  // ─── adopt-gate runs before the ladder ────────────────────────────────────

  it('Prune_AdoptGate_ReconcilesUnadoptedWorktreesBeforeLadder', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'unadopted');
    const wtId = addWorktree(repo, wtPath, 'unadopted-branch');

    // No prior reserve/adopt: the worktree has NO worktrees@v1 entry yet.
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.prune({ repoRoot: repo }); // dry-run

    // Step-0 adopt-gate folded it to `adopted` BEFORE classification, so it is
    // a tracked candidate (state `adopted`, skipped `active`) — never a
    // no-adoption-record the ladder would have to defend against blind.
    const adopted = eventsOfType(store, 'worktree.adopted').filter(
      (e) => (e.data as { worktreeId?: unknown }).worktreeId === wtId,
    );
    expect(adopted).toHaveLength(1);
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.state).toBe('adopted');
    expect(report?.classification).toEqual({ action: 'skip', reason: 'active' });
  });

  // ─── eligibility is state-based ───────────────────────────────────────────

  it('Prune_OnlyReleasedOrOrphanState_IsDeletionEligible', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-x', 'feat/integ');

    const adoptedPath = path.join(workdir, 'wt-adopted');
    const reservedPath = path.join(workdir, 'wt-reserved');
    const releasedPath = path.join(workdir, 'wt-released');
    const orphanPath = path.join(workdir, 'wt-orphan');
    const adoptedId = addWorktree(repo, adoptedPath, 'b-adopted');
    const reservedId = addWorktree(repo, reservedPath, 'b-reserved');
    const releasedId = addWorktree(repo, releasedPath, 'b-released');
    const orphanId = addWorktree(repo, orphanPath, 'b-orphan');

    // Live owner so the reserved one is provably in-use (not just `active`).
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 777: 'boot-777' }),
    });

    // adopted
    await store.append(WORKTREES_STREAM, {
      type: 'worktree.adopted',
      data: {
        worktreeId: adoptedId,
        path: adoptedPath,
        featureId: 'feat-x',
        ownerPid: null,
        ownerStartedAt: null,
        operationId: randomUUID(),
      },
    });
    // reserved (live)
    await manager.reserve({
      worktreeId: reservedId,
      path: reservedPath,
      featureId: 'feat-x',
      ownerPid: 777,
      ownerStartedAt: 'boot-777',
    });
    // released
    await makeReleased(manager, releasedPath, 'feat-x');
    // orphan: detected + backing admin dir removed
    await store.append(WORKTREES_STREAM, {
      type: 'worktree.orphan_detected',
      data: {
        worktreeId: orphanId,
        path: orphanPath,
        featureId: 'feat-x',
        ownerPid: null,
        ownerStartedAt: null,
        operationId: randomUUID(),
      },
    });
    orphanWorktree(orphanPath);

    const result = await manager.prune({ repoRoot: repo }); // dry-run
    const byId = new Map(result.candidates.map((c) => [c.worktreeId, c]));

    // Only released / orphan are deletion-eligible; adopted / reserved are not.
    expect(byId.get(adoptedId)?.classification).toEqual({
      action: 'skip',
      reason: 'active',
    });
    expect(byId.get(reservedId)?.classification).toEqual({
      action: 'skip',
      reason: 'in-use',
    });
    expect(byId.get(releasedId)?.classification.action).toBe('delete-eligible');
    expect(byId.get(orphanId)?.classification.action).toBe('orphan-unverifiable');
  });

  // ─── #55724: an unadopted clean worktree is never deleted ─────────────────

  it('Prune_UnadoptedCleanWorktree_NotDeleted_ReproducesAndBlocks55724', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'agent-clean');
    const wtId = addWorktree(repo, wtPath, 'agent-clean-branch');
    // Clean working tree, NO adoption record — the exact #55724 shape a naive
    // recency GC would reclaim, losing an active agent's checkout.

    const manager = new WorktreeManager({ eventStore: store });
    // Even an explicit apply run must not delete it.
    const result = await manager.prune({ repoRoot: repo, apply: true });

    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    // The adopt-gate folded it to `adopted` and the ladder skipped it `active`.
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'active' });
    // Still on disk + still tracked.
    expect((await projection(store)).worktrees[wtId].state).toBe('adopted');
  });

  // ─── state-based, NOT mtime ───────────────────────────────────────────────

  it('Prune_LongRunningUnreleasedWorktree_StaleMtime_NotDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-lr', 'feat/integ');
    const wtPath = path.join(workdir, 'long-runner');
    const wtId = addWorktree(repo, wtPath, 'lr-branch');

    // A long-running agent: its files have a very old mtime, but it is reserved
    // by a LIVE owner — a naive mtime/recency GC would reclaim it mid-flight.
    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(path.join(wtPath, 'README.md'), old, old);
    utimesSync(wtPath, old, old);

    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 555: 'boot-555' }),
    });
    await manager.reserve({
      worktreeId: wtId,
      path: wtPath,
      featureId: 'feat-lr',
      ownerPid: 555,
      ownerStartedAt: 'boot-555',
    });

    const result = await manager.prune({ repoRoot: repo, apply: true });

    // Skipped on STATE (in-use) despite the stale mtime — never deleted.
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'in-use' });
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId].state).toBe('reserved');
  });

  // ─── per-worktree integration ref resolution ──────────────────────────────

  it('Prune_ResolvesIntegrationRefPerWorktreeFromFeatureId', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    // feat/A sits at the initial commit; feat/B too. W1 (feat-a) stays at the
    // initial commit → merged into feat/A. W2 (feat-b) gains an extra commit →
    // NOT merged into feat/B. Each worktree must resolve ITS OWN feature's ref.
    git(repo, ['branch', 'feat/A']);
    git(repo, ['branch', 'feat/B']);
    await setIntegrationBranch(store, 'feat-a', 'feat/A');
    await setIntegrationBranch(store, 'feat-b', 'feat/B');

    const w1Path = path.join(workdir, 'wt-a');
    const w2Path = path.join(workdir, 'wt-b');
    addWorktree(repo, w1Path, 'wa'); // at initial commit
    addWorktree(repo, w2Path, 'wb');
    // W2 advances past feat/B with an unmerged commit.
    await writeFile(path.join(w2Path, 'extra.txt'), 'unmerged work\n');
    git(w2Path, ['add', '.']);
    git(w2Path, ['commit', '-q', '-m', 'unmerged']);

    const manager = new WorktreeManager({ eventStore: store });
    const w1Id = await makeReleased(manager, w1Path, 'feat-a');
    const w2Id = await makeReleased(manager, w2Path, 'feat-b');

    const result = await manager.prune({ repoRoot: repo }); // dry-run
    const byId = new Map(result.candidates.map((c) => [c.worktreeId, c]));

    // W1 resolves feat/A (merged) → eligible; W2 resolves feat/B (unmerged) →
    // skipped. A swapped/global ref would flip these — this pins per-worktree.
    expect(byId.get(w1Id)?.classification.action).toBe('delete-eligible');
    expect(byId.get(w2Id)?.classification).toEqual({
      action: 'skip',
      reason: 'unmerged',
    });
  });

  // ─── null featureId / unresolvable branch fails closed ────────────────────

  it('Prune_NullFeatureIdOrUnresolvableBranch_FailsClosed', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    const nullPath = path.join(workdir, 'wt-null');
    const noBranchPath = path.join(workdir, 'wt-nobranch');
    addWorktree(repo, nullPath, 'null-branch');
    addWorktree(repo, noBranchPath, 'nobranch-branch');
    // `feat-set` has a featureId but its workflow never set an integrationBranch.

    const manager = new WorktreeManager({ eventStore: store });
    const nullId = await makeReleased(manager, nullPath, null); // unattached
    const noBranchId = await makeReleased(manager, noBranchPath, 'feat-set');

    const result = await manager.prune({ repoRoot: repo, apply: true });
    const byId = new Map(result.candidates.map((c) => [c.worktreeId, c]));

    // Both fail closed at the integration-ref rung — neither is deleted.
    expect(byId.get(nullId)?.classification).toEqual({
      action: 'skip',
      reason: 'unverifiable-integration-ref',
    });
    expect(byId.get(noBranchId)?.classification).toEqual({
      action: 'skip',
      reason: 'unverifiable-integration-ref',
    });
    expect(result.deleted).toEqual([]);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
  });

  // ─── #55724 Fix 2: untracked / uncommitted work is never deleted ──────────

  it('Prune_UncommittedOrUntracked_NeverDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-dirty', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-dirty');
    addWorktree(repo, wtPath, 'dirty-branch'); // HEAD merged → otherwise eligible

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-dirty');
    // ONLY an untracked file — proves the dirty probe is `--untracked-files=all`.
    await writeFile(path.join(wtPath, 'scratch.txt'), 'unsaved agent work\n');

    const result = await manager.prune({ repoRoot: repo, apply: true });

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'dirty' });
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
  });

  // ─── orphan deletion is gated on --prune-orphans --yes ────────────────────

  it('Prune_Orphan_OnlyDeletedWithExplicitPruneOrphansYes', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-orph', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-orph');
    const wtId = addWorktree(repo, wtPath, 'orph-branch');

    await store.append(WORKTREES_STREAM, {
      type: 'worktree.orphan_detected',
      data: {
        worktreeId: wtId,
        path: wtPath,
        featureId: 'feat-orph',
        ownerPid: null,
        ownerStartedAt: null,
        operationId: randomUUID(),
      },
    });
    orphanWorktree(wtPath);

    const manager = new WorktreeManager({ eventStore: store });

    // apply WITHOUT the orphan opt-in: the orphan is reported but NOT deleted.
    const guarded = await manager.prune({ repoRoot: repo, apply: true });
    expect(guarded.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(0);
    expect(
      guarded.candidates.find((c) => c.worktreeId === wtId)?.classification
        .action,
    ).toBe('orphan-unverifiable');

    // apply WITH --prune-orphans --yes: the orphan IS deleted (two-event split).
    const opted = await manager.prune({
      repoRoot: repo,
      apply: true,
      pruneOrphans: true,
      yes: true,
    });
    expect(opted.deleted).toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(1);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(1);
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  // ─── origin unreachable fails closed ──────────────────────────────────────

  it('Prune_OriginUnreachable_FailsClosed', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    // An origin that points nowhere — `git ls-remote origin` fails fast.
    git(repo, ['remote', 'add', 'origin', path.join(workdir, 'no-such-origin.git')]);
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-unreach', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-unreach');
    addWorktree(repo, wtPath, 'unreach-branch'); // clean + merged → only origin blocks

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-unreach');

    const result = await manager.prune({ repoRoot: repo, apply: true });

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({
      action: 'skip',
      reason: 'origin-unreachable',
    });
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
  });

  // ─── INV-13 two-event deletion ────────────────────────────────────────────

  it('Prune_Deletion_EmitsRemoveRequestedThenExecuted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-del', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-del');
    addWorktree(repo, wtPath, 'del-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-del');

    const result = await manager.prune({ repoRoot: repo, apply: true });
    expect(result.deleted).toContain(wtId);

    const requested = eventsOfType(store, 'worktree.remove.requested');
    const executed = eventsOfType(store, 'worktree.remove.executed');
    expect(requested).toHaveLength(1);
    expect(executed).toHaveLength(1);
    // requested is durable intent emitted BEFORE the side-effect's executed.
    expect((requested[0].sequence as number)).toBeLessThan(
      executed[0].sequence as number,
    );
    // Same operationId correlates the pair (1:1), and the worktree was removed.
    const reqOp = (requested[0].data as { operationId?: unknown }).operationId;
    const exeData = executed[0].data as { operationId?: unknown; removed?: unknown };
    expect(typeof reqOp).toBe('string');
    expect(exeData.operationId).toBe(reqOp);
    expect(exeData.removed).toBe(true);
    // Entry dropped from the projection; gone from disk.
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
    const stillListed = git(repo, ['worktree', 'list', '--porcelain']).includes(
      wtId,
    );
    expect(stillListed).toBe(false);
  });

  // ─── crash between requested and executed resumes idempotently ────────────

  it('Prune_CrashBetweenRequestedAndDelete_ResumesIdempotently_SingleExecuted', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'wt-crash');
    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await (async () => {
      addWorktree(repo, wtPath, 'crash-branch');
      return makeReleased(manager, wtPath, null);
    })();

    // Simulate a crashed real run: the durable intent (requested) was committed
    // and the git side-effect ran, but the process died BEFORE `executed`.
    const operationId = randomUUID();
    await store.append(
      WORKTREES_STREAM,
      { type: 'worktree.remove.requested', data: { operationId, worktreePath: wtPath } },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    );
    git(repo, ['worktree', 'remove', '--force', wtPath]); // side-effect already happened

    // Resume: prune's recovery pass finishes the orphaned requested idempotently.
    await manager.prune({ repoRoot: repo, apply: true });

    const requested = eventsOfType(store, 'worktree.remove.requested');
    const executed = eventsOfType(store, 'worktree.remove.executed');
    // Exactly one of each, same operationId — no duplicate requested minted.
    expect(requested).toHaveLength(1);
    expect(executed).toHaveLength(1);
    const exeData = executed[0].data as { operationId?: unknown; removed?: unknown };
    expect(exeData.operationId).toBe(operationId);
    // Worktree already absent ⇒ executed once with removed:false (idempotent).
    expect(exeData.removed).toBe(false);
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  // ─── concurrent with reconcile: re-verify under lock, no double-free ──────

  it('Prune_ConcurrentWithReconcile_ReverifiesUnderLock_NoDoubleFree', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-cc', 'feat/integ');

    const delPath = path.join(workdir, 'wt-del');
    const deadPath = path.join(workdir, 'wt-dead');
    addWorktree(repo, delPath, 'del-branch');
    addWorktree(repo, deadPath, 'dead-branch');

    // Every owner is dead so reconcile WILL write (release wt-dead) concurrently
    // with prune deleting wt-del, stressing the shared `worktrees` stream lock.
    const manager = new WorktreeManager({
      eventStore: store,
      processSource: ALL_DEAD,
    });
    const delId = await makeReleased(manager, delPath, 'feat-cc');
    // wt-dead: reserved with a dead owner + NO featureId → reconcile releases it
    // but it is never delete-eligible (fails closed), so prune never touches it.
    const deadId = canonicalWorktreeId(deadPath);
    await manager.reserve({
      worktreeId: deadId,
      path: deadPath,
      featureId: null,
      ownerPid: 31337,
      ownerStartedAt: 'boot-31337',
    });

    const [pruneResult] = await Promise.all([
      manager.prune({ repoRoot: repo, apply: true }),
      manager.reconcile(),
    ]);

    // wt-del removed EXACTLY once — one executed with removed:true, no double-free.
    const executedTrue = eventsOfType(store, 'worktree.remove.executed').filter(
      (e) => (e.data as { removed?: unknown }).removed === true,
    );
    expect(executedTrue).toHaveLength(1);
    expect((executedTrue[0].data as { worktreePath?: unknown }).worktreePath).toBe(
      delPath,
    );
    expect(pruneResult.deleted).toContain(delId);

    const proj = await projection(store);
    expect(proj.worktrees[delId]).toBeUndefined(); // dropped
    expect(proj.worktrees[deadId].state).toBe('released'); // reconcile healed it
  });

  // ─── fix 1: a dirty-probe FAILURE (backing present) fails closed ──────────

  it('Prune_DirtyProbeFails_BackingPresent_FailsClosed_NotDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-probe', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-probe');
    const wtId = addWorktree(repo, wtPath, 'probe-branch'); // clean + merged → otherwise eligible
    const canonicalWt = canonicalWorktreeId(wtPath);

    // The worktree's backing repo is PRESENT, but `git status` ERRORS (non-zero)
    // — a locked index / transient failure. Cleanliness is unverifiable, so the
    // probe must fail CLOSED (treat as dirty, skip), never read as clean and
    // proceed to delete-eligible (the data-loss hole). Other git ops pass through.
    const statusErrorsRunner: GitRunner = {
      run(args, cwd) {
        if (args[0] === 'status' && canonicalWorktreeId(cwd) === canonicalWt) {
          return { status: 128, stdout: '' }; // git status failed.
        }
        return defaultGitRunner.run(args, cwd);
      },
    };

    const manager = new WorktreeManager({
      eventStore: store,
      gitRunner: statusErrorsRunner,
    });
    const releasedId = await makeReleased(manager, wtPath, 'feat-probe');
    expect(releasedId).toBe(wtId);

    const result = await manager.prune({ repoRoot: repo, apply: true });

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'dirty' });
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
  });

  // ─── TOCTOU: goes dirty between plan and under-lock commit → not deleted ──

  it('Prune_GoesDirtyBetweenPlanAndCommit_NotDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-toctou', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-toctou');
    const wtId = addWorktree(repo, wtPath, 'toctou-branch'); // clean + merged → eligible
    const canonicalWt = canonicalWorktreeId(wtPath);

    // A runner that reports the TARGET worktree CLEAN on the first `git status`
    // (the planning classification) but DIRTY on every subsequent one (the
    // under-lock re-verify inside executeDeletion). This is the TOCTOU window:
    // the worktree became dirty AFTER it was classified delete-eligible. The
    // re-check under the lock must catch it and abort — `entry.state` alone is
    // still `released`, so a state-only re-check (the bug) would delete it.
    let targetStatusCalls = 0;
    const flipToDirtyRunner: GitRunner = {
      run(args, cwd) {
        const isTargetStatus =
          args[0] === 'status' && canonicalWorktreeId(cwd) === canonicalWt;
        if (isTargetStatus) {
          targetStatusCalls += 1;
          if (targetStatusCalls > 1) {
            // Second+ status on the target → pretend an untracked file appeared.
            return { status: 0, stdout: '?? scratch.txt\n' };
          }
        }
        return defaultGitRunner.run(args, cwd);
      },
    };

    const manager = new WorktreeManager({
      eventStore: store,
      gitRunner: flipToDirtyRunner,
    });
    const releasedId = await makeReleased(manager, wtPath, 'feat-toctou');
    expect(releasedId).toBe(wtId);

    const result = await manager.prune({ repoRoot: repo, apply: true });

    // Planning saw it eligible, but the under-lock re-verify saw it dirty and
    // aborted: nothing deleted, NO durable remove intent committed, entry intact.
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(0);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
    // Confirm the re-verify actually ran a second status probe on the target.
    expect(targetStatusCalls).toBeGreaterThan(1);
  });

  // ─── recovery path never uses `git reset --hard` ──────────────────────────

  it('Prune_RecoveryPath_NeverUsesResetHard', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'wt-recover');
    addWorktree(repo, wtPath, 'recover-branch');

    // Record every git argument vector the prune flow issues.
    const recorded: string[][] = [];
    const recordingRunner: GitRunner = {
      run(args, cwd) {
        recorded.push([...args]);
        return defaultGitRunner.run(args, cwd);
      },
    };
    const manager = new WorktreeManager({
      eventStore: store,
      gitRunner: recordingRunner,
    });
    const wtId = await makeReleased(manager, wtPath, null);

    // A crashed deletion whose worktree is STILL registered — forces the
    // recovery path to actually run `git worktree remove` (not a no-op).
    const operationId = randomUUID();
    await store.append(
      WORKTREES_STREAM,
      { type: 'worktree.remove.requested', data: { operationId, worktreePath: wtPath } },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    );

    await manager.prune({ repoRoot: repo, apply: true });

    // The recovery + deletion path drives `git worktree remove` and NEVER
    // `git reset --hard` (the data-loss command this slice exists to forbid).
    expect(recorded.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(
      true,
    );
    expect(
      recorded.some((a) => a[0] === 'reset' && a.includes('--hard')),
    ).toBe(false);
    // The crashed deletion was completed: entry dropped.
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  // ─── DR-1: the prune remove path is wrapped in the index.lock retry kernel ──
  //
  // These tests prove the manager ITSELF retries on transient `.git/index.lock`
  // contention (DR-1 wiring of the DR-8 `withIndexLockRetry` kernel) — not a
  // stub. They drive the real `removeWorktreeIfRegistered` mutation and inject a
  // `gitRunner` that simulates `index.lock` contention on the `git worktree
  // remove` attempts, with the backoff `sleep` injected so the retry sequence is
  // deterministic and incurs no real wall-clock wait.

  /** A no-op injected sleep that records the backoff delays passed to it. */
  function recordingSleep(): { sleep: SleepFn; delays: number[] } {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };
  }

  /** The exact lock-contention diagnostic git writes to stderr under #55724. */
  const INDEX_LOCK_STDERR =
    "fatal: Unable to create '/repo/.git/index.lock': File exists.\n" +
    'Another git process seems to be running in this repository.';

  it('PruneExecutor_TransientIndexLock_RetriesWithBackoffThenRemoves', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    git(repo, ['branch', 'feat/integ']); // integration ref at HEAD → merged
    await setIntegrationBranch(store, 'feat-lock', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-lock-retry');
    const wtId = addWorktree(repo, wtPath, 'lock-retry-branch');

    // Fail the FIRST two `git worktree remove` attempts with an index.lock
    // contention error (status 128 + the lock diagnostic on stderr), then let
    // the real git remove run on the third attempt and succeed.
    let removeAttempts = 0;
    const contendingRunner: GitRunner = {
      run(args, cwd) {
        const isRemove = args[0] === 'worktree' && args[1] === 'remove';
        if (isRemove) {
          removeAttempts += 1;
          if (removeAttempts <= 2) {
            return { status: 128, stdout: '', stderr: INDEX_LOCK_STDERR };
          }
        }
        return defaultGitRunner.run(args, cwd);
      },
    };

    const { sleep, delays } = recordingSleep();
    const manager = new WorktreeManager({
      eventStore: store,
      gitRunner: contendingRunner,
      sleep,
      jitter: () => 0, // zero jitter → deterministic [200, 400, 800] backoff base
    });
    const releasedId = await makeReleased(manager, wtPath, 'feat-lock');
    expect(releasedId).toBe(wtId);

    // Drive the real deletion path: `removeWorktreeIfRegistered` must retry past
    // the two transient lock failures and ultimately remove the worktree.
    await manager.prune({ repoRoot: repo, apply: true });

    // Retried exactly twice (3 total attempts), then succeeded.
    expect(removeAttempts).toBe(3);
    // Two backoff sleeps were applied (zero jitter ⇒ 200ms, 400ms).
    expect(delays).toEqual([200, 400]);
    // The worktree was actually removed: one executed event with removed:true.
    const executedTrue = eventsOfType(store, 'worktree.remove.executed').filter(
      (e) => (e.data as { removed?: unknown }).removed === true,
    );
    expect(executedTrue).toHaveLength(1);
    // And the projection entry is dropped.
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  it('PruneExecutor_ExhaustedIndexLockRetry_PropagatesStructuredErrorNoDelete', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'wt-lock-exhaust');
    const wtId = addWorktree(repo, wtPath, 'lock-exhaust-branch');

    // EVERY `git worktree remove` attempt loses the index.lock race — the
    // contention never clears, so the bounded retry budget is exhausted.
    let removeAttempts = 0;
    const alwaysContendingRunner: GitRunner = {
      run(args, cwd) {
        const isRemove = args[0] === 'worktree' && args[1] === 'remove';
        if (isRemove) {
          removeAttempts += 1;
          return { status: 128, stdout: '', stderr: INDEX_LOCK_STDERR };
        }
        return defaultGitRunner.run(args, cwd);
      },
    };

    const { sleep } = recordingSleep();
    const manager = new WorktreeManager({
      eventStore: store,
      gitRunner: alwaysContendingRunner,
      sleep,
      jitter: () => 0,
      maxIndexLockRetries: 2, // shrink the budget: 3 total attempts then exhaust
    });
    const releasedId = await makeReleased(manager, wtPath, null);

    // A crashed deletion whose worktree is STILL registered forces the recovery
    // path to actually run `git worktree remove` (the DR-1 retry seam),
    // independent of the eligibility ladder.
    const operationId = randomUUID();
    await store.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.remove.requested',
        data: { operationId, worktreePath: wtPath, worktreeId: releasedId },
      },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    );

    // Exhausted retries surface a STRUCTURED error, never a silent no-op (DR-1).
    await expect(manager.prune({ repoRoot: repo, apply: true })).rejects.toThrow(
      IndexLockContentionError,
    );
    // Initial attempt + 2 retries = 3 total before exhaustion.
    expect(removeAttempts).toBe(3);
    // The remove mutation failed, so NO executed event committed — the entry is
    // still tracked (no half-state false-drop).
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
  });
});
