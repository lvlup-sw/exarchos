/**
 * Tests for `VcsMutationOwner`, the one typed surface for git and worktree mutation.
 * The scenarios use a real `EventStore` and a real git repository in temporary directories.
 * Thus they check idempotency, fencing, convergence and dry-run against real branches and worktrees.
 * The fencing predicate and the ledger fold also have direct unit tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { capabilitiesForPosture } from '../../../src/workflow/capabilities/posture-mapping.js';
import type { Capability } from '../../../src/runtime/agents/capabilities.js';
import {
  DRY_RUN,
  emissionsWhen,
  isDryRun,
  isError,
  isSuccess,
} from '../../../src/dispatch/core/effect-carrier.js';
import {
  VcsMutationOwner,
  VcsStaleEpochError,
  assertVcsEpochCurrent,
  foldVcsLedger,
  defaultVcsGitRunner,
  worktreeRemoveForceArgs,
  branchDeleteForceArgs,
  removeWorktreeForce,
  deleteBranchForce,
  VCS_MUTATION_STREAM,
  VCS_REQUESTED,
  VCS_EXECUTED,
  VCS_COMPENSATED,
  VCS_LEDGER_EMISSIONS,
  type VcsGitOutput,
  type VcsGitRunner,
} from '../../../src/vcs/mutation-owner.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/** Initializes a real repository on branch `main` with one commit, and returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'vcs@example.com']);
  await git(dir, ['config', 'user.name', 'VCS Owner Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return realpathSync(dir);
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Count on-disk worktrees EXCLUDING the main checkout. */
async function extraWorktreeCount(repoRoot: string): Promise<number> {
  const all = (await git(repoRoot, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
  return all - 1;
}

/** A git runner that delegates to real git while recording every argv. */
function recordingRunner(): { runner: VcsGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: VcsGitRunner = {
    run(args: readonly string[], cwd: string): VcsGitOutput {
      calls.push([...args]);
      return defaultVcsGitRunner.run(args, cwd);
    },
  };
  return { runner, calls };
}

/** A git runner that never runs git — asserts the mutation surface was untouched. */
function neverRunner(): { runner: VcsGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: VcsGitRunner = {
    run(args: readonly string[]): VcsGitOutput {
      calls.push([...args]);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

const SHARED_MUTATING: ReadonlySet<Capability> = capabilitiesForPosture('shared-mutating');

describe('VCS mutation owner (P04-05)', () => {
  let root: string;
  let repo: string;
  let store: EventStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vcs-owner-'));
    repo = await initRepo(await mkdtemp(path.join(tmpdir(), 'vcs-repo-')));
    store = new EventStore(path.join(root, 'events'));
    await store.initialize();
  });

  /**
   * `git worktree prune` drops the git records of worktrees whose directory is gone, before the hook removes the temporary directories.
   * The call is best effort, so the hook ignores its failure.
   */
  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    try {
      await git(repo, ['worktree', 'prune']);
    } catch {
    }
    await rmrfAsync(root);
    await rmrfAsync(repo);
  });

  function owner(runner?: VcsGitRunner): VcsMutationOwner {
    return new VcsMutationOwner({
      eventStore: store,
      ...(runner !== undefined ? { gitRunner: runner } : {}),
    });
  }

  async function ledgerEvents(): Promise<WorkflowEvent[]> {
    return store.query(VCS_MUTATION_STREAM);
  }

  describe('assertVcsEpochCurrent', () => {
    it('rejects a writer below the current epoch, allows equal / greater', () => {
      expect(() => assertVcsEpochCurrent(5, 4, 'k')).toThrow(VcsStaleEpochError);
      expect(() => assertVcsEpochCurrent(5, 5, 'k')).not.toThrow();
      expect(() => assertVcsEpochCurrent(5, 6, 'k')).not.toThrow();
    });

    it('carries the fencing token detail on the error', () => {
      try {
        assertVcsEpochCurrent(9, 2, 'op-42');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(VcsStaleEpochError);
        const e = err as VcsStaleEpochError;
        expect(e.code).toBe('VCS_STALE_EPOCH');
        expect(e.writerEpoch).toBe(2);
        expect(e.currentEpoch).toBe(9);
        expect(e.idempotencyKey).toBe('op-42');
      }
    });
  });

  /**
   * The owner takes no capability input, so it cannot infer dry-run from the capabilities of the caller.
   * A caller gets dry-run only through an explicit `mode: DRY_RUN`. Thus no test here varies capabilities.
   */
  describe('mode is requested, never inferred', () => {
    /** The branch on disk is the proof. A success outcome alone does not show that the mutation ran. */
    it('VcsMutationOwner_NoModeRequested_MutatesLive', async () => {
      const outcome = await owner().createBranch({
        repoRoot: repo,
        branch: 'feature/live-default',
        base: 'main',
        idempotencyKey: 'live-default-1',
        epoch: 1,
      });

      expect(isSuccess(outcome)).toBe(true);
      expect(await branchExists(repo, 'feature/live-default')).toBe(true);
    });

    it('VcsMutationOwner_ExplicitDryRun_IsStillHonoured', async () => {
      const { runner, calls } = neverRunner();
      const outcome = await owner(runner).createBranch({
        repoRoot: repo,
        branch: 'feature/explicit-dry',
        base: 'main',
        idempotencyKey: 'explicit-dry-1',
        epoch: 1,
        mode: DRY_RUN,
      });

      expect(isDryRun(outcome)).toBe(true);
      expect(calls).toEqual([]);
      expect(await branchExists(repo, 'feature/explicit-dry')).toBe(false);
    });
  });

  describe('foldVcsLedger', () => {
    /** Key `b` has an intent and no terminal, which is the state that an interrupted run leaves. */
    it('computes the max epoch, the terminal cache, and open intents', () => {
      const events = [
        { type: VCS_REQUESTED, data: { idempotencyKey: 'a', epoch: 1 } },
        { type: VCS_EXECUTED, data: { idempotencyKey: 'a', epoch: 1, result: { branch: 'x' } } },
        { type: VCS_REQUESTED, data: { idempotencyKey: 'b', epoch: 3 } },
      ] as unknown as WorkflowEvent[];
      const fold = foldVcsLedger(events);
      expect(fold.currentEpoch).toBe(3);
      expect(fold.terminals.get('a')?.kind).toBe('executed');
      expect(fold.terminals.get('a')?.result).toEqual({ branch: 'x' });
      expect(fold.intents.has('b')).toBe(true);
      expect(fold.terminals.has('b')).toBe(false);
    });
  });

  /**
   * The second request has the same key, so it must replay with no mutating git call.
   * The replay can run one read-only probe through `verifyReplay`, so the test filters out the read-only subcommands.
   */
  it('(b) duplicate branch-create requests create exactly ONE branch and replay the outcome', async () => {
    const { runner, calls } = recordingRunner();
    const o = owner(runner);
    const req = {
      repoRoot: repo,
      branch: 'feature/dup',
      base: 'main',
      idempotencyKey: 'branch-dup-1',
      epoch: 1,
    };

    const first = await o.createBranch(req);
    expect(isSuccess(first)).toBe(true);
    if (isSuccess(first)) expect(first.value.created).toBe(true);
    expect(await branchExists(repo, 'feature/dup')).toBe(true);

    calls.length = 0;
    const second = await o.createBranch(req);
    expect(isSuccess(second)).toBe(true);
    if (isSuccess(second)) expect(second.value.branch).toBe('feature/dup');
    const mutating = calls.filter(
      (argv) => !['show-ref', 'rev-parse'].includes(argv[0] ?? ''),
    );
    expect(mutating).toEqual([]);

    const terminals = (await ledgerEvents()).filter((e) => e.type === VCS_EXECUTED);
    expect(terminals).toHaveLength(1);
    const branches = (await git(repo, ['branch', '--list', 'feature/dup']))
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(branches).toHaveLength(1);
  });

  it('(c) duplicate worktree-create requests create exactly ONE worktree', async () => {
    const o = owner();
    const wtPath = path.join(repo, 'wt', 'dup');
    const req = {
      repoRoot: repo,
      worktreePath: wtPath,
      branch: 'feature/wt-dup',
      base: 'main',
      idempotencyKey: 'wt-dup-1',
      epoch: 1,
    };

    const first = await o.createWorktree(req);
    expect(isSuccess(first)).toBe(true);
    if (isSuccess(first)) {
      expect(first.value.createdWorktree).toBe(true);
      expect(first.value.createdBranch).toBe(true);
    }
    expect(existsSync(wtPath)).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);

    const second = await o.createWorktree(req);
    expect(isSuccess(second)).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);
  });

  /**
   * The remove uses a different key, so its terminal does not clear the create terminal in the ledger.
   * The second create has the same key and the same path. The `verifyReplay` probe finds no worktree there.
   * Thus the owner must create the worktree again, and must not replay the stale `executed` terminal.
   */
  it('(c2) createWorktree after a real remove RE-CREATES instead of replaying the stale terminal', async () => {
    const o = owner();
    const wtPath = path.join(repo, 'wt', 'lifecycle');
    const req = {
      repoRoot: repo,
      worktreePath: wtPath,
      branch: 'feature/wt-lifecycle',
      base: 'main',
      idempotencyKey: `worktree-setup:${wtPath}`,
      epoch: 1,
    };

    const first = await o.createWorktree(req);
    expect(isSuccess(first)).toBe(true);
    expect(existsSync(wtPath)).toBe(true);

    const removed = await o.removeWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      idempotencyKey: `worktree-remove:${wtPath}`,
      epoch: 1,
    });
    expect(isSuccess(removed)).toBe(true);
    expect(existsSync(wtPath)).toBe(false);

    const recreate = await o.createWorktree(req);
    expect(isSuccess(recreate)).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);
  });

  /** After the recreate, the recorded remove terminal does not match the disk, so the second remove with the same key must run again. */
  it('(c3) removeWorktree after a recreate re-runs the remove instead of replaying', async () => {
    const o = owner();
    const wtPath = path.join(repo, 'wt', 'lifecycle3');
    const create = {
      repoRoot: repo,
      worktreePath: wtPath,
      branch: 'feature/wt-lifecycle3',
      base: 'main',
      idempotencyKey: `worktree-setup:${wtPath}`,
      epoch: 1,
    };
    const remove = {
      repoRoot: repo,
      worktreePath: wtPath,
      idempotencyKey: `worktree-remove:${wtPath}`,
      epoch: 1,
    };

    expect(isSuccess(await o.createWorktree(create))).toBe(true);
    expect(isSuccess(await o.removeWorktree(remove))).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    expect(isSuccess(await o.createWorktree(create))).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
    const removedAgain = await o.removeWorktree(remove);
    expect(isSuccess(removedAgain)).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
  });

  /**
   * The provider effect runs one time across the two requests, and the second request replays the recorded outcome.
   * The first run ran the effect, so it carries `recorded` evidence.
   * The second run ran no effect, so it carries `replayed` evidence that names the `VCS_EXECUTED` terminal of this key.
   */
  it('(d) duplicate provider mutation (PR/merge) runs the effect exactly ONCE', async () => {
    const o = owner();
    let prCalls = 0;
    const effect = async (): Promise<{ prNumber: number; url: string }> => {
      prCalls += 1;
      return { prNumber: 7, url: 'https://example/pr/7' };
    };
    const input = {
      kind: 'pr.create',
      description: 'open PR for feature/x',
      idempotencyKey: 'pr-key-1',
      epoch: 1,
    };

    const first = await o.runProviderMutation(input, effect);
    const second = await o.runProviderMutation(input, effect);

    expect(prCalls).toBe(1);
    expect(isSuccess(first)).toBe(true);
    expect(isSuccess(second)).toBe(true);
    if (isSuccess(first) && isSuccess(second)) {
      expect(second.value).toEqual(first.value);

      expect(first.evidence.kind).toBe('recorded');
      expect(second.evidence.kind).toBe('replayed');
      if (second.evidence.kind === 'replayed') {
        expect(second.evidence.event).toBe(VCS_EXECUTED);
        expect(second.evidence.source).toContain(input.idempotencyKey);
      }
    }
  });

  /**
   * The append of the success terminal throws, which simulates a crash after the git effect and before the terminal.
   * The worktree is on disk and the intent is durable, so a reconciler can find the interrupted request.
   * The retry with the same key finds the worktree and the branch, creates nothing, and records the terminal.
   */
  it('(e) an interrupted worktree-create leaves an intent (not an event-less orphan) and converges on retry', async () => {
    const o = owner();
    const wtPath = path.join(repo, 'wt', 'interrupt');
    const req = {
      repoRoot: repo,
      worktreePath: wtPath,
      branch: 'feature/interrupt',
      base: 'main',
      idempotencyKey: 'wt-interrupt-1',
      epoch: 1,
    };

    const originalAppend = store.append.bind(store);
    const appendSpy = vi
      .spyOn(store, 'append')
      .mockImplementation(async (streamId: string, event, opts) => {
        if (event.type === VCS_EXECUTED) {
          throw new Error('simulated crash before terminal');
        }
        return originalAppend(streamId, event, opts);
      });

    const interrupted = await o.createWorktree(req);
    expect(isError(interrupted)).toBe(true);
    if (isError(interrupted)) expect(interrupted.error.code).toBe('VCS_TERMINAL_APPEND_FAILED');

    expect(existsSync(wtPath)).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);
    const openBefore = await o.openIntents();
    expect(openBefore).toContain('wt-interrupt-1');
    expect((await ledgerEvents()).some((e) => e.type === VCS_EXECUTED)).toBe(false);

    appendSpy.mockRestore();
    const retried = await o.createWorktree(req);
    expect(isSuccess(retried)).toBe(true);
    if (isSuccess(retried)) {
      expect(retried.value.createdWorktree).toBe(false);
      expect(retried.value.createdBranch).toBe(false);
    }
    expect(await extraWorktreeCount(repo)).toBe(1);
    expect(await o.openIntents()).not.toContain('wt-interrupt-1');
    expect((await ledgerEvents()).some((e) => e.type === VCS_EXECUTED)).toBe(true);
  });

  /**
   * The runner fails `worktree add` and sends each other command to real git.
   * The owner must delete the branch that it created, and must record a compensated terminal that closes the key.
   */
  it('compensates the minted branch when worktree add fails (no orphaned on-disk state)', async () => {
    const inner = recordingRunner();
    const failingAdd: VcsGitRunner = {
      run(args, cwd) {
        if (args[0] === 'worktree' && args[1] === 'add') {
          return { status: 1, stdout: '', stderr: 'simulated worktree add failure' };
        }
        return inner.runner.run(args, cwd);
      },
    };
    const o = owner(failingAdd);
    const result = await o.createWorktree({
      repoRoot: repo,
      worktreePath: path.join(repo, 'wt', 'fail'),
      branch: 'feature/should-be-compensated',
      base: 'main',
      idempotencyKey: 'wt-fail-1',
      epoch: 1,
    });

    expect(isError(result)).toBe(true);
    expect(await branchExists(repo, 'feature/should-be-compensated')).toBe(false);
    expect(await o.openIntents()).not.toContain('wt-fail-1');
  });

  /**
   * Each arm has its own ledger stream, so each assertion compares the whole stream as an ordered array.
   * The success effect and the failure effect each read the stream while they run.
   * That snapshot must hold the intent and no terminal, because the owner appends the intent before the effect.
   * A failed run records the compensated terminal and no other terminal.
   *
   * The dry-run arm returns the declared plan and appends nothing.
   * The emissions of the plan must name the events that the two observed ledgers hold.
   */
  it('MutationOwner_IntentThenTerminalOrdering_IsPreserved', async () => {
    function ownerOn(stream: string): VcsMutationOwner {
      return new VcsMutationOwner({ eventStore: store, stream, gitRunner: neverRunner().runner });
    }
    const typesOn = async (stream: string): Promise<string[]> =>
      (await store.query(stream)).map((e) => e.type);

    const successStream = 'ordering-success';
    let duringSuccess: string[] = [];
    const succeeded = await ownerOn(successStream).mutate<{ probe: string }>(
      {
        kind: 'branch.create',
        idempotencyKey: 'ordering-1',
        epoch: 1,
        description: 'ordering probe that succeeds',
      },
      async () => {
        duringSuccess = await typesOn(successStream);
        return { probe: 'ok' };
      },
    );

    expect(isSuccess(succeeded)).toBe(true);
    expect(duringSuccess).toEqual([VCS_REQUESTED]);
    expect(await typesOn(successStream)).toEqual([VCS_REQUESTED, VCS_EXECUTED]);

    const failureStream = 'ordering-failure';
    let duringFailure: string[] = [];
    const compensated = await ownerOn(failureStream).mutate<{ probe: string }>(
      {
        kind: 'branch.create',
        idempotencyKey: 'ordering-2',
        epoch: 1,
        description: 'ordering probe that fails',
      },
      async (): Promise<{ probe: string }> => {
        duringFailure = await typesOn(failureStream);
        throw new Error('the effect refused');
      },
    );

    expect(isError(compensated)).toBe(true);
    expect(duringFailure).toEqual([VCS_REQUESTED]);
    expect(await typesOn(failureStream)).toEqual([VCS_REQUESTED, VCS_COMPENSATED]);

    const withheld = await ownerOn('ordering-plan').mutate<{ probe: string }>(
      {
        kind: 'branch.create',
        idempotencyKey: 'ordering-3',
        epoch: 1,
        description: 'ordering probe that is withheld',
        mode: DRY_RUN,
      },
      () => Promise.resolve({ probe: 'never' }),
    );
    expect(isDryRun(withheld)).toBe(true);
    if (isDryRun(withheld)) {
      const names = (when: 'before' | 'on-success' | 'on-failure'): string[] =>
        emissionsWhen(withheld.plan, when).map((emission) => emission.event);
      expect(names('before')).toEqual([VCS_REQUESTED]);
      expect(names('on-success')).toEqual([VCS_EXECUTED]);
      expect(names('on-failure')).toEqual([VCS_COMPENSATED]);
      expect(withheld.plan.emits).toEqual(VCS_LEDGER_EMISSIONS);
    }
    expect(await typesOn('ordering-plan')).toEqual([]);
  });

  /** An owner at epoch 2 writes to the ledger first. The request at epoch 1 is then stale, and its branch must not exist. */
  it('(f) a fenced-out stale owner (lower epoch) is rejected and performs NO mutation', async () => {
    const o = owner();

    const takeover = await o.createBranch({
      repoRoot: repo,
      branch: 'feature/owner-2',
      base: 'main',
      idempotencyKey: 'owner2-branch',
      epoch: 2,
    });
    expect(isSuccess(takeover)).toBe(true);

    const stale = await o.createBranch({
      repoRoot: repo,
      branch: 'feature/owner-1-stale',
      base: 'main',
      idempotencyKey: 'owner1-branch',
      epoch: 1,
    });
    expect(isError(stale)).toBe(true);
    if (isError(stale)) expect(stale.error.code).toBe('VCS_STALE_EPOCH');
    expect(await branchExists(repo, 'feature/owner-1-stale')).toBe(false);
  });

  it('(g) an explicit dry-run creates NO branch, touches NO git, and appends NO event', async () => {
    const { runner, calls } = neverRunner();
    const o = owner(runner);
    const outcome = await o.createBranch({
      repoRoot: repo,
      branch: 'feature/never',
      base: 'main',
      idempotencyKey: 'dry-1',
      epoch: 1,
      mode: DRY_RUN,
    });

    expect(isDryRun(outcome)).toBe(true);
    if (isDryRun(outcome)) {
      expect(outcome.plan.effectClass).toBe('vcs');
      expect(outcome.plan.idempotent).toBe(true);
    }
    expect(calls).toEqual([]);
    expect(await branchExists(repo, 'feature/never')).toBe(false);
    expect(await ledgerEvents()).toEqual([]);
  });
});

/**
 * The owner module holds the argument vectors for a forced worktree removal and a forced branch deletion.
 * `verbs/worktree/manager.ts` and `verbs/merge/local-git-merge.ts` have their own idempotency.
 * They pass their own git transport to these helpers, so they open no second ledger.
 */
describe('shared git-mutation primitives (P04-05)', () => {
  it('worktreeRemoveForceArgs builds the canonical forced-remove argv', () => {
    expect(worktreeRemoveForceArgs('/repo/.worktrees/task-x')).toEqual([
      'worktree',
      'remove',
      '--force',
      '/repo/.worktrees/task-x',
    ]);
  });

  it('branchDeleteForceArgs builds the canonical forced-delete argv', () => {
    expect(branchDeleteForceArgs('feature/x')).toEqual(['branch', '-D', 'feature/x']);
  });

  it('removeWorktreeForce runs the forced-remove argv through the caller transport and returns its result', () => {
    const seen: (readonly string[])[] = [];
    const result = removeWorktreeForce((argv) => {
      seen.push(argv);
      return 'removed';
    }, '/repo/.worktrees/task-y');
    expect(seen).toEqual([['worktree', 'remove', '--force', '/repo/.worktrees/task-y']]);
    expect(result).toBe('removed');
  });

  it('deleteBranchForce runs the forced-delete argv through the caller transport and returns its result', () => {
    const seen: (readonly string[])[] = [];
    const result = deleteBranchForce((argv) => {
      seen.push(argv);
      return 42;
    }, 'feature/y');
    expect(seen).toEqual([['branch', '-D', 'feature/y']]);
    expect(result).toBe(42);
  });
});
