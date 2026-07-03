// ─── Launcher top-level worktree creation — reserve → create.requested →
// git worktree add → create.executed (DR-2 / DR-5)
//
// HIGH-tier integration suite across the git↔event-store seam: every assertion
// drives the REAL EventStore / SQLite substrate AND a REAL git repo (per-test
// tmp dirs), so the ordered creation flow is pinned against actual git
// ground-truth — not a mock.
//
// Contract under test:
//   - `worktree.reserved` is appended BEFORE `git worktree add` (no
//     untracked-on-disk window a concurrent adopt could race).
//   - the INV-13 pair `worktree.create.requested` → `worktree.create.executed`
//     is emitted in order, both on the singleton `worktrees` stream, correlated
//     by `operationId`.
//   - a crash between intent and terminal is recovered by an idempotent
//     precheck (on disk → emit terminal / skip; absent → re-run add).
//   - the DR-5 containment guard is invoked BEFORE the add.
//   - two concurrent same-feature launches create unique siblings (never nested).
//   - all worktree-mutating git routes through the injected git runner.
//   - the flow NEVER emits the task-scoped `worktree.created`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import {
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
  defaultGitRunner,
  type GitRunner,
} from '../orchestrate/worktree/manager.js';
import type { WorktreesProjection } from '../orchestrate/worktree/projections/worktrees.js';
import { canonicalWorktreeId } from '../orchestrate/worktree/pure/path-containment.js';
import { deriveWorktreePath, guardWorktreeContainment } from './topology.js';
import {
  createLauncherWorktree,
  recoverPendingCreations,
  CREATE_REQUESTED,
  CREATE_EXECUTED,
  type CreateLauncherWorktreeDeps,
} from './create-worktree.js';

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
  git(dir, ['config', 'user.email', 'launcher@example.com']);
  git(dir, ['config', 'user.name', 'Launcher Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher create test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
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

/** A base sibling worktree (`git worktree add`) the launcher derives siblings off. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync(base);
}

/** A git runner that records every argument vector, delegating to real git. */
function recordingRunner(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = {
    run(args, cwd) {
      calls.push([...args]);
      return defaultGitRunner.run(args, cwd);
    },
  };
  return { runner, calls };
}

/** Explicit, non-empty owner identity so the reserve is deterministic + probe-free. */
const OWNER: Pick<CreateLauncherWorktreeDeps, 'selfPid' | 'selfStartedAt'> = {
  selfPid: process.pid,
  selfStartedAt: 'launcher-boot-fingerprint',
};

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('createLauncherWorktree (real git + real event store)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'launcher-create-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'launcher-create-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
    repo = await initRepo(path.join(workdir, 'repo'));
    base = await addBaseWorktree(repo, workdir);
  });

  afterEach(async () => {
    store.close();
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  // ─── reserve is appended BEFORE git worktree add ──────────────────────────

  it('Create_ReserveBeforeGitAdd_NoUntrackedWindow', async () => {
    // A runner that, AT the moment `git worktree add` runs, snapshots how many
    // `worktree.reserved` events are already persisted — proving the worktree is
    // tracked in `worktrees@v1` before it exists on disk.
    let reservedAtAddTime = -1;
    const runner: GitRunner = {
      run(args, cwd) {
        if (args[0] === 'worktree' && args[1] === 'add') {
          reservedAtAddTime = eventsOfType(store, 'worktree.reserved').length;
        }
        return defaultGitRunner.run(args, cwd);
      },
    };

    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-early', featureId: 'feat-x', newBranch: 'launch-early', repoRoot: repo },
      { gitRunner: runner, ...OWNER },
    );

    expect(result.ok).toBe(true);
    // The reservation was durable at the instant the add fired — no untracked window.
    expect(reservedAtAddTime).toBeGreaterThanOrEqual(1);
    // And the reserved event stream-precedes any create event.
    const events = worktreeEvents(store);
    const reservedIdx = events.findIndex((e) => e.type === 'worktree.reserved');
    const requestedIdx = events.findIndex((e) => e.type === CREATE_REQUESTED);
    expect(reservedIdx).toBeGreaterThanOrEqual(0);
    expect(reservedIdx).toBeLessThan(requestedIdx);
    // Folds to state `reserved`.
    if (result.ok) {
      expect((await projection(store)).worktrees[result.worktreeId].state).toBe('reserved');
    }
  });

  // ─── intent then terminal, in order ───────────────────────────────────────

  it('Create_RequestedThenCreateExecuted_Terminal', async () => {
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-pair', featureId: null, newBranch: 'launch-pair', repoRoot: repo },
      { ...OWNER },
    );
    expect(result.ok).toBe(true);

    const events = worktreeEvents(store);
    const requestedIdx = events.findIndex((e) => e.type === CREATE_REQUESTED);
    const executedIdx = events.findIndex((e) => e.type === CREATE_EXECUTED);
    expect(requestedIdx).toBeGreaterThanOrEqual(0);
    expect(executedIdx).toBeGreaterThanOrEqual(0);
    // Intent strictly precedes the terminal.
    expect(requestedIdx).toBeLessThan(executedIdx);
    // Terminal records a fresh creation.
    const executed = eventsOfType(store, CREATE_EXECUTED)[0];
    expect(executed.data?.created).toBe(true);
    // The worktree physically exists on disk.
    if (result.ok) expect(existsSync(result.worktreePath)).toBe(true);
  });

  // ─── both create.* on the worktrees stream, correlated by operationId ──────

  it('Create_AppendsPairOnWorktreesStream_CorrelatedByOperationId', async () => {
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-corr', featureId: 'feat-corr', newBranch: 'launch-corr', repoRoot: repo },
      { ...OWNER },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const requested = eventsOfType(store, CREATE_REQUESTED);
    const executed = eventsOfType(store, CREATE_EXECUTED);
    expect(requested).toHaveLength(1);
    expect(executed).toHaveLength(1);
    // Both events live on the singleton `worktrees` stream.
    expect(requested[0].streamId).toBe(WORKTREES_STREAM);
    expect(executed[0].streamId).toBe(WORKTREES_STREAM);
    // Correlated by the SAME operationId, which is the returned correlator.
    expect(strField(requested[0], 'operationId')).toBe(result.operationId);
    expect(strField(executed[0], 'operationId')).toBe(result.operationId);
    expect(strField(requested[0], 'operationId')).toBe(strField(executed[0], 'operationId'));
  });

  // ─── crash between intent and terminal — precheck resumes or skips ─────────

  it('Create_CrashBetween_PrecheckResumesOrSkips', async () => {
    // ── Case 1: worktree ALREADY on disk (crash after add, before terminal). ──
    // Persist a bare `worktree.create.requested` intent for a real, hand-made
    // worktree, with NO terminal — the crash window.
    const presentDir = path.join(workdir, 'resumed-present');
    git(repo, ['worktree', 'add', '-q', presentDir, '-b', 'present-branch']);
    const onDiskPath = realpathSync(presentDir);
    const onDiskId = canonicalWorktreeId(onDiskPath);
    const opPresent = '11111111-1111-4111-8111-111111111111';
    await store.append(
      WORKTREES_STREAM,
      { type: CREATE_REQUESTED, data: { operationId: opPresent, worktreePath: onDiskPath, worktreeId: onDiskId } },
      { idempotencyKey: `${CREATE_REQUESTED}:${opPresent}` },
    );

    // A runner whose `worktree add` FAILS — so if resume tried to add, we'd see it.
    const noAddRunner: GitRunner = {
      run(args, cwd) {
        if (args[0] === 'worktree' && args[1] === 'add') return { status: 1, stdout: 'add must not run' };
        return defaultGitRunner.run(args, cwd);
      },
    };
    const recoveredPresent = await recoverPendingCreations(store, repo, { gitRunner: noAddRunner });
    expect(recoveredPresent).toHaveLength(1);
    expect(recoveredPresent[0].operationId).toBe(opPresent);
    // Precheck SKIPPED the add (worktree already on disk) → created: false.
    expect(recoveredPresent[0].created).toBe(false);
    const presentTerminal = eventsOfType(store, CREATE_EXECUTED).filter(
      (e) => strField(e, 'operationId') === opPresent,
    );
    expect(presentTerminal).toHaveLength(1);
    expect(presentTerminal[0].data?.created).toBe(false);

    // ── Case 2: worktree ABSENT (crash before add) — resume RE-RUNS the add. ──
    const absentPath = path.join(workdir, 'resumed-absent');
    const absentId = canonicalWorktreeId(absentPath);
    const opAbsent = '22222222-2222-4222-8222-222222222222';
    await store.append(
      WORKTREES_STREAM,
      { type: CREATE_REQUESTED, data: { operationId: opAbsent, worktreePath: absentPath, worktreeId: absentId } },
      { idempotencyKey: `${CREATE_REQUESTED}:${opAbsent}` },
    );
    expect(existsSync(absentPath)).toBe(false);

    const recoveredAbsent = await recoverPendingCreations(store, repo);
    const absentRec = recoveredAbsent.find((r) => r.operationId === opAbsent);
    expect(absentRec).toBeDefined();
    // Precheck re-ran the add → created: true, and the worktree now exists.
    expect(absentRec?.created).toBe(true);
    expect(existsSync(absentPath)).toBe(true);
    const absentTerminal = eventsOfType(store, CREATE_EXECUTED).filter(
      (e) => strField(e, 'operationId') === opAbsent,
    );
    expect(absentTerminal).toHaveLength(1);

    // Idempotent: a second recovery pass finds nothing pending (both paired).
    const secondPass = await recoverPendingCreations(store, repo);
    expect(secondPass).toHaveLength(0);
  });

  // ─── the DR-5 guard is invoked BEFORE git worktree add ────────────────────

  it('Create_CallsGuardBeforeAdd', async () => {
    const order: string[] = [];
    const spyGuard = (
      b: string,
      t: string,
      rp?: Parameters<typeof guardWorktreeContainment>[2],
    ): ReturnType<typeof guardWorktreeContainment> => {
      order.push('guard');
      return guardWorktreeContainment(b, t, rp);
    };
    const orderedRunner: GitRunner = {
      run(args, cwd) {
        if (args[0] === 'worktree' && args[1] === 'add') order.push('git-add');
        return defaultGitRunner.run(args, cwd);
      },
    };

    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-guard', featureId: null, newBranch: 'launch-guard', repoRoot: repo },
      { guard: spyGuard, gitRunner: orderedRunner, ...OWNER },
    );
    expect(result.ok).toBe(true);
    const guardIdx = order.indexOf('guard');
    const addIdx = order.indexOf('git-add');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(addIdx);
  });

  // ─── a nested target is refused with a structured error ───────────────────

  it('Create_NestedTarget_RefusedWithStructuredError', async () => {
    // A guard override that reports the derived target as nested-inside-base.
    const refusingGuard: typeof guardWorktreeContainment = (b, t) => ({
      ok: false,
      reason: 'nested-inside-base',
      base: b,
      target: t,
      message: 'nested',
    });
    const { runner, calls } = recordingRunner();
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-nested', featureId: null, newBranch: 'launch-nested', repoRoot: repo },
      { guard: refusingGuard, gitRunner: runner, ...OWNER },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'containment-refused') {
      expect(result.refusal.reason).toBe('nested-inside-base');
    } else {
      throw new Error('expected containment-refused');
    }
    // Refused BEFORE any git ran and BEFORE any reservation was recorded.
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false);
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(0);
    expect(eventsOfType(store, CREATE_REQUESTED)).toHaveLength(0);
  });

  // ─── two concurrent same-feature launches create siblings, not nesting ────

  it('Create_ConcurrentSameFeature_Siblings', async () => {
    const [a, b] = await Promise.all([
      createLauncherWorktree(
        store,
        { baseWorktree: base, id: 'sib-a', featureId: 'feat-shared', newBranch: 'launch-sib-a', repoRoot: repo },
        { ...OWNER },
      ),
      createLauncherWorktree(
        store,
        { baseWorktree: base, id: 'sib-b', featureId: 'feat-shared', newBranch: 'launch-sib-b', repoRoot: repo },
        { ...OWNER },
      ),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Distinct worktrees...
    expect(a.worktreeId).not.toBe(b.worktreeId);
    // ...both physically present...
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(existsSync(b.worktreePath)).toBe(true);
    // ...as one-level-deep SIBLINGS under the base's parent (DR-5 topology)...
    const parent = path.posix.dirname(canonicalWorktreeId(base));
    expect(path.posix.dirname(a.worktreeId)).toBe(parent);
    expect(path.posix.dirname(b.worktreeId)).toBe(parent);
    // ...and NEITHER nested inside the other (the collision the topology forbids).
    expect(a.worktreeId.startsWith(`${b.worktreeId}/`)).toBe(false);
    expect(b.worktreeId.startsWith(`${a.worktreeId}/`)).toBe(false);
    // Each derived independently to its own sibling path.
    expect(a.worktreePath).toBe(deriveWorktreePath(base, 'sib-a'));
    expect(b.worktreePath).toBe(deriveWorktreePath(base, 'sib-b'));
    // Both tracked as reserved in the projection.
    const proj = await projection(store);
    expect(proj.worktrees[a.worktreeId].state).toBe('reserved');
    expect(proj.worktrees[b.worktreeId].state).toBe('reserved');
  });

  // ─── all worktree-mutating git routes through the injected runner ─────────

  it('Create_AllGitViaManagerRunner', async () => {
    const { runner, calls } = recordingRunner();
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-runner', featureId: null, newBranch: 'launch-runner', repoRoot: repo },
      { gitRunner: runner, ...OWNER },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The mutating `git worktree add` routed through the injected runner...
    const addCalls = calls.filter((c) => c[0] === 'worktree' && c[1] === 'add');
    expect(addCalls).toHaveLength(1);
    // ...and the created worktree exists ONLY because the runner performed it
    // (no scattered execFile bypass) — the worktree is on disk + git-registered.
    expect(existsSync(result.worktreePath)).toBe(true);
    const listed = git(repo, ['worktree', 'list', '--porcelain']);
    expect(listed).toContain(result.worktreePath);
    // Every recorded git op is a worktree op — nothing else shelled out of band.
    for (const c of calls) expect(c[0]).toBe('worktree');
  });

  // ─── the flow never emits the task-scoped worktree.created ────────────────

  it('Create_DoesNotEmitWorktreeCreated', async () => {
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-nocreated', featureId: 'feat-nc', newBranch: 'launch-nc', repoRoot: repo },
      { ...OWNER },
    );
    expect(result.ok).toBe(true);
    // The task-scoped delegation terminal is NEVER used by the task-less launcher.
    expect(eventsOfType(store, 'worktree.created')).toHaveLength(0);
    // The launcher uses the create.* pair instead.
    expect(eventsOfType(store, CREATE_REQUESTED)).toHaveLength(1);
    expect(eventsOfType(store, CREATE_EXECUTED)).toHaveLength(1);
  });
});
