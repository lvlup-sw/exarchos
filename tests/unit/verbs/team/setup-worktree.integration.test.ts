/**
 * Exit proofs for the VCS mutation owner on the production call paths.
 *
 * The tests call `handleSetupWorktree` and the local-git merge adapter, not the
 * owner alone. Each test uses a real git repo in a temporary directory and a real
 * `EventStore`, with no mocked git. The owner-level proofs are in
 * `tests/unit/vcs/mutation-owner.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { handleSetupWorktree } from '../../../../src/verbs/team/setup-worktree.js';
import { buildLocalGitMergeAdapter } from '../../../../src/verbs/merge/local-git-merge.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { capabilitiesForPosture } from '../../../../src/workflow/capabilities/posture-mapping.js';
import { isSuccess } from '../../../../src/dispatch/core/effect-carrier.js';
import { VcsMutationOwner, VCS_REQUESTED, VCS_EXECUTED } from '../../../../src/vcs/mutation-owner.js';
import {
  createOwnerBackedWorktreeProvisioner,
  defaultVcsLedgerDir,
  mapWorktreeOutcome,
  type WorktreeProvisioner,
} from '../../../../src/vcs/worktree-provisioner.js';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/** A `GitExec` (execute-merge's shape) that captures exit codes rather than throwing. */
const captureGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; status?: number };
    return { stdout: String(err.stdout ?? ''), exitCode: err.status ?? 1 };
  }
};

/** Initialize a real repo on `main` with one commit, and return its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'setup@example.com']);
  await git(dir, ['config', 'user.name', 'Setup Worktree Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return realpathSync(dir);
}

/** Count on-disk worktrees EXCLUDING the main checkout. */
async function extraWorktreeCount(repoRoot: string): Promise<number> {
  const all = (await git(repoRoot, ['worktree', 'list', '--porcelain']))
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
      await git(repo, ['worktree', 'prune']);
    } catch {
    }
    await rmrfAsync(repo);
  });

  /**
   * The owner keys idempotency on the worktree path. The second request replays
   * the recorded outcome and does not run `git worktree add` again.
   */
  it('(a) a duplicate setup_worktree request creates exactly ONE worktree', async () => {
    const args = { repoRoot: repo, taskId: 'T-1', taskName: 'dup', skipTests: true };

    const first = await handleSetupWorktree(args);
    expect(first.success).toBe(true);
    const firstData = first.data as SetupData;
    expect(firstData.passed).toBe(true);
    expect(existsSync(firstData.worktreePath)).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);

    const second = await handleSetupWorktree(args);
    expect(second.success).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);

    const types = await ledgerTypes(repo);
    expect(types.filter((t) => t === VCS_EXECUTED)).toHaveLength(1);
  });

  /**
   * The provisioner copies the production wiring, but the first `VCS_EXECUTED`
   * append throws after the git effect. The handler then reports the check as
   * failed, and the ledger holds the intent without a terminal. The retry
   * appends the terminal and keeps one worktree.
   */
  it('(b) an interrupted setup_worktree leaves a durable intent (no event-less orphan) and converges on retry', async () => {
    const crash = { armed: true };
    const provisioner: WorktreeProvisioner = {
      async provision(req) {
        const store = new EventStore(defaultVcsLedgerDir(req.repoRoot));
        await store.initialize();
        const original = store.append.bind(store);
        vi.spyOn(store, 'append').mockImplementation(async (streamId, event, opts) => {
          if (crash.armed && event.type === VCS_EXECUTED) {
            crash.armed = false;
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

    const interrupted = await handleSetupWorktree(args, undefined, { provisioner });
    expect(interrupted.success).toBe(true);
    expect((interrupted.data as SetupData).passed).toBe(false);
    const worktreePath = (interrupted.data as SetupData).worktreePath;

    expect(existsSync(worktreePath)).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);
    const typesAfterCrash = await ledgerTypes(repo);
    expect(typesAfterCrash).toContain(VCS_REQUESTED);
    expect(typesAfterCrash).not.toContain(VCS_EXECUTED);

    const retried = await handleSetupWorktree(args, undefined, { provisioner });
    expect(retried.success).toBe(true);
    expect((retried.data as SetupData).passed).toBe(true);
    expect(await extraWorktreeCount(repo)).toBe(1);
    const typesAfterRetry = await ledgerTypes(repo);
    expect(typesAfterRetry).toContain(VCS_EXECUTED);
  });

  /**
   * Two `runProviderMutation` calls with one idempotency key run the real merge
   * once. The second call replays the recorded outcome, and `main` gets one merge
   * commit.
   */
  it('(c) a duplicate merge request runs the local-git merge adapter exactly ONCE', async () => {
    await git(repo, ['checkout', '-q', '-b', 'feature/x']);
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'feature work'], { cwd: repo });
    await git(repo, ['checkout', '-q', 'main']);

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

      expect(mergeCalls).toBe(1);
      expect(isSuccess(first)).toBe(true);
      expect(isSuccess(second)).toBe(true);
      if (isSuccess(first) && isSuccess(second)) {
        expect(second.value).toEqual(first.value);
      }
      expect(await git(repo, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('1');
    } finally {
      store.close();
    }
  });

  /** The production provisioner factory creates a real branch and worktree. */
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
    expect(await extraWorktreeCount(repo)).toBe(1);
  });
});
