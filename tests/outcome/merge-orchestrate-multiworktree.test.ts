// ─── T-016 — merge-orchestrate multi-worktree topology outcome (RED) ─────
//
// Encodes the #1356 regression: when the merge target branch is checked
// out in a sibling worktree of the same repository, `handleMergeOrchestrate`
// currently falsely returns `phase: 'rolled-back'` with the cwd HEAD as
// the rollback SHA, instead of aborting cleanly with `reason:
// 'target-checked-out-elsewhere'` BEFORE attempting the merge.
//
// Wrapped in `it.fails` so vitest reports it as an expected failure
// (vitest 3.x exposes `failing`-semantics via `.fails`). The `.fails`
// annotation will be removed in PR2 (wave1-fixes) once the preflight
// gains a target-checkout-availability guard. Reviewer grep target:
// `it.fails`.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { withTmpGit, addSiblingWorktree } from './_helpers/tmp-git.js';
import { handleMergeOrchestrate } from '../../servers/exarchos-mcp/src/orchestrate/merge-orchestrate.js';
import { EventStore } from '../../servers/exarchos-mcp/src/events/store.js';
import type { DispatchContext } from '../../servers/exarchos-mcp/src/core/dispatch.js';
// Side-effect import — registers `merge-orchestrator@v1` with the default
// registry so the handler's Phase A `decide()` call can resolve the
// reducer. Mirrors the import in merge-orchestrate.migration.test.ts.
import '../../servers/exarchos-mcp/src/projections/merge-orchestrator/index.js';

function gitOut(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function gitRun(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

describe('merge-orchestrate multi-worktree topology outcome (#1356)', () => {
  // RED-by-design — flipped in PR2 (wave1-fixes) when the preflight gains
  // a target-checked-out-elsewhere guard.
  it(
    'MergeOrchestrate_TargetCheckedOutInSibling_AbortsCleanly',
    async () => {
      await withTmpGit(async (repoPath) => {
        // ─── 1. Set up source + target topology ──────────────────────────
        // The initial commit on `main` is already there from withTmpGit.
        // Create the `integration` (target) branch first, then check it
        // out into a sibling worktree (this is the #1356 trigger
        // condition).
        gitRun(repoPath, ['branch', 'integration']);
        const sibling = await addSiblingWorktree(repoPath, 'feature/source');

        // Stay on `main` in the primary worktree so the orchestrator's
        // `assertMainWorktree` check passes. Add a commit on
        // `feature/source` so there is something to merge into
        // `integration`.
        await fs.writeFile(path.join(sibling, 'a.txt'), 'hello\n');
        gitRun(sibling, ['add', 'a.txt']);
        gitRun(sibling, ['commit', '-m', 'feature: add a.txt']);

        // Now move `integration` into ANOTHER sibling worktree so the
        // target is checked out elsewhere (the regression scenario).
        const integrationWt = await addSiblingWorktree(
          repoPath,
          'integration-checkout',
        );
        // Rename: `addSiblingWorktree` creates a new branch
        // `integration-checkout`. We actually want `integration` itself
        // checked out — switch the sibling onto `integration`.
        gitRun(integrationWt, ['checkout', 'integration']);

        // Primary worktree: ensure HEAD is on the original main commit
        // (not on `integration`, since `integration` is now elsewhere).
        gitRun(repoPath, ['checkout', 'main']);
        const initialHead = gitOut(repoPath, ['rev-parse', 'HEAD']);

        // ─── 2. Build a real EventStore + DispatchContext ────────────────
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

        // ─── 3. Invoke handleMergeOrchestrate against the bug topology ───
        // Pass `repoRoot` so preflight uses our tmp repo (not process.cwd
        // — which under vitest is the workspace root).
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

          // ─── 4. Expected post-fix behavior (#1356) ─────────────────────
          // - Handler aborts the merge BEFORE invoking the executor.
          // - The structured reason is `target-checked-out-elsewhere`.
          // - HEAD in the primary worktree is unchanged (no rollback
          //   needed because no merge was attempted).
          expect(result.success).toBe(false);
          const data = (result.data ?? {}) as Record<string, unknown>;
          expect(data.phase).toBe('aborted');
          expect(data.reason).toBe('target-checked-out-elsewhere');

          const postHead = gitOut(repoPath, ['rev-parse', 'HEAD']);
          expect(postHead).toBe(initialHead);
        } finally {
          await fs.rm(stateDir, { recursive: true, force: true });
        }
      });
    },
  );
});
