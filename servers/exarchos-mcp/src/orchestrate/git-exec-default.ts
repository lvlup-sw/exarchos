import { execFileSync } from 'node:child_process';
import type { GitExecResult } from './pure/merge-preflight.js';
import { withIndexLockRetrySync } from './worktree/git-retry.js';

/**
 * Single, un-retried `git` shell-out — the raw executor body. Synchronous
 * shell-out from `repoRoot` with a 120s ceiling. NEVER throws on a non-zero
 * exit — failures surface via `exitCode`. git's stderr is captured *separately*
 * (so #1362 phase-1 diagnostics can distinguish git's error output from any
 * partial stdout) AND folded into `stdout` with a newline for backwards-compat
 * with callers that read `stdout` as the failure-message channel.
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
 * Canonical default git executor for the merge orchestrator (#1311 dedupe).
 *
 * The DEFAULT production composition (not merely a DI seam): {@link runGitOnce}
 * wrapped in {@link withIndexLockRetrySync} so a transient `.git/index.lock`
 * contention under burst dispatch (DR-8 / DR-1) is retried with bounded backoff
 * (~200/400/800ms) instead of surfacing as a hard failure. The retry is
 * SYNCHRONOUS (a bounded blocking sleep, worst case ~1.5s) because `GitExec` is
 * synchronous — a naive async wrap would be both type-infeasible and inert
 * (`runGitOnce` never throws). Non-lock failures and successes short-circuit on
 * the first attempt, so read-only/non-contended calls incur zero extra latency.
 *
 * Extracted from the two byte-equivalent 120s copies previously inlined in
 * `merge-orchestrate.ts` and `execute-merge.ts`. NOTE: the per-task gate
 * handlers use a deliberately *separate* `defaultGitExec` in `gate-utils.ts`
 * with a 30s ceiling tuned for quick gate git ops — the two are different
 * workloads and must NOT be collapsed.
 */
export function defaultGitExec(repoRoot: string, args: readonly string[]): GitExecResult {
  return withIndexLockRetrySync(() => runGitOnce(repoRoot, args));
}
