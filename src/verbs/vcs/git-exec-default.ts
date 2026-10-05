import { execFileSync } from 'node:child_process';
import type { GitExecResult } from '../pure/merge-preflight.js';
import { withIndexLockRetrySync } from '../worktree/git-retry.js';

/**
 * Runs `git` once in `repoRoot` with a 120-second timeout and no retry. It does not throw on a
 * non-zero exit. It returns git stderr separately and also appends it to `stdout`, because some
 * callers read `stdout` as the failure message.
 */
function runGitOnce(repoRoot: string, args: readonly string[]): GitExecResult {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const rawStderr = (err as { stderr?: string | Buffer }).stderr;
    const rawStdout = (err as { stdout?: string | Buffer }).stdout;
    const stderr =
      typeof rawStderr === 'string' ? rawStderr : rawStderr?.toString('utf-8') ?? '';
    const stdoutOnly =
      typeof rawStdout === 'string' ? rawStdout : rawStdout?.toString('utf-8') ?? '';
    const message = [stdoutOnly, stderr].filter(Boolean).join('\n');
    return {
      stdout: message,
      stderr,
      exitCode: typeof status === 'number' ? status : 1,
    };
  }
}

/**
 * Default git executor for the merge orchestrator. It wraps {@link runGitOnce} in
 * {@link withIndexLockRetrySync}, so `.git/index.lock` contention gets a bounded backoff retry.
 * The retry is synchronous because `GitExec` is synchronous. The gate handlers use a separate
 * `defaultGitExec` in `gate-utils.ts` with a 30-second timeout. Keep the two separate.
 */
export function defaultGitExec(repoRoot: string, args: readonly string[]): GitExecResult {
  return withIndexLockRetrySync(() => runGitOnce(repoRoot, args));
}
