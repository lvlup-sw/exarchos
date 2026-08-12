// ─── #1261 — dispatch.preflight + stash.detected end-to-end (outcome) ────────
//
// Outcome-tier pin for the dispatch-boundary preflight observability events.
// Drives `handlePrepareDelegation` against a real tmp git repo + EventStore
// and asserts that `dispatch.preflight` lands on the stream with the
// expected per-guard outcome, exactly once per dispatch. Mirrors the
// integration patterns in `prepare-delegation.integration.test.ts` but
// runs without module-level mocks so the production primitives execute
// against a live `git` binary.
//
// The two scenarios pinned here are the load-bearing observables for the
// schema split chosen in PR B2:
//   1. Happy path — all four guards pass, `passed: true`.
//   2. Ancestry failure — disjoint history makes `merge-base
//      --is-ancestor main <branch>` exit 1; the event records
//      `guards.ancestry.passed: false` AND aggregate `passed: false`.
//
// Stash-detection is also wired into the dispatch boundary in this PR; a
// third assertion verifies that no `stash.detected` event fires on a
// clean worktree (advisory absence). Active-stash detection is covered
// by the unit test in `dispatch-guard.test.ts` — replicating that here
// would require mutating the test-runner's shared stash storage, which
// the project's documented stash hazard explicitly bars.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { withTmpGit } from './_helpers/tmp-git.js';
import { EventStore } from '../../servers/exarchos-mcp/src/events/store.js';
import { handlePrepareDelegation } from '../../servers/exarchos-mcp/src/verbs/team/prepare-delegation.js';
import { resetMaterializerCache } from '../../servers/exarchos-mcp/src/projections/views/tools.js';
import type { DispatchContext } from '../../servers/exarchos-mcp/src/dispatch/core/dispatch.js';

function gitRun(repo: string, args: readonly string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

async function mkStateDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `outcome-1261-${label}-`));
}

/**
 * Run `fn` with `process.cwd()` set to `dir`. Restores the prior cwd
 * even if `fn` throws. `handlePrepareDelegation` uses `createGitExec`
 * with no explicit cwd, so the process's working directory determines
 * which repository the guards see.
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
  it('PrepareDelegation_AllGuardsPass_EmitsOneDispatchPreflightPassedTrue', async () => {
    await withTmpGit(async (repoPath) => {
      // Set up a feature branch descending from `main` so the ancestry
      // guard (`merge-base --is-ancestor main feature/work`) passes.
      gitRun(repoPath, ['checkout', '-b', 'feature/work']);

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
        // The handler may return ready:false because the workflow has no
        // tasks materialized — that's fine; the contract under test here
        // is event emission, not the ready/blocked verdict.
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
      // `worktree.passed` reflects "not under .claude/worktrees/". The tmp
      // repo path created by `withTmpGit` lives under `os.tmpdir()`, which
      // does not contain that substring on the supported platforms, so
      // the assertion is `true`.
      expect(data.guards.worktree.passed).toBe(true);
      expect(data.guards.mainWorktree.passed).toBe(true);
      expect(data.passed).toBe(true);
      expect(typeof data.durationMs).toBe('number');
      expect(data.durationMs).toBeGreaterThanOrEqual(0);

      // Clean worktree → no stash.detected event.
      const stashEvents = await eventStore.query('outcome-1261-happy', {
        type: 'stash.detected',
      });
      expect(stashEvents).toHaveLength(0);
    });
  });

  it('PrepareDelegation_AncestryFails_EmitsDispatchPreflightPassedFalse', async () => {
    await withTmpGit(async (repoPath) => {
      // Build an orphan branch with no shared history with `main` so
      // `merge-base --is-ancestor main feature/orphan` exits 1
      // (ancestry-missing). Mirrors the topology in
      // `tests/outcome/preflight-debug.test.ts`.
      execFileSync(
        'git',
        ['-C', repoPath, 'checkout', '--orphan', 'feature/orphan'],
        { stdio: 'pipe' },
      );
      await fs.writeFile(path.join(repoPath, 'orphan.txt'), 'orphan\n');
      execFileSync('git', ['-C', repoPath, 'add', 'orphan.txt'], { stdio: 'pipe' });
      execFileSync('git', ['-C', repoPath, 'commit', '-m', 'orphan'], { stdio: 'pipe' });

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
        // Handler still returns success:true with a blocked-shape data
        // payload — its `success:false` slot is reserved for handler
        // exceptions, not for blocked dispatches.
        expect(result.success).toBe(true);
      });

      // Exactly one `dispatch.preflight` event, carrying ancestry failure.
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
