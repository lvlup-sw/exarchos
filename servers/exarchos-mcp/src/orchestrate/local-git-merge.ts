// ─── Local Git Merge Adapter (#1194, DR-MO-2) ──────────────────────────────
//
// Production `vcsMerge` adapter for `handleExecuteMerge`. Performs a *local*
// `git merge` of source into target — the right primitive for landing a
// subagent worktree branch onto the integration branch under a recorded
// rollback sha.
//
// Replaces the previous `buildDefaultVcsMerge` (which routed through
// `provider.mergePr` over a remote VCS API). That wiring made the executor's
// `git reset --hard <rollbackSha>` rollback a no-op in production: a remote
// merge succeeds → local HEAD never moved → reset resets HEAD to itself.
// See #1194 for the full inconsistency trace.
//
// Contract:
//   • Caller must be on the target branch before invoking. The adapter
//     checks out target defensively to make this explicit, so a wrong-branch
//     state surfaces as a clear `git checkout` failure rather than silent
//     misbehavior.
//   • On success returns `{ mergeSha }` = HEAD of target after the merge.
//   • On any git failure throws `Error` with command + exit code + stdout
//     context. The pure executor's catch + `categorizeFailure` translates
//     that into a `RollbackReason`.
//   • 120s timeout on every git invocation (matches `post-merge.ts:48`).
// ────────────────────────────────────────────────────────────────────────────

import type { GitExec, MergeStrategy } from './pure/execute-merge.js';

export interface LocalGitMergeArgs {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly strategy: MergeStrategy;
}

export interface LocalGitMergeResult {
  readonly mergeSha: string;
}

export type LocalGitMergeAdapter = (
  args: LocalGitMergeArgs,
) => Promise<LocalGitMergeResult>;

function gitOrThrow(
  gitExec: GitExec,
  repoRoot: string,
  args: readonly string[],
): string {
  const result = gitExec(repoRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}${result.stdout ? `: ${result.stdout.trim()}` : ''}`,
    );
  }
  return result.stdout;
}

function squashCommitMessage(sourceBranch: string, targetBranch: string): string {
  return `Squash merge ${sourceBranch} into ${targetBranch}`;
}

/**
 * Build a local-git merge adapter conforming to the executor's `vcsMerge`
 * shape. The returned function is async to match the contract; the underlying
 * `gitExec` is synchronous.
 */
export function buildLocalGitMergeAdapter(
  gitExec: GitExec,
  repoRoot: string,
): LocalGitMergeAdapter {
  return async ({ sourceBranch, targetBranch, strategy }) => {
    // Defensive checkout: makes the adapter's branch precondition explicit
    // and surfaces wrong-state callers as a structured error.
    gitOrThrow(gitExec, repoRoot, ['checkout', targetBranch]);

    switch (strategy) {
      case 'merge':
        gitOrThrow(gitExec, repoRoot, ['merge', '--no-ff', '--no-edit', sourceBranch]);
        break;

      case 'squash':
        gitOrThrow(gitExec, repoRoot, ['merge', '--squash', sourceBranch]);
        gitOrThrow(gitExec, repoRoot, [
          'commit',
          '-m',
          squashCommitMessage(sourceBranch, targetBranch),
        ]);
        break;

      case 'rebase': {
        // Rebase via an ephemeral branch so the source ref is never mutated.
        // The executor's rollback path is `git reset --hard <rollbackSha>` on
        // the currently-checked-out branch — if rebase mutated `sourceBranch`
        // and rollback ran while it was checked out, sourceBranch would be
        // reset to the *target* SHA, corrupting it. Keeping source untouched
        // means the executor's reset-target rollback is sufficient.
        const tmpBranch = `__exarchos_merge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          gitOrThrow(gitExec, repoRoot, ['checkout', '-b', tmpBranch, sourceBranch]);
          gitOrThrow(gitExec, repoRoot, ['rebase', targetBranch]);
          gitOrThrow(gitExec, repoRoot, ['checkout', targetBranch]);
          gitOrThrow(gitExec, repoRoot, ['merge', '--ff-only', tmpBranch]);
        } catch (err) {
          // Best-effort: abort any in-flight rebase so the worktree isn't
          // left in REBASING state, then return to target before re-throwing
          // so the executor's reset --hard <rollbackSha> targets the right ref.
          gitExec(repoRoot, ['rebase', '--abort']);
          gitExec(repoRoot, ['checkout', targetBranch]);
          throw err;
        } finally {
          gitExec(repoRoot, ['branch', '-D', tmpBranch]);
        }
        break;
      }
    }

    const sha = gitOrThrow(gitExec, repoRoot, ['rev-parse', 'HEAD']).trim();
    if (!sha) {
      throw new Error('git rev-parse HEAD returned empty stdout after merge');
    }
    return { mergeSha: sha };
  };
}
