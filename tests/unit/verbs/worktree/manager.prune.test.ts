// Tests for `WorktreeManager.prune` against a real git repo and a real EventStore, with no mock of git.
// A dry run is the default. It reports candidates, reclaimable bytes, and skip reasons, and deletes nothing.
//
// An adopt step tracks each on-disk worktree before the safety ladder runs, so an unadopted active worktree is skipped.
// Eligibility depends on state (`released` or `orphan`), never on mtime.
// Each worktree resolves its integration ref from its `featureId`, and a missing ref fails closed.
// Uncommitted or untracked changes, an unreachable origin, and an orphan without `pruneOrphans` and `yes` block deletion.
//
// A deletion writes `worktree.remove.requested` and then `worktree.remove.executed`.
// It resumes a crash with no duplicate event, re-verifies under the stream lock, and never runs `git reset --hard`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { rmrfAsync, rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
  defaultGitRunner,
  type GitRunner,
  type GitWorktreeProbe,
} from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource, StartTimeProbe } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';
import { canonicalWorktreeId } from '../../../../src/verbs/worktree/pure/path-containment.js';
import { IndexLockContentionError, type SleepFn } from '../../../../src/verbs/worktree/git-retry.js';

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
  await writeFile(path.join(dir, 'README.md'), '# wlm-prune test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** Init a repo wired to a reachable (local bare) `origin` remote. */
async function initRepoWithOrigin(
  workdir: string,
  name: string,
): Promise<string> {
  const origin = path.join(workdir, `${name}-origin.git`);
  await git(workdir, ['init', '-q', '--bare', origin]);
  const repo = await initRepo(path.join(workdir, name));
  await git(repo, ['remote', 'add', 'origin', origin]);
  await git(repo, ['push', '-q', 'origin', 'work']);
  return repo;
}

/** Add a linked worktree on a fresh branch at `repo`'s current HEAD. */
async function addWorktree(repo: string, wtPath: string, branch: string): Promise<string> {
  await git(repo, ['worktree', 'add', '-q', wtPath, '-b', branch]);
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
  rmrf(match[1].trim());
}

/**
 * Skipped on win32. Each test uses the default process table, and its win32 enumeration is nondeterministic on the shared CI runner.
 * A live process cwd can resolve inside a temp worktree and flip prune occupancy verdicts at random (#1641).
 * `makeReleased` reserves and releases a worktree, so it folds to `released`, which delete-eligibility requires.
 */
describe.skipIf(process.platform === 'win32')('WorktreeManager.prune (real git + real event store)', () => {
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

  /**
   * With no apply flag, prune is a dry run.
   * The worktree branch is at the integration ref, so the worktree is merged and delete-eligible, but it stays on disk.
   */
  it('Prune_DefaultInvocation_DeletesNothing_ReportsCandidatesAndBytes', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    const wtPath = path.join(workdir, 'wt-eligible');
    await addWorktree(repo, wtPath, 'wbranch');
    await setIntegrationBranch(store, 'feat-1', 'feat/integ');

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-1');

    const result = await manager.prune({ repoRoot: repo });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(0);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification.action).toBe('delete-eligible');
    expect(report?.deleted).toBe(false);
    expect(report?.reclaimableBytes).toBeGreaterThan(0);
    expect(result.reclaimableBytes).toBeGreaterThan(0);
  });

  /**
   * The worktree has no `worktrees@v1` entry before prune.
   * The adopt step folds it to `adopted` before classification, so the ladder skips it as `active`.
   */
  it('Prune_AdoptGate_ReconcilesUnadoptedWorktreesBeforeLadder', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'unadopted');
    const wtId = await addWorktree(repo, wtPath, 'unadopted-branch');

    expect((await projection(store)).worktrees[wtId]).toBeUndefined();

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.prune({ repoRoot: repo });

    const adopted = eventsOfType(store, 'worktree.adopted').filter(
      (e) => (e.data as { worktreeId?: unknown }).worktreeId === wtId,
    );
    expect(adopted).toHaveLength(1);
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.state).toBe('adopted');
    expect(report?.classification).toEqual({ action: 'skip', reason: 'active' });
  });

  /**
   * The test makes one worktree in each state: adopted, reserved, released, and orphan.
   * Live owner 777 makes the reserved worktree `in-use`, not only `active`.
   */
  it('Prune_OnlyReleasedOrOrphanState_IsDeletionEligible', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-x', 'feat/integ');

    const adoptedPath = path.join(workdir, 'wt-adopted');
    const reservedPath = path.join(workdir, 'wt-reserved');
    const releasedPath = path.join(workdir, 'wt-released');
    const orphanPath = path.join(workdir, 'wt-orphan');
    const adoptedId = await addWorktree(repo, adoptedPath, 'b-adopted');
    const reservedId = await addWorktree(repo, reservedPath, 'b-reserved');
    const releasedId = await addWorktree(repo, releasedPath, 'b-released');
    const orphanId = await addWorktree(repo, orphanPath, 'b-orphan');

    const manager = new WorktreeManager({
      eventStore: store,
      processSource: sourceFrom({ 777: 'boot-777' }),
    });

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
    await manager.reserve({
      worktreeId: reservedId,
      path: reservedPath,
      featureId: 'feat-x',
      ownerPid: 777,
      ownerStartedAt: 'boot-777',
    });
    await makeReleased(manager, releasedPath, 'feat-x');
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

    const result = await manager.prune({ repoRoot: repo });
    const byId = new Map(result.candidates.map((c) => [c.worktreeId, c]));

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

  /**
   * A recency GC deletes a clean worktree with no adoption record and loses the checkout of an active agent (#55724).
   * Even with `apply`, the adopt step folds it to `adopted` and the ladder skips it as `active`.
   */
  it('Prune_UnadoptedCleanWorktree_NotDeleted_ReproducesAndBlocks55724', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'agent-clean');
    const wtId = await addWorktree(repo, wtPath, 'agent-clean-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.prune({ repoRoot: repo, apply: true });

    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'active' });
    expect((await projection(store)).worktrees[wtId].state).toBe('adopted');
  });

  /** The files have a very old mtime, but a live owner holds the reservation. Prune skips it as `in-use` and does not delete it. */
  it('Prune_LongRunningUnreleasedWorktree_StaleMtime_NotDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-lr', 'feat/integ');
    const wtPath = path.join(workdir, 'long-runner');
    const wtId = await addWorktree(repo, wtPath, 'lr-branch');

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

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'in-use' });
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId].state).toBe('reserved');
  });

  /**
   * `feat/A` and `feat/B` both sit at the initial commit. W1 stays there, so it is merged into `feat/A`.
   * W2 gets an extra commit, so it is not merged into `feat/B`.
   */
  it('Prune_ResolvesIntegrationRefPerWorktreeFromFeatureId', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/A']);
    await git(repo, ['branch', 'feat/B']);
    await setIntegrationBranch(store, 'feat-a', 'feat/A');
    await setIntegrationBranch(store, 'feat-b', 'feat/B');

    const w1Path = path.join(workdir, 'wt-a');
    const w2Path = path.join(workdir, 'wt-b');
    await addWorktree(repo, w1Path, 'wa');
    await addWorktree(repo, w2Path, 'wb');
    await writeFile(path.join(w2Path, 'extra.txt'), 'unmerged work\n');
    await git(w2Path, ['add', '.']);
    await git(w2Path, ['commit', '-q', '-m', 'unmerged']);

    const manager = new WorktreeManager({ eventStore: store });
    const w1Id = await makeReleased(manager, w1Path, 'feat-a');
    const w2Id = await makeReleased(manager, w2Path, 'feat-b');

    const result = await manager.prune({ repoRoot: repo });
    const byId = new Map(result.candidates.map((c) => [c.worktreeId, c]));

    expect(byId.get(w1Id)?.classification.action).toBe('delete-eligible');
    expect(byId.get(w2Id)?.classification).toEqual({
      action: 'skip',
      reason: 'unmerged',
    });
  });

  /**
   * One worktree has a null `featureId`, and the workflow of `feat-set` has no `integrationBranch`.
   * Both fail closed at the integration-ref rung, so prune deletes neither.
   */
  it('Prune_NullFeatureIdOrUnresolvableBranch_FailsClosed', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    const nullPath = path.join(workdir, 'wt-null');
    const noBranchPath = path.join(workdir, 'wt-nobranch');
    await addWorktree(repo, nullPath, 'null-branch');
    await addWorktree(repo, noBranchPath, 'nobranch-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const nullId = await makeReleased(manager, nullPath, null);
    const noBranchId = await makeReleased(manager, noBranchPath, 'feat-set');

    const result = await manager.prune({ repoRoot: repo, apply: true });
    const byId = new Map(result.candidates.map((c) => [c.worktreeId, c]));

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

  /** The worktree is merged and otherwise eligible. Only an untracked file makes it dirty, so the dirty probe must count untracked files. */
  it('Prune_UncommittedOrUntracked_NeverDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-dirty', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-dirty');
    await addWorktree(repo, wtPath, 'dirty-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-dirty');
    await writeFile(path.join(wtPath, 'scratch.txt'), 'unsaved agent work\n');

    const result = await manager.prune({ repoRoot: repo, apply: true });

    const report = result.candidates.find((c) => c.worktreeId === wtId);
    expect(report?.classification).toEqual({ action: 'skip', reason: 'dirty' });
    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
  });

  /**
   * With `apply` alone, prune reports the orphan and does not delete it.
   * With `pruneOrphans` and `yes`, it deletes the orphan with the two-event split.
   */
  it('Prune_Orphan_OnlyDeletedWithExplicitPruneOrphansYes', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-orph', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-orph');
    const wtId = await addWorktree(repo, wtPath, 'orph-branch');

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

    const guarded = await manager.prune({ repoRoot: repo, apply: true });
    expect(guarded.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(0);
    expect(
      guarded.candidates.find((c) => c.worktreeId === wtId)?.classification
        .action,
    ).toBe('orphan-unverifiable');

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

  /**
   * The `origin` remote points to a path that does not exist, so `git ls-remote origin` fails.
   * The worktree is clean and merged, so only the origin check blocks it.
   */
  it('Prune_OriginUnreachable_FailsClosed', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    await git(repo, ['remote', 'add', 'origin', path.join(workdir, 'no-such-origin.git')]);
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-unreach', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-unreach');
    await addWorktree(repo, wtPath, 'unreach-branch');

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

  /**
   * `worktree.remove.requested` comes before `worktree.remove.executed`, and both carry the same `operationId`.
   * The worktree leaves the projection and the disk.
   */
  it('Prune_Deletion_EmitsRemoveRequestedThenExecuted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-del', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-del');
    await addWorktree(repo, wtPath, 'del-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-del');

    const result = await manager.prune({ repoRoot: repo, apply: true });
    expect(result.deleted).toContain(wtId);

    const requested = eventsOfType(store, 'worktree.remove.requested');
    const executed = eventsOfType(store, 'worktree.remove.executed');
    expect(requested).toHaveLength(1);
    expect(executed).toHaveLength(1);
    expect((requested[0].sequence as number)).toBeLessThan(
      executed[0].sequence as number,
    );
    const reqOp = (requested[0].data as { operationId?: unknown }).operationId;
    const exeData = executed[0].data as { operationId?: unknown; removed?: unknown };
    expect(typeof reqOp).toBe('string');
    expect(exeData.operationId).toBe(reqOp);
    expect(exeData.removed).toBe(true);
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
    const stillListed = (await git(repo, ['worktree', 'list', '--porcelain'])).includes(
      wtId,
    );
    expect(stillListed).toBe(false);
  });

  /**
   * A prune pass writes one `prune.executing_started` and one `prune.executed` with the same `operationId`.
   * The started event carries the repo root and holder PID, and comes before the remove events. The terminal comes after them.
   * The terminal reports the deleted count and clears `inFlightPrunes`.
   */
  it('PruneWorktrees_Run_EmitsStartedAndTerminalExactlyOnce', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-live', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-live');
    await addWorktree(repo, wtPath, 'live-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await makeReleased(manager, wtPath, 'feat-live');

    const result = await manager.prune({ repoRoot: repo, apply: true });
    expect(result.deleted).toContain(wtId);

    const started = eventsOfType(store, 'prune.executing_started');
    const executed = eventsOfType(store, 'prune.executed');
    expect(started).toHaveLength(1);
    expect(executed).toHaveLength(1);

    const startData = started[0].data as {
      operationId?: unknown;
      repoRoot?: unknown;
      holderPid?: unknown;
    };
    const endData = executed[0].data as {
      operationId?: unknown;
      deletedCount?: unknown;
    };
    expect(typeof startData.operationId).toBe('string');
    expect(endData.operationId).toBe(startData.operationId);
    expect(startData.repoRoot).toBe(repo);
    expect(startData.holderPid).toBe(process.pid);
    expect(endData.deletedCount).toBe(1);

    const removeReq = eventsOfType(store, 'worktree.remove.requested')[0];
    const removeExe = eventsOfType(store, 'worktree.remove.executed')[0];
    expect(started[0].sequence as number).toBeLessThan(
      removeReq.sequence as number,
    );
    expect(executed[0].sequence as number).toBeGreaterThan(
      removeExe.sequence as number,
    );

    expect((await projection(store)).inFlightPrunes).toEqual({});
  });

  /** A dry run also runs the adopt step and git probes, so it writes the liveness pair for `ps` and `wait`. The terminal reports 0 deleted. */
  it('PruneWorktrees_DryRun_AlsoEmitsLivenessPairSoPsSeesIt', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    const wtPath = path.join(workdir, 'wt-dry');
    await addWorktree(repo, wtPath, 'dry-branch');

    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.prune({ repoRoot: repo });
    expect(result.dryRun).toBe(true);

    const started = eventsOfType(store, 'prune.executing_started');
    const executed = eventsOfType(store, 'prune.executed');
    expect(started).toHaveLength(1);
    expect(executed).toHaveLength(1);
    expect((executed[0].data as { deletedCount?: unknown }).deletedCount).toBe(0);
    expect((await projection(store)).inFlightPrunes).toEqual({});
  });

  /**
   * When the git probe throws during the pass, a `finally` block still writes one terminal with the same `operationId` and 0 deleted.
   * No in-flight prune stays behind.
   */
  it('PruneWorktrees_LadderThrows_StillEmitsTerminal_PairStays1To1', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const boom: GitWorktreeProbe = {
      listWorktrees() {
        throw new Error('git worktree list blew up mid-prune');
      },
      verifyHead() {
        throw new Error('unreached — listWorktrees throws first');
      },
    };
    const manager = new WorktreeManager({ eventStore: store, gitProbe: boom });

    await expect(
      manager.prune({ repoRoot: repo, apply: true }),
    ).rejects.toThrow(/blew up mid-prune/);

    const started = eventsOfType(store, 'prune.executing_started');
    const executed = eventsOfType(store, 'prune.executed');
    expect(started).toHaveLength(1);
    expect(executed).toHaveLength(1);
    const startOp = (started[0].data as { operationId?: unknown }).operationId;
    expect((executed[0].data as { operationId?: unknown }).operationId).toBe(
      startOp,
    );
    expect((executed[0].data as { deletedCount?: unknown }).deletedCount).toBe(0);
    expect((await projection(store)).inFlightPrunes).toEqual({});
  });

  /**
   * This simulates a crash: `worktree.remove.requested` is committed and git removed the worktree, but no `executed` event exists.
   * The recovery pass writes one `executed` with the same `operationId` and `removed: false`, and no second `requested`.
   */
  it('Prune_CrashBetweenRequestedAndDelete_ResumesIdempotently_SingleExecuted', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'wt-crash');
    const manager = new WorktreeManager({ eventStore: store });
    const wtId = await (async () => {
      await addWorktree(repo, wtPath, 'crash-branch');
      return makeReleased(manager, wtPath, null);
    })();

    const operationId = randomUUID();
    await store.append(
      WORKTREES_STREAM,
      { type: 'worktree.remove.requested', data: { operationId, worktreePath: wtPath } },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    );
    await git(repo, ['worktree', 'remove', '--force', wtPath]);

    await manager.prune({ repoRoot: repo, apply: true });

    const requested = eventsOfType(store, 'worktree.remove.requested');
    const executed = eventsOfType(store, 'worktree.remove.executed');
    expect(requested).toHaveLength(1);
    expect(executed).toHaveLength(1);
    const exeData = executed[0].data as { operationId?: unknown; removed?: unknown };
    expect(exeData.operationId).toBe(operationId);
    expect(exeData.removed).toBe(false);
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  /**
   * Each owner is dead, so `reconcile` releases `wt-dead` while prune deletes `wt-del` on the same stream lock.
   * `wt-dead` has no `featureId`, so it is never delete-eligible. Prune removes `wt-del` exactly once.
   */
  it('Prune_ConcurrentWithReconcile_ReverifiesUnderLock_NoDoubleFree', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-cc', 'feat/integ');

    const delPath = path.join(workdir, 'wt-del');
    const deadPath = path.join(workdir, 'wt-dead');
    await addWorktree(repo, delPath, 'del-branch');
    await addWorktree(repo, deadPath, 'dead-branch');

    const manager = new WorktreeManager({
      eventStore: store,
      processSource: ALL_DEAD,
    });
    const delId = await makeReleased(manager, delPath, 'feat-cc');
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

    const executedTrue = eventsOfType(store, 'worktree.remove.executed').filter(
      (e) => (e.data as { removed?: unknown }).removed === true,
    );
    expect(executedTrue).toHaveLength(1);
    expect((executedTrue[0].data as { worktreePath?: unknown }).worktreePath).toBe(
      delPath,
    );
    expect(pruneResult.deleted).toContain(delId);

    const proj = await projection(store);
    expect(proj.worktrees[delId]).toBeUndefined();
    expect(proj.worktrees[deadId].state).toBe('released');
  });

  /**
   * The backing repo is present, but `git status` exits non-zero for the worktree, as with a locked index.
   * Cleanliness is then unknown, so the probe must fail closed as `dirty` and not read as clean.
   */
  it('Prune_DirtyProbeFails_BackingPresent_FailsClosed_NotDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-probe', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-probe');
    const wtId = await addWorktree(repo, wtPath, 'probe-branch');
    const canonicalWt = canonicalWorktreeId(wtPath);

    const statusErrorsRunner: GitRunner = {
      run(args, cwd) {
        if (args[0] === 'status' && canonicalWorktreeId(cwd) === canonicalWt) {
          return { status: 128, stdout: '' };
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

  /**
   * The runner reports the worktree clean on the first `git status` and dirty on each later call.
   * The plan sees it eligible, and the re-verify under the lock sees it dirty and aborts.
   * `entry.state` is still `released`, so a re-check of state alone does not catch the change.
   */
  it('Prune_GoesDirtyBetweenPlanAndCommit_NotDeleted', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-toctou', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-toctou');
    const wtId = await addWorktree(repo, wtPath, 'toctou-branch');
    const canonicalWt = canonicalWorktreeId(wtPath);

    let targetStatusCalls = 0;
    const flipToDirtyRunner: GitRunner = {
      run(args, cwd) {
        const isTargetStatus =
          args[0] === 'status' && canonicalWorktreeId(cwd) === canonicalWt;
        if (isTargetStatus) {
          targetStatusCalls += 1;
          if (targetStatusCalls > 1) {
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

    expect(result.deleted).not.toContain(wtId);
    expect(eventsOfType(store, 'worktree.remove.requested')).toHaveLength(0);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
    expect(targetStatusCalls).toBeGreaterThan(1);
  });

  /**
   * A crashed deletion leaves the worktree registered, so recovery must run `git worktree remove`.
   * No git call in the flow is `git reset --hard`.
   */
  it('Prune_RecoveryPath_NeverUsesResetHard', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'wt-recover');
    await addWorktree(repo, wtPath, 'recover-branch');

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

    const operationId = randomUUID();
    await store.append(
      WORKTREES_STREAM,
      { type: 'worktree.remove.requested', data: { operationId, worktreePath: wtPath } },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    );

    await manager.prune({ repoRoot: repo, apply: true });

    expect(recorded.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(
      true,
    );
    expect(
      recorded.some((a) => a[0] === 'reset' && a.includes('--hard')),
    ).toBe(false);
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  function recordingSleep(): { sleep: SleepFn; delays: number[] } {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };
  }

  const INDEX_LOCK_STDERR =
    "fatal: Unable to create '/repo/.git/index.lock': File exists.\n" +
    'Another git process seems to be running in this repository.';

  /**
   * The manager wraps `git worktree remove` in the index.lock retry kernel.
   * The runner fails the first two remove attempts with status 128 and the git lock message in `INDEX_LOCK_STDERR`.
   * `recordingSleep` records each backoff with no real wait, and zero jitter gives delays of 200 and 400 ms.
   * The third attempt runs real git and removes the worktree.
   */
  it('PruneExecutor_TransientIndexLock_RetriesWithBackoffThenRemoves', async () => {
    const repo = await initRepoWithOrigin(workdir, 'repo');
    await git(repo, ['branch', 'feat/integ']);
    await setIntegrationBranch(store, 'feat-lock', 'feat/integ');
    const wtPath = path.join(workdir, 'wt-lock-retry');
    const wtId = await addWorktree(repo, wtPath, 'lock-retry-branch');

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
      jitter: () => 0,
    });
    const releasedId = await makeReleased(manager, wtPath, 'feat-lock');
    expect(releasedId).toBe(wtId);

    await manager.prune({ repoRoot: repo, apply: true });

    expect(removeAttempts).toBe(3);
    expect(delays).toEqual([200, 400]);
    const executedTrue = eventsOfType(store, 'worktree.remove.executed').filter(
      (e) => (e.data as { removed?: unknown }).removed === true,
    );
    expect(executedTrue).toHaveLength(1);
    expect((await projection(store)).worktrees[wtId]).toBeUndefined();
  });

  /**
   * Each remove attempt fails with the lock message, and `maxIndexLockRetries: 2` allows three attempts.
   * A crashed deletion with the worktree still registered makes recovery run `git worktree remove` outside the ladder.
   * The exhausted retry throws `IndexLockContentionError`. No `executed` event is written, so the entry stays tracked.
   */
  it('PruneExecutor_ExhaustedIndexLockRetry_PropagatesStructuredErrorNoDelete', async () => {
    const repo = await initRepo(path.join(workdir, 'repo'));
    const wtPath = path.join(workdir, 'wt-lock-exhaust');
    const wtId = await addWorktree(repo, wtPath, 'lock-exhaust-branch');

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
      maxIndexLockRetries: 2,
    });
    const releasedId = await makeReleased(manager, wtPath, null);

    const operationId = randomUUID();
    await store.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.remove.requested',
        data: { operationId, worktreePath: wtPath, worktreeId: releasedId },
      },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    );

    await expect(manager.prune({ repoRoot: repo, apply: true })).rejects.toThrow(
      IndexLockContentionError,
    );
    expect(removeAttempts).toBe(3);
    expect(eventsOfType(store, 'worktree.remove.executed')).toHaveLength(0);
    expect((await projection(store)).worktrees[wtId]).toBeDefined();
  });
});
