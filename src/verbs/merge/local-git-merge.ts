/**
 * Production `vcsMerge` adapter for `handleExecuteMerge`. It runs a local `git merge` of the source branch into the target branch.
 * A local merge moves HEAD, so the executor rollback with `git reset --keep <rollbackSha>` has an effect.
 *
 * The adapter checks out the target first, so a wrong-branch caller gets a clear `git checkout` failure.
 * On success it returns the target HEAD as `mergeSha`.
 * On a git failure it throws an `Error` with the command, the exit code and stdout. The executor maps that error to a `RecoveryReason`.
 */

import type { GitExec, MergeStrategy } from '../pure/execute-merge.js';
import { deleteBranchForce } from '../../vcs/mutation-owner.js';

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
 * Builds a local-git merge adapter with the `vcsMerge` shape of the executor.
 * The returned function is async to match the contract, but `gitExec` is synchronous.
 *
 * The `rebase` strategy rebases a temporary branch, so the source ref never changes.
 * The executor rollback resets the checked-out branch. If the source branch is checked out at rollback, the reset moves the source to the target SHA.
 * When a step of the rebase path fails, it aborts any rebase and checks out the target before it throws. The rollback then resets the correct ref.
 * It always checks out the target before it deletes the temporary branch, because `git branch -D` on the current branch fails.
 */
export function buildLocalGitMergeAdapter(
  gitExec: GitExec,
  repoRoot: string,
): LocalGitMergeAdapter {
  return async ({ sourceBranch, targetBranch, strategy }) => {
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
        const tmpBranch = `__exarchos_merge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          gitOrThrow(gitExec, repoRoot, ['checkout', '-b', tmpBranch, sourceBranch]);
          gitOrThrow(gitExec, repoRoot, ['rebase', targetBranch]);
          gitOrThrow(gitExec, repoRoot, ['checkout', targetBranch]);
          gitOrThrow(gitExec, repoRoot, ['merge', '--ff-only', tmpBranch]);
        } catch (err) {
          gitExec(repoRoot, ['rebase', '--abort']);
          gitExec(repoRoot, ['checkout', targetBranch]);
          throw err;
        } finally {
          gitExec(repoRoot, ['checkout', targetBranch]);
          deleteBranchForce((argv) => gitExec(repoRoot, argv), tmpBranch);
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
