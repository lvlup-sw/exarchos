// Integration suite for the creation of the launcher top-level worktree. Each test uses a real
// `EventStore` on SQLite and a real git repo, each in its own temp dir. The flow under test is:
// containment guard, `worktree.reserved`, `worktree.create.requested`, `git worktree add`, then
// `worktree.create.executed`. The suite also covers crash recovery and concurrent launches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  WORKTREES_STREAM,
  WORKTREES_REDUCER,
  defaultGitRunner,
  type GitRunner,
} from '../../../../src/verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';
import { canonicalWorktreeId } from '../../../../src/verbs/worktree/pure/path-containment.js';
import { deriveWorktreePath, guardWorktreeContainment } from '../../../../src/runtime/launcher/topology.js';
import {
  createLauncherWorktree,
  recoverPendingCreations,
  CREATE_REQUESTED,
  CREATE_EXECUTED,
  type CreateLauncherWorktreeDeps,
} from '../../../../src/runtime/launcher/create-worktree.js';

/** Runs `git <args>` in `cwd` and returns the trimmed stdout. Throws on failure. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/**
 * Creates a repo on branch `work` with one commit, and returns its canonical path. It uses
 * `realpathSync.native`, as the production `defaultRealpath` does, because that call expands a
 * Windows 8.3 short name. The path that the launcher derives then matches on a Windows runner,
 * where `os.tmpdir()` is a short-name path.
 */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'work']);
  await git(dir, ['config', 'user.email', 'launcher@example.com']);
  await git(dir, ['config', 'user.name', 'Launcher Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher create test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync.native(dir);
}

/** The persisted events of the `worktrees` stream, from the sync read backend. */
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

/** The live fold of the `worktrees` stream through the `worktrees@v1` reducer. */
async function projection(store: EventStore): Promise<WorktreesProjection> {
  const { aggregate } = await store
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

/** Adds the base worktree. The launcher derives each sibling path from it. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  await git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync.native(base);
}

/** A git runner that records each argument vector and then calls real git. */
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

/** An explicit owner identity, so the reserve is deterministic and runs no process probe. */
const OWNER: Pick<CreateLauncherWorktreeDeps, 'selfPid' | 'selfStartedAt'> = {
  selfPid: process.pid,
  selfStartedAt: 'launcher-boot-fingerprint',
};

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

  /**
   * When `git worktree add` runs, the runner counts the persisted `worktree.reserved` events. A
   * count of one or more proves that `worktrees@v1` tracks the worktree before it exists on disk.
   * The reserved event also comes before the intent in the stream, and the fold gives `reserved`.
   */
  it('Create_ReserveBeforeGitAdd_NoUntrackedWindow', async () => {
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
    expect(reservedAtAddTime).toBeGreaterThanOrEqual(1);
    const events = worktreeEvents(store);
    const reservedIdx = events.findIndex((e) => e.type === 'worktree.reserved');
    const requestedIdx = events.findIndex((e) => e.type === CREATE_REQUESTED);
    expect(reservedIdx).toBeGreaterThanOrEqual(0);
    expect(reservedIdx).toBeLessThan(requestedIdx);
    if (result.ok) {
      expect((await projection(store)).worktrees[result.worktreeId].state).toBe('reserved');
    }
  });

  /** The intent comes before the terminal, which records `created: true`. The worktree is on disk. */
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
    expect(requestedIdx).toBeLessThan(executedIdx);
    const executed = eventsOfType(store, CREATE_EXECUTED)[0];
    expect(executed.data?.created).toBe(true);
    if (result.ok) expect(existsSync(result.worktreePath)).toBe(true);
  });

  /** The two events are on the `worktrees` stream, and each carries the returned `operationId`. */
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
    expect(requested[0].streamId).toBe(WORKTREES_STREAM);
    expect(executed[0].streamId).toBe(WORKTREES_STREAM);
    expect(strField(requested[0], 'operationId')).toBe(result.operationId);
    expect(strField(executed[0], 'operationId')).toBe(result.operationId);
    expect(strField(requested[0], 'operationId')).toBe(strField(executed[0], 'operationId'));
  });

  /**
   * Each case appends an intent with no terminal, which is the state after a crash.
   * Case 1: the worktree is on disk, and the runner fails each `worktree add`. Recovery emits a
   * terminal with `created: false`.
   * Case 2: the worktree is absent. Recovery runs the add and emits a terminal with `created: true`.
   * A second recovery pass then finds no pending intent.
   */
  it('Create_CrashBetween_PrecheckResumesOrSkips', async () => {
    const presentDir = path.join(workdir, 'resumed-present');
    await git(repo, ['worktree', 'add', '-q', presentDir, '-b', 'present-branch']);
    const onDiskPath = realpathSync(presentDir);
    const onDiskId = canonicalWorktreeId(onDiskPath);
    const opPresent = '11111111-1111-4111-8111-111111111111';
    await store.append(
      WORKTREES_STREAM,
      { type: CREATE_REQUESTED, data: { operationId: opPresent, worktreePath: onDiskPath, worktreeId: onDiskId } },
      { idempotencyKey: `${CREATE_REQUESTED}:${opPresent}` },
    );

    const noAddRunner: GitRunner = {
      run(args, cwd) {
        if (args[0] === 'worktree' && args[1] === 'add') return { status: 1, stdout: 'add must not run' };
        return defaultGitRunner.run(args, cwd);
      },
    };
    const recoveredPresent = await recoverPendingCreations(store, repo, { gitRunner: noAddRunner });
    expect(recoveredPresent).toHaveLength(1);
    expect(recoveredPresent[0].operationId).toBe(opPresent);
    expect(recoveredPresent[0].created).toBe(false);
    const presentTerminal = eventsOfType(store, CREATE_EXECUTED).filter(
      (e) => strField(e, 'operationId') === opPresent,
    );
    expect(presentTerminal).toHaveLength(1);
    expect(presentTerminal[0].data?.created).toBe(false);

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
    expect(absentRec?.created).toBe(true);
    expect(existsSync(absentPath)).toBe(true);
    const absentTerminal = eventsOfType(store, CREATE_EXECUTED).filter(
      (e) => strField(e, 'operationId') === opAbsent,
    );
    expect(absentTerminal).toHaveLength(1);

    const secondPass = await recoverPendingCreations(store, repo);
    expect(secondPass).toHaveLength(0);
  });

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

  /**
   * The guard override reports the target as nested inside the base. The refusal comes before a
   * `git worktree add`, a reservation or an intent.
   */
  it('Create_NestedTarget_RefusedWithStructuredError', async () => {
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
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false);
    expect(eventsOfType(store, 'worktree.reserved')).toHaveLength(0);
    expect(eventsOfType(store, CREATE_REQUESTED)).toHaveLength(0);
  });

  /**
   * Two concurrent launches for one feature give two distinct worktrees on disk. Each is a direct
   * child of the parent of the base, at its own derived path, and neither is inside the other.
   * The projection tracks the two as `reserved`.
   */
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

    expect(a.worktreeId).not.toBe(b.worktreeId);
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(existsSync(b.worktreePath)).toBe(true);
    const parent = path.posix.dirname(canonicalWorktreeId(base));
    expect(path.posix.dirname(a.worktreeId)).toBe(parent);
    expect(path.posix.dirname(b.worktreeId)).toBe(parent);
    expect(a.worktreeId.startsWith(`${b.worktreeId}/`)).toBe(false);
    expect(b.worktreeId.startsWith(`${a.worktreeId}/`)).toBe(false);
    expect(a.worktreePath).toBe(deriveWorktreePath(base, 'sib-a'));
    expect(b.worktreePath).toBe(deriveWorktreePath(base, 'sib-b'));
    const proj = await projection(store);
    expect(proj.worktrees[a.worktreeId].state).toBe('reserved');
    expect(proj.worktrees[b.worktreeId].state).toBe('reserved');
  });

  /**
   * The injected runner records one `git worktree add`, and the worktree is on disk and registered
   * in git. Each call that the runner records is a `worktree` operation.
   */
  it('Create_AllGitViaManagerRunner', async () => {
    const { runner, calls } = recordingRunner();
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-runner', featureId: null, newBranch: 'launch-runner', repoRoot: repo },
      { gitRunner: runner, ...OWNER },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const addCalls = calls.filter((c) => c[0] === 'worktree' && c[1] === 'add');
    expect(addCalls).toHaveLength(1);
    expect(existsSync(result.worktreePath)).toBe(true);
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    expect(listed).toContain(result.worktreePath);
    for (const c of calls) expect(c[0]).toBe('worktree');
  });

  /**
   * A failed `git worktree add` must return the stderr diagnostic of git, not an empty string. The
   * `work` branch already exists, so `git worktree add -b work` fails in the real runner with
   * "a branch named 'work' already exists". The intent stays open, with no terminal, for a
   * recovery pass.
   */
  it('Create_GitAddFails_SurfacesStderrDiagnostic', async () => {
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-add-fail', featureId: null, newBranch: 'work', repoRoot: repo },
      { ...OWNER },
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'git-add-failed') {
      throw new Error(`expected git-add-failed, got ${JSON.stringify(result)}`);
    }
    expect(result.stderr.trim().length).toBeGreaterThan(0);
    expect(result.stderr).toContain('already exists');
    expect(eventsOfType(store, CREATE_REQUESTED)).toHaveLength(1);
    expect(eventsOfType(store, CREATE_EXECUTED)).toHaveLength(0);
  });

  /** The intent records the `-b` branch, so recovery can replay it. */
  it('Create_IntentPersistsRequestedBranch', async () => {
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-persist-b', featureId: null, newBranch: 'launch-persist', repoRoot: repo },
      { ...OWNER },
    );
    expect(result.ok).toBe(true);
    expect(strField(eventsOfType(store, CREATE_REQUESTED)[0], 'branch')).toBe('launch-persist');
  });

  /**
   * A resume must replay `git worktree add -b <branch>` from the `branch` field of the intent.
   * From the path alone, git derives a branch from the path basename. The branch name here
   * differs from the path basename, so a derived branch fails the last assertion.
   */
  it('Create_CrashResume_ReplaysOriginalBranch', async () => {
    const absentPath = path.join(workdir, 'resumed-with-branch');
    const absentId = canonicalWorktreeId(absentPath);
    const op = '33333333-3333-4333-8333-333333333333';
    const requestedBranch = 'launch-resumed-feature';
    await store.append(
      WORKTREES_STREAM,
      {
        type: CREATE_REQUESTED,
        data: { operationId: op, worktreePath: absentPath, worktreeId: absentId, branch: requestedBranch },
      },
      { idempotencyKey: `${CREATE_REQUESTED}:${op}` },
    );
    expect(existsSync(absentPath)).toBe(false);

    const recovered = await recoverPendingCreations(store, repo);
    expect(recovered.find((r) => r.operationId === op)?.created).toBe(true);
    expect(existsSync(absentPath)).toBe(true);
    expect(await git(absentPath, ['symbolic-ref', '--short', 'HEAD'])).toBe(requestedBranch);
  });

  /** The task-less launcher never emits the task-scoped `worktree.created`. It emits the create pair. */
  it('Create_DoesNotEmitWorktreeCreated', async () => {
    const result = await createLauncherWorktree(
      store,
      { baseWorktree: base, id: 'wt-nocreated', featureId: 'feat-nc', newBranch: 'launch-nc', repoRoot: repo },
      { ...OWNER },
    );
    expect(result.ok).toBe(true);
    expect(eventsOfType(store, 'worktree.created')).toHaveLength(0);
    expect(eventsOfType(store, CREATE_REQUESTED)).toHaveLength(1);
    expect(eventsOfType(store, CREATE_EXECUTED)).toHaveLength(1);
  });
});
