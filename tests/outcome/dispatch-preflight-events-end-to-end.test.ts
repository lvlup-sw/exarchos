/**
 * Outcome tests for the `dispatch.preflight` event of `handlePrepareDelegation`.
 *
 * The handler runs against a real git repo and a real `EventStore`, with no module mocks. Each
 * dispatch must append one `dispatch.preflight` event with the result of each guard and the
 * aggregate `passed` flag. A repo with no stash must append no `stash.detected` event.
 * `tests/unit/verbs/team/dispatch-guard.test.ts` covers a repo that has a stash.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { withTmpGit } from './_helpers/tmp-git.js';
import { EventStore } from '../../src/events/store.js';
import { handlePrepareDelegation } from '../../src/verbs/team/prepare-delegation.js';
import { resetMaterializerCache } from '../../src/projections/views/tools.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';

async function gitRun(repo: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', repo, ...args]);
}

async function mkStateDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `outcome-1261-${label}-`));
}

/**
 * Runs `fn` with the process working directory set to `dir`, then restores it. The handler calls
 * `createGitExec` with no directory, so the working directory selects the repo that the guards
 * read.
 */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prior);
  }
}

describe('dispatch.preflight + stash.detected end-to-end (#1261)', () => {
  /**
   * The branch `feature/work` descends from `main`, so the ancestry guard passes. The repo is under
   * `os.tmpdir()`, and the test assumes that this path does not hold `.claude/worktrees/`, so the
   * `worktree` and `mainWorktree` guards pass. The test asserts the events, not the readiness
   * verdict of the handler.
   */
  it('PrepareDelegation_AllGuardsPass_EmitsOneDispatchPreflightPassedTrue', async () => {
    await withTmpGit(async (repoPath) => {
      await gitRun(repoPath, ['checkout', '-b', 'feature/work']);

      const stateDir = await mkStateDir('happy');
      resetMaterializerCache();
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const ctx: DispatchContext = {
        stateDir,
        eventStore,
        enableTelemetry: false,
      };

      await withCwd(repoPath, async () => {
        const result = await handlePrepareDelegation(
          { featureId: 'outcome-1261-happy' },
          stateDir,
          ctx,
        );
        expect(result.success).toBe(true);
      });

      const preflightEvents = await eventStore.query('outcome-1261-happy', {
        type: 'dispatch.preflight',
      });
      expect(preflightEvents).toHaveLength(1);

      const data = preflightEvents[0]?.data as {
        guards: {
          ancestry: { passed: boolean };
          worktree: { passed: boolean };
          protectedBranch: { passed: boolean };
          mainWorktree: { passed: boolean };
        };
        passed: boolean;
        durationMs: number;
      };
      expect(data.guards.ancestry.passed).toBe(true);
      expect(data.guards.protectedBranch.passed).toBe(true);
      expect(data.guards.worktree.passed).toBe(true);
      expect(data.guards.mainWorktree.passed).toBe(true);
      expect(data.passed).toBe(true);
      expect(typeof data.durationMs).toBe('number');
      expect(data.durationMs).toBeGreaterThanOrEqual(0);

      const stashEvents = await eventStore.query('outcome-1261-happy', {
        type: 'stash.detected',
      });
      expect(stashEvents).toHaveLength(0);
    });
  });

  /**
   * An orphan branch shares no history with `main`, so
   * `merge-base --is-ancestor main feature/orphan` exits 1. The handler reports a blocked dispatch
   * as `success: true`, and it still appends one `dispatch.preflight` event.
   */
  it('PrepareDelegation_AncestryFails_EmitsDispatchPreflightPassedFalse', async () => {
    await withTmpGit(async (repoPath) => {
      await execFileAsync('git', ['-C', repoPath, 'checkout', '--orphan', 'feature/orphan']);
      await fs.writeFile(path.join(repoPath, 'orphan.txt'), 'orphan\n');
      await execFileAsync('git', ['-C', repoPath, 'add', 'orphan.txt']);
      await execFileAsync('git', ['-C', repoPath, 'commit', '-m', 'orphan']);

      const stateDir = await mkStateDir('ancestry-fail');
      resetMaterializerCache();
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const ctx: DispatchContext = {
        stateDir,
        eventStore,
        enableTelemetry: false,
      };

      await withCwd(repoPath, async () => {
        const result = await handlePrepareDelegation(
          { featureId: 'outcome-1261-ancestry-fail' },
          stateDir,
          ctx,
        );
        expect(result.success).toBe(true);
      });

      const preflightEvents = await eventStore.query(
        'outcome-1261-ancestry-fail',
        { type: 'dispatch.preflight' },
      );
      expect(preflightEvents).toHaveLength(1);

      const data = preflightEvents[0]?.data as {
        guards: {
          ancestry: { passed: boolean };
          worktree: { passed: boolean };
          protectedBranch: { passed: boolean };
          mainWorktree: { passed: boolean };
        };
        passed: boolean;
        durationMs: number;
      };
      expect(data.guards.ancestry.passed).toBe(false);
      expect(data.passed).toBe(false);
      expect(typeof data.durationMs).toBe('number');
    });
  });
});
