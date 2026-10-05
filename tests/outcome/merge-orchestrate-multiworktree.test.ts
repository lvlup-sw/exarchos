/**
 * Outcome test for `handleMergeOrchestrate` when a sibling worktree holds the target branch.
 *
 * The handler must abort before the merge with `reason: 'target-checked-out-elsewhere'`. It must
 * not try the merge and then report a rollback. The test uses a real git repo with two sibling
 * worktrees.
 *
 * The bare import of `projections/merge-orchestrator/index.js` registers the
 * `merge-orchestrator@v1` reducer with the default registry.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { withTmpGit, addSiblingWorktree } from './_helpers/tmp-git.js';
import { handleMergeOrchestrate } from '../../src/verbs/merge/merge-orchestrate.js';
import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import '../../src/projections/merge-orchestrator/index.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

async function gitOut(repo: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: repo })).trim();
}

async function gitRun(repo: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: repo });
}

describe('merge-orchestrate multi-worktree topology outcome (#1356)', () => {
  /**
   * The primary worktree stays on `main`. One sibling worktree holds `feature/source` with one
   * commit, and a second sibling worktree checks out the target branch `integration`. The handler
   * must abort with `phase: 'aborted'` and leave HEAD of the primary worktree unchanged.
   * `repoRoot` points the handler at the test repo, not at the working directory of the process.
   */
  it(
    'MergeOrchestrate_TargetCheckedOutInSibling_AbortsCleanly',
    async () => {
      await withTmpGit(async (repoPath) => {
        await gitRun(repoPath, ['branch', 'integration']);
        const sibling = await addSiblingWorktree(repoPath, 'feature/source');

        await fs.writeFile(path.join(sibling, 'a.txt'), 'hello\n');
        await gitRun(sibling, ['add', 'a.txt']);
        await gitRun(sibling, ['commit', '-m', 'feature: add a.txt']);

        const integrationWt = await addSiblingWorktree(
          repoPath,
          'integration-checkout',
        );
        await gitRun(integrationWt, ['checkout', 'integration']);

        await gitRun(repoPath, ['checkout', 'main']);
        const initialHead = await gitOut(repoPath, ['rev-parse', 'HEAD']);

        const stateDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'outcome-merge-orch-'),
        );
        await fs.mkdir(path.join(stateDir, 'workflow-state'), {
          recursive: true,
        });
        const eventStore = new EventStore(stateDir);

        const ctx = {
          stateDir,
          eventStore,
          enableTelemetry: false,
        } as unknown as DispatchContext;

        try {
          const result = await handleMergeOrchestrate(
            {
              featureId: 'outcome-1356',
              sourceBranch: 'feature/source',
              targetBranch: 'integration',
              taskId: 'T-1356',
              strategy: 'merge',
              repoRoot: repoPath,
            },
            ctx,
          );

          expect(result.success).toBe(false);
          const data = (result.data ?? {}) as Record<string, unknown>;
          expect(data.phase).toBe('aborted');
          expect(data.reason).toBe('target-checked-out-elsewhere');

          const postHead = await gitOut(repoPath, ['rev-parse', 'HEAD']);
          expect(postHead).toBe(initialHead);
        } finally {
          await rmrfAsync(stateDir);
        }
      });
    },
  );
});
