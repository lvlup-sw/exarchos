// ─── PR2 / #1362 — Windows ancestry-debug instrumentation outcome ────────────
//
// Phase-1 instrumentation contract: when `EXARCHOS_PREFLIGHT_DEBUG=1` AND the
// ancestry guard fails, `mergePreflight` must attach a structured `debug` block
// to its result. When the env var is unset (or set but ancestry passes), no
// debug block is attached — the gating is failure-only by design (DIM-8 /
// event-store growth concern; see plan T2.x and the design "Symmetry decision"
// note). Phase-2 may introduce verbose sub-modes via `EXARCHOS_PREFLIGHT_DEBUG=2`
// separately.
//
// Linux-only test path: drives ancestry-failure by creating an orphan branch
// (no merge-base with `main`), then invokes `mergePreflight` against a real
// tmp git repo.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import { withTmpGit } from './_helpers/tmp-git.js';
import { mergePreflight } from '../../src/verbs/pure/merge-preflight.js';
import type { GitExec } from '../../src/verbs/pure/merge-preflight.js';

/** Default gitExec mirroring the handler's `defaultGitExec` (no throw, returns
 * `{ stdout, exitCode }`). Inline here so the outcome test does not depend on
 * the handler module's internal helper. */
function liveGitExec(repoRoot: string, args: readonly string[]): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    const message = typeof stdout === 'string' ? stdout : stdout?.toString('utf-8') ?? '';
    return { stdout: message, exitCode: typeof status === 'number' ? status : 1 };
  }
}

/** Set up an orphan source branch so `merge-base --is-ancestor main source`
 * fails with exit 1 (ancestry-missing). Returns the path of the primary
 * repo with the orphan branch checked in. */
async function setupAncestryFailureTopology(repoPath: string): Promise<void> {
  // The initial commit on `main` is empty (no tracked files). Create an orphan
  // branch with no shared history, then commit a file so HEAD has a valid
  // commit and `merge-base --is-ancestor main feature/orphan` returns exit 1
  // (disjoint histories, no common ancestor).
  execFileSync('git', ['-C', repoPath, 'checkout', '--orphan', 'feature/orphan'], {
    stdio: 'pipe',
  });
  await fs.writeFile(path.join(repoPath, 'orphan.txt'), 'orphan\n');
  execFileSync('git', ['-C', repoPath, 'add', 'orphan.txt'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoPath, 'commit', '-m', 'orphan'], { stdio: 'pipe' });
}

describe('preflight debug payload (#1362 phase 1)', () => {
  it('Preflight_DebugEnvUnset_NoDebugField', async () => {
    await withTmpGit(async (repoPath) => {
      await setupAncestryFailureTopology(repoPath);

      // Snapshot + clear the env var so this test is hermetic regardless of
      // whether the runner has it set.
      const prior = process.env.EXARCHOS_PREFLIGHT_DEBUG;
      delete process.env.EXARCHOS_PREFLIGHT_DEBUG;
      try {
        const gitExec: GitExec = (root, args) => liveGitExec(root, args);
        const result = await mergePreflight({
          sourceBranch: 'feature/orphan',
          targetBranch: 'main',
          gitExec,
          cwd: repoPath,
        });

        // Ancestry must actually fail for this test to be meaningful.
        expect(result.passed).toBe(false);
        expect(result.ancestry.passed).toBe(false);

        // No debug block when env var is unset.
        expect((result as Record<string, unknown>).debug).toBeUndefined();
      } finally {
        if (prior !== undefined) process.env.EXARCHOS_PREFLIGHT_DEBUG = prior;
      }
    });
  });

  it('Preflight_DebugEnvSetAndAncestryFail_AttachesDebugBlock', async () => {
    await withTmpGit(async (repoPath) => {
      await setupAncestryFailureTopology(repoPath);

      const prior = process.env.EXARCHOS_PREFLIGHT_DEBUG;
      process.env.EXARCHOS_PREFLIGHT_DEBUG = '1';
      try {
        const gitExec: GitExec = (root, args) => liveGitExec(root, args);
        const result = await mergePreflight({
          sourceBranch: 'feature/orphan',
          targetBranch: 'main',
          gitExec,
          cwd: repoPath,
        });

        expect(result.passed).toBe(false);
        expect(result.ancestry.passed).toBe(false);

        // Debug block MUST be attached and structurally complete.
        const debug = (result as { debug?: Record<string, unknown> }).debug;
        expect(debug).toBeDefined();
        expect(typeof debug!.gitVersion).toBe('string');
        expect(typeof debug!.repoRoot).toBe('string');
        expect(typeof debug!.worktreeList).toBe('string');
        expect(debug!.refsHeadsSource).toBeDefined();
        expect(debug!.refsHeadsTarget).toBeDefined();
        expect(Array.isArray(debug!.mergeBaseCommand)).toBe(true);
        expect(typeof debug!.mergeBaseExitCode).toBe('number');
        expect(typeof debug!.mergeBaseStdout).toBe('string');
        expect(typeof debug!.mergeBaseStderr).toBe('string');
      } finally {
        if (prior === undefined) delete process.env.EXARCHOS_PREFLIGHT_DEBUG;
        else process.env.EXARCHOS_PREFLIGHT_DEBUG = prior;
      }
    });
  });
});
