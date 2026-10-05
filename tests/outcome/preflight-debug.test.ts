/**
 * Outcome tests for the debug payload of `mergePreflight`, against a real git repo.
 *
 * `mergePreflight` attaches a `debug` block only when `EXARCHOS_PREFLIGHT_DEBUG=1` and the ancestry
 * guard fails. An orphan branch has no merge base with `main`, so it makes the guard fail.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { withTmpGit } from './_helpers/tmp-git.js';
import { mergePreflight } from '../../src/verbs/pure/merge-preflight.js';
import type { GitExec } from '../../src/verbs/pure/merge-preflight.js';

/**
 * Runs git in `repoRoot` and returns `{ stdout, exitCode }`. It does not throw. A failed command
 * returns its exit status, or 1 when the error has none.
 */
function liveGitExec(repoRoot: string, args: readonly string[]): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    const message = typeof stdout === 'string' ? stdout : stdout?.toString('utf-8') ?? '';
    return { stdout: message, exitCode: typeof status === 'number' ? status : 1 };
  }
}

/**
 * Checks out the orphan branch `feature/orphan` and commits one file on it. The branch shares no
 * history with `main`, so `merge-base --is-ancestor main feature/orphan` exits 1.
 */
async function setupAncestryFailureTopology(repoPath: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'checkout', '--orphan', 'feature/orphan']);
  await fs.writeFile(path.join(repoPath, 'orphan.txt'), 'orphan\n');
  await execFileAsync('git', ['-C', repoPath, 'add', 'orphan.txt']);
  await execFileAsync('git', ['-C', repoPath, 'commit', '-m', 'orphan']);
}

describe('preflight debug payload (#1362 phase 1)', () => {
  /**
   * The test clears the variable first, so a value from the runner environment cannot change the
   * result. Ancestry must fail, or the absent `debug` block proves nothing.
   */
  it('Preflight_DebugEnvUnset_NoDebugField', async () => {
    await withTmpGit(async (repoPath) => {
      await setupAncestryFailureTopology(repoPath);

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

        expect(result.passed).toBe(false);
        expect(result.ancestry.passed).toBe(false);

        expect('debug' in result ? result.debug : undefined).toBeUndefined();
      } finally {
        if (prior !== undefined) process.env.EXARCHOS_PREFLIGHT_DEBUG = prior;
      }
    });
  });

  /**
   * With the variable set to `1`, the result must hold a `debug` block with each field of the
   * payload.
   */
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

        expect('debug' in result, 'no debug block attached').toBe(true);
        const debug: Record<string, unknown> =
          'debug' in result && result.debug !== null && typeof result.debug === 'object'
            ? { ...result.debug }
            : {};
        expect(typeof debug.gitVersion).toBe('string');
        expect(typeof debug.repoRoot).toBe('string');
        expect(typeof debug.worktreeList).toBe('string');
        expect(debug.refsHeadsSource).toBeDefined();
        expect(debug.refsHeadsTarget).toBeDefined();
        expect(Array.isArray(debug.mergeBaseCommand)).toBe(true);
        expect(typeof debug.mergeBaseExitCode).toBe('number');
        expect(typeof debug.mergeBaseStdout).toBe('string');
        expect(typeof debug.mergeBaseStderr).toBe('string');
      } finally {
        if (prior === undefined) delete process.env.EXARCHOS_PREFLIGHT_DEBUG;
        else process.env.EXARCHOS_PREFLIGHT_DEBUG = prior;
      }
    });
  });
});
