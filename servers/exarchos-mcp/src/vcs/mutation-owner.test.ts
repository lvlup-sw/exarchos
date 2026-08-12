// ─── VCS mutation owner — the single typed git/worktree mutation surface
// (P04-05, EFF-010 / EFF-011) ───────────────────────────────────────────────
//
// HIGH-tier integration suite across the git ↔ event-store seam: the exit-proof
// scenarios drive the REAL EventStore / SQLite substrate AND a REAL git repo
// (per-test tmp dirs), so idempotency / fencing / convergence / dry-run are
// pinned against actual on-disk branches + worktrees — not mocks. Pure helpers
// (fencing predicate, capability gate, ledger fold) are unit-tested alongside.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { capabilitiesForPosture } from '../capabilities/posture-mapping.js';
import type { Capability } from '../agents/capabilities.js';
import { DRY_RUN, isDryRun, isError, isSuccess } from '../dispatch/core/effect-carrier.js';
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
  type VcsGitOutput,
  type VcsGitRunner,
} from './mutation-owner.js';
import type { WorkflowEvent } from '../events/schemas.js';

// ─── git + event-store helpers ──────────────────────────────────────────────

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Init a real repo on branch `main` with one commit; returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'vcs@example.com']);
  git(dir, ['config', 'user.name', 'VCS Owner Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return realpathSync(dir);
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Count on-disk worktrees EXCLUDING the main checkout. */
function extraWorktreeCount(repoRoot: string): number {
  const all = git(repoRoot, ['worktree', 'list', '--porcelain'])
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

// ─── suite ──────────────────────────────────────────────────────────────────

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

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    // Detach any worktrees git still tracks before the tmp dir is removed.
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      /* best effort */
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

  // ── pure fencing predicate ─────────────────────────────────────────────────

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

  // `canMutateShared` used to pick live-vs-dry-run from the caller's
  // capabilities, and a caller that flunked got a dry-run plus a
  // successful-looking result for a mutation that never ran. Removed under
  // INV-11 (see `capabilities/shared-mutating-gate.test.ts`). The owner no
  // longer takes capabilities at all, so that inference is now unwritable
  // rather than merely unwritten — which is why there is no test here asserting
  // "capabilities don't affect mode". There is no such input to vary.

  describe('mode is requested, never inferred', () => {
    it('VcsMutationOwner_NoModeRequested_MutatesLive', async () => {
      const outcome = await owner().createBranch({
        repoRoot: repo,
        branch: 'feature/live-default',
        base: 'main',
        idempotencyKey: 'live-default-1',
        epoch: 1,
      });

      // The on-disk branch is the assertion that matters: the old failure was a
      // plausible outcome for work that never happened.
      expect(isSuccess(outcome)).toBe(true);
      expect(branchExists(repo, 'feature/live-default')).toBe(true);
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

      // Dry-run did not disappear; it stopped being chosen for you.
      expect(isDryRun(outcome)).toBe(true);
      expect(calls).toEqual([]);
      expect(branchExists(repo, 'feature/explicit-dry')).toBe(false);
    });
  });

  // ── ledger fold ────────────────────────────────────────────────────────────

  describe('foldVcsLedger', () => {
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
      // `b` has an intent but no terminal — the interrupted-run cohort.
      expect(fold.intents.has('b')).toBe(true);
      expect(fold.terminals.has('b')).toBe(false);
    });
  });

  // ── (b) duplicate branch-create → ONE branch ───────────────────────────────

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
    expect(branchExists(repo, 'feature/dup')).toBe(true);

    // Second request, SAME key: must replay WITHOUT any MUTATING git call.
    // The replay path is allowed exactly one READ-ONLY reality probe
    // (`show-ref`) — see `VcsMutationRequest.verifyReplay` — so filter to
    // effectful subcommands rather than demanding zero traffic.
    calls.length = 0;
    const second = await o.createBranch(req);
    expect(isSuccess(second)).toBe(true);
    if (isSuccess(second)) expect(second.value.branch).toBe('feature/dup');
    const mutating = calls.filter(
      (argv) => !['show-ref', 'rev-parse'].includes(argv[0] ?? ''),
    );
    expect(mutating).toEqual([]); // replay short-circuits before any git EFFECT

    // Exactly one branch, exactly one terminal.
    const terminals = (await ledgerEvents()).filter((e) => e.type === VCS_EXECUTED);
    expect(terminals).toHaveLength(1);
    const branches = git(repo, ['branch', '--list', 'feature/dup'])
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(branches).toHaveLength(1);
  });

  // ── (c) duplicate worktree-add → ONE worktree ──────────────────────────────

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
    expect(extraWorktreeCount(repo)).toBe(1);

    const second = await o.createWorktree(req);
    expect(isSuccess(second)).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1); // still exactly one
  });

  // ── (c2) remove-then-recreate at the SAME path re-runs the effect ──────────

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

    // Routine wave lifecycle: the worktree is removed (different key — the
    // remove terminal does NOT clear the create terminal in the ledger).
    const removed = await o.removeWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      idempotencyKey: `worktree-remove:${wtPath}`,
      epoch: 1,
    });
    expect(isSuccess(removed)).toBe(true);
    expect(existsSync(wtPath)).toBe(false);

    // Re-request at the SAME deterministic path with the SAME key. Before the
    // verifyReplay probe this replayed the stale `executed` terminal: success
    // reported, no worktree on disk, forever. It must now actually create.
    const recreate = await o.createWorktree(req);
    expect(isSuccess(recreate)).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1);
  });

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
    // Recreate (via c2's probe), then remove AGAIN with the original key:
    // the recorded remove terminal no longer matches reality and must re-run.
    expect(isSuccess(await o.createWorktree(create))).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
    const removedAgain = await o.removeWorktree(remove);
    expect(isSuccess(removedAgain)).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
  });

  // ── (d) duplicate provider PR/merge → ONE effect ───────────────────────────

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

    expect(prCalls).toBe(1); // the provider effect ran once across duplicates
    expect(isSuccess(first)).toBe(true);
    expect(isSuccess(second)).toBe(true);
    if (isSuccess(first) && isSuccess(second)) {
      expect(second.value).toEqual(first.value); // replayed the recorded outcome
    }
  });

  // ── (e) interrupted worktree-create converges on retry, no orphan ──────────

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

    // Simulate a crash AFTER the git effect but BEFORE the success terminal by
    // making the terminal append throw exactly once.
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

    // The on-disk worktree exists, but it is NOT an event-less orphan: the
    // durable INTENT is recorded, so a reconciler can find + converge it.
    expect(existsSync(wtPath)).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1);
    const openBefore = await o.openIntents();
    expect(openBefore).toContain('wt-interrupt-1');
    expect((await ledgerEvents()).some((e) => e.type === VCS_EXECUTED)).toBe(false);

    // Retry with the SAME key after recovery: the effect no-ops (worktree +
    // branch already exist), the terminal lands, and there is still ONE worktree.
    appendSpy.mockRestore();
    const retried = await o.createWorktree(req);
    expect(isSuccess(retried)).toBe(true);
    if (isSuccess(retried)) {
      expect(retried.value.createdWorktree).toBe(false); // converged, not re-created
      expect(retried.value.createdBranch).toBe(false);
    }
    expect(extraWorktreeCount(repo)).toBe(1);
    expect(await o.openIntents()).not.toContain('wt-interrupt-1');
    expect((await ledgerEvents()).some((e) => e.type === VCS_EXECUTED)).toBe(true);
  });

  // ── partial-failure compensation: no orphaned branch ───────────────────────

  it('compensates the minted branch when worktree add fails (no orphaned on-disk state)', async () => {
    // A runner that lets the branch create + probes through to real git but
    // forces `worktree add` to fail, exercising the compensation path.
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
    // The branch minted for the failed worktree must have been deleted.
    expect(branchExists(repo, 'feature/should-be-compensated')).toBe(false);
    // A compensated terminal is recorded, so the key is closed, not orphaned.
    expect(await o.openIntents()).not.toContain('wt-fail-1');
  });

  // ── (f) fenced-out stale owner rejected ────────────────────────────────────

  it('(f) a fenced-out stale owner (lower epoch) is rejected and performs NO mutation', async () => {
    const o = owner();

    // A newer owner takes over at epoch 2 (records epoch 2 in the ledger).
    const takeover = await o.createBranch({
      repoRoot: repo,
      branch: 'feature/owner-2',
      base: 'main',
      idempotencyKey: 'owner2-branch',
      epoch: 2,
    });
    expect(isSuccess(takeover)).toBe(true);

    // The stale owner (epoch 1) attempts a mutation → fenced out.
    const stale = await o.createBranch({
      repoRoot: repo,
      branch: 'feature/owner-1-stale',
      base: 'main',
      idempotencyKey: 'owner1-branch',
      epoch: 1,
    });
    expect(isError(stale)).toBe(true);
    if (isError(stale)) expect(stale.error.code).toBe('VCS_STALE_EPOCH');
    // The stale owner's branch was never created.
    expect(branchExists(repo, 'feature/owner-1-stale')).toBe(false);
  });

  // ── (g) dry-run performs no mutation ───────────────────────────────────────

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
    expect(calls).toEqual([]); // structurally never reached git
    expect(branchExists(repo, 'feature/never')).toBe(false);
    expect(await ledgerEvents()).toEqual([]); // no intent, no terminal
  });

  // A "degrades to dry-run when the caller lacks shared-mutating capability"
  // case lived here. It is gone with the capability input itself — see the
  // `mode is requested, never inferred` block above.
});

// ─── Shared git-mutation primitives (the single argv surface) ─────────────────
//
// These centralize the worktree/branch mutation argument vectors in the owner
// module so the WLM (`worktree/manager.ts`) and the merge saga
// (`verbs/merge/local-git-merge.ts`) — which carry their own idempotency — route
// the raw git transport through the owner WITHOUT opening a second ledger, and
// no mutation token survives outside `vcs/` for the architecture census to flag.
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
