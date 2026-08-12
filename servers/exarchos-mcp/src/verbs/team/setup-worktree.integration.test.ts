// ─── P04-05 follow-up — production-path VCS exit proofs ───────────────────────
//
// The owner-level exit proofs live in `vcs/mutation-owner.test.ts`; this suite
// proves the SAME guarantees through the REAL shipped entry points now that
// `setup_worktree` and the merge adapter route through the single typed VCS
// mutation owner. Each test drives a REAL git repo (per-test tmp dir) and the
// REAL durable EventStore — no mocked git — so the guarantees are pinned against
// actual on-disk branches/worktrees + a real ledger:
//
//   (a) a duplicate `handleSetupWorktree` request creates exactly ONE worktree
//       (idempotency replay, not a duplicate or a `git worktree add` error);
//   (b) an interrupted `handleSetupWorktree` (crash after the git effect, before
//       the ledger terminal) leaves a durable INTENT — never an event-less
//       on-disk orphan (the observed defect) — and converges on retry;
//   (c) a duplicate merge request runs the REAL local-git merge adapter exactly
//       ONCE (the owner's provider-mutation idempotency boundary), landing a
//       single merge commit.
//
// These call `handleSetupWorktree` / the merge adapter, NOT the owner's
// createWorktree directly — the point is that the production call path is now
// safe, not merely that the owner is.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { handleSetupWorktree } from './setup-worktree.js';
import { buildLocalGitMergeAdapter } from '../merge/local-git-merge.js';
import type { GitExec } from '../pure/execute-merge.js';
import { EventStore } from '../../events/store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { capabilitiesForPosture } from '../../capabilities/posture-mapping.js';
import { isSuccess } from '../../dispatch/core/effect-carrier.js';
import { VcsMutationOwner, VCS_REQUESTED, VCS_EXECUTED } from '../../vcs/mutation-owner.js';
import {
  createOwnerBackedWorktreeProvisioner,
  defaultVcsLedgerDir,
  mapWorktreeOutcome,
  type WorktreeProvisioner,
} from '../../vcs/worktree-provisioner.js';

// ─── git helpers ─────────────────────────────────────────────────────────────

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A `GitExec` (execute-merge's shape) that captures exit codes rather than throwing. */
const captureGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; status?: number };
    return { stdout: String(err.stdout ?? ''), exitCode: err.status ?? 1 };
  }
};

/** Init a real repo on `main` with one commit; returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'setup@example.com']);
  git(dir, ['config', 'user.name', 'Setup Worktree Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return realpathSync(dir);
}

/** Count on-disk worktrees EXCLUDING the main checkout. */
function extraWorktreeCount(repoRoot: string): number {
  const all = git(repoRoot, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
  return all - 1;
}

/** The event types recorded on the setup-worktree ledger stream for `repoRoot`. */
async function ledgerTypes(repoRoot: string): Promise<string[]> {
  const store = new EventStore(defaultVcsLedgerDir(repoRoot));
  await store.initialize();
  try {
    const events = await store.query('vcs-worktree-setup');
    return events.map((e) => e.type);
  } finally {
    store.close();
  }
}

interface SetupData {
  readonly passed: boolean;
  readonly worktreePath: string;
  readonly branchName: string;
}

describe('setup_worktree / merge production-path exit proofs (P04-05)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo(await mkdtemp(path.join(tmpdir(), 'p0405-setup-')));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
    await rmrfAsync(repo);
  });

  // ── (a) duplicate setup_worktree → ONE worktree ────────────────────────────

  it('(a) a duplicate setup_worktree request creates exactly ONE worktree', async () => {
    const args = { repoRoot: repo, taskId: 'T-1', taskName: 'dup', skipTests: true };

    const first = await handleSetupWorktree(args);
    expect(first.success).toBe(true);
    const firstData = first.data as SetupData;
    expect(firstData.passed).toBe(true);
    expect(existsSync(firstData.worktreePath)).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1);

    // Second identical request: the owner's path-keyed idempotency replays the
    // recorded outcome WITHOUT a second `git worktree add` (which would either
    // error on the existing path or, pre-owner, orphan a duplicate).
    const second = await handleSetupWorktree(args);
    expect(second.success).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1); // still exactly ONE

    // Exactly one executed terminal recorded for the worktree — the effect ran once.
    const types = await ledgerTypes(repo);
    expect(types.filter((t) => t === VCS_EXECUTED)).toHaveLength(1);
  });

  // ── (b) interrupted setup_worktree → recorded intent, converges on retry ───

  it('(b) an interrupted setup_worktree leaves a durable intent (no event-less orphan) and converges on retry', async () => {
    // A provisioner that mirrors production wiring but, on the FIRST provision,
    // crashes AFTER the git effect and BEFORE the ledger terminal — the exact
    // shape of the observed non-atomic defect.
    const crash = { armed: true };
    const provisioner: WorktreeProvisioner = {
      async provision(req) {
        const store = new EventStore(defaultVcsLedgerDir(req.repoRoot));
        await store.initialize();
        const original = store.append.bind(store);
        vi.spyOn(store, 'append').mockImplementation(async (streamId, event, opts) => {
          if (crash.armed && event.type === VCS_EXECUTED) {
            crash.armed = false; // fire exactly once
            throw new Error('simulated crash before terminal append');
          }
          return original(streamId, event, opts);
        });
        try {
          const owner = new VcsMutationOwner({
            eventStore: store,
            stream: 'vcs-worktree-setup',
          });
          const outcome = await owner.createWorktree({
            repoRoot: req.repoRoot,
            worktreePath: req.worktreePath,
            branch: req.branch,
            base: req.base,
            idempotencyKey: `worktree-setup:${req.worktreePath}`,
            epoch: 1,
          });
          return mapWorktreeOutcome(outcome);
        } finally {
          store.close();
        }
      },
    };

    const args = { repoRoot: repo, taskId: 'T-2', taskName: 'interrupt', skipTests: true };

    // First (interrupted) run: the handler reports the worktree check as FAILED
    // (the terminal never landed), yet the git effect already created the
    // worktree on disk — the dangerous interior state.
    const interrupted = await handleSetupWorktree(args, undefined, { provisioner });
    expect(interrupted.success).toBe(true);
    expect((interrupted.data as SetupData).passed).toBe(false);
    const worktreePath = (interrupted.data as SetupData).worktreePath;

    // The on-disk worktree exists — but it is NOT an event-less orphan: a
    // durable INTENT was recorded, and NO terminal. A reconciler can find it.
    expect(existsSync(worktreePath)).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1);
    const typesAfterCrash = await ledgerTypes(repo);
    expect(typesAfterCrash).toContain(VCS_REQUESTED);
    expect(typesAfterCrash).not.toContain(VCS_EXECUTED);

    // Retry with the SAME task (crash now disarmed): the effect no-ops (branch +
    // worktree already exist), the terminal lands, and there is STILL one worktree.
    const retried = await handleSetupWorktree(args, undefined, { provisioner });
    expect(retried.success).toBe(true);
    expect((retried.data as SetupData).passed).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1); // converged, not re-created
    const typesAfterRetry = await ledgerTypes(repo);
    expect(typesAfterRetry).toContain(VCS_EXECUTED);
  });

  // ── (c) duplicate merge → ONE merge ────────────────────────────────────────

  it('(c) a duplicate merge request runs the local-git merge adapter exactly ONCE', async () => {
    // Stand up a feature branch with a real commit to merge into main.
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'feature work'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(repo, ['checkout', '-q', 'main']);

    const store = new EventStore(path.join(repo, '.git', 'exarchos', 'vcs-merges'));
    await store.initialize();
    try {
      const owner = new VcsMutationOwner({
        eventStore: store,
        stream: 'vcs-merge',
      });
      const adapter = buildLocalGitMergeAdapter(captureGitExec, repo);

      let mergeCalls = 0;
      const effect = async (): Promise<{ mergeSha: string }> => {
        mergeCalls += 1;
        const r = await adapter({
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          strategy: 'merge',
        });
        return { mergeSha: r.mergeSha };
      };
      const input = {
        kind: 'merge',
        description: 'merge feature/x into main',
        idempotencyKey: 'merge:feature/x->main',
        epoch: 1,
      };

      const first = await owner.runProviderMutation(input, effect);
      const second = await owner.runProviderMutation(input, effect);

      // The real merge ran exactly once across the duplicate requests.
      expect(mergeCalls).toBe(1);
      expect(isSuccess(first)).toBe(true);
      expect(isSuccess(second)).toBe(true);
      if (isSuccess(first) && isSuccess(second)) {
        expect(second.value).toEqual(first.value); // replayed the recorded outcome
      }
      // Exactly ONE merge commit landed on main.
      expect(git(repo, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('1');
    } finally {
      store.close();
    }
  });

  // ── default provisioner smoke: the production factory is really wired ───────

  it('the default owner-backed provisioner provisions a real worktree end-to-end', async () => {
    const provisioner = createOwnerBackedWorktreeProvisioner();
    const outcome = await provisioner.provision({
      repoRoot: repo,
      worktreePath: path.join(repo, '.worktrees', 'smoke'),
      branch: 'feature/smoke',
      base: 'main',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.branchCreated).toBe(true);
    expect(outcome.worktreeCreated).toBe(true);
    expect(extraWorktreeCount(repo)).toBe(1);
  });
});
