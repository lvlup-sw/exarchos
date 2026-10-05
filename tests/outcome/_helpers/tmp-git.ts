import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

import { execFileAsync } from '../../../tools/test-helpers/spawn.js';

/**
 * Runs `git -C <repo> <args>` and returns stdout. It rejects on a non-zero exit. The arguments go
 * as an array, so no shell reads a path or a branch name.
 */
function git(repo: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', ['-C', repo, ...args]);
}

/**
 * Runs `fn` with a new git repo in a temp directory. The repo has `user.email` and `user.name` set,
 * a `main` branch, and one empty commit.
 *
 * After `fn` resolves or throws, the helper removes each sibling worktree first and then the repo,
 * so the worktree metadata stays clean. Cleanup is best-effort. A failure goes to stderr and does
 * not throw, so a leaked directory is visible.
 */
export async function withTmpGit<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-outcome-git-'));
  const siblings: string[] = [];
  const originalPush = siblings.push.bind(siblings);
  const tracker = {
    push: originalPush,
  };

  try {
    await execFileAsync('git', ['init', '-b', 'main', repo]);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await git(repo, ['commit', '--allow-empty', '-m', 'init']);

    SIBLING_REGISTRY.set(repo, tracker);

    return await fn(repo);
  } finally {
    for (const sib of siblings) {
      try {
        await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', sib]);
      } catch (error) {
        process.stderr.write(
          `[withTmpGit] worktree remove failed for ${sib}: ${(error as Error).message}\n`,
        );
      }
      try {
        rmrf(sib);
      } catch (error) {
        process.stderr.write(
          `[withTmpGit] rmSync failed for sibling ${sib}: ${(error as Error).message}\n`,
        );
      }
    }
    SIBLING_REGISTRY.delete(repo);
    try {
      rmrf(repo);
    } catch (error) {
      process.stderr.write(
        `[withTmpGit] rmSync failed for repo ${repo}: ${(error as Error).message}\n`,
      );
    }
  }
}

interface SiblingTracker {
  push: (value: string) => number;
}

/**
 * Maps a repo path to the tracker of its sibling worktrees, for the whole process.
 * `addSiblingWorktree` records each sibling here, so `withTmpGit` can remove it and the caller
 * passes no extra state.
 */
const SIBLING_REGISTRY = new Map<string, SiblingTracker>();

/**
 * Adds a worktree of `repoPath` on the new branch `branchName` and returns its absolute path. The
 * worktree is a sibling directory of the repo, at `<repoPath>-wt-<branchName>`.
 *
 * A branch name can hold a slash, which puts the worktree in a subdirectory. The function creates
 * the parent directory first, so the result does not depend on the git version.
 */
export async function addSiblingWorktree(
  repoPath: string,
  branchName: string,
): Promise<string> {
  const sibling = `${repoPath}-wt-${branchName}`;
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', sibling, '-b', branchName]);
  const tracker = SIBLING_REGISTRY.get(repoPath);
  if (tracker) tracker.push(sibling);
  return sibling;
}
