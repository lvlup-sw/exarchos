import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function git(repo: string, args: string): string {
  return execSync(`git -C "${repo}" ${args}`, { encoding: 'utf8' });
}

/**
 * Run `fn` with a freshly-initialized git repo at a tmpdir. The repo has a
 * configured `user.email`/`user.name`, a `main` branch, and a single empty
 * initial commit. The tmpdir (plus any sibling worktrees added via
 * `addSiblingWorktree`) is removed after `fn` resolves or throws.
 */
export async function withTmpGit<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-outcome-git-'));
  const siblings: string[] = [];
  // Track siblings created during the callback so cleanup is exhaustive.
  const originalPush = siblings.push.bind(siblings);
  const tracker = {
    push: originalPush,
  };

  try {
    execSync(`git init -b main "${repo}"`, { encoding: 'utf8' });
    git(repo, 'config user.email test@example.com');
    git(repo, 'config user.name test');
    git(repo, 'commit --allow-empty -m "init"');

    // Stash tracker on a process-wide map keyed by repo path so
    // `addSiblingWorktree` can register cleanups without callers threading
    // state.
    SIBLING_REGISTRY.set(repo, tracker);

    return await fn(repo);
  } finally {
    // Remove any sibling worktrees first so `git worktree` metadata is clean.
    for (const sib of siblings) {
      try {
        execSync(`git -C "${repo}" worktree remove --force "${sib}"`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        // best-effort
      }
      try {
        fs.rmSync(sib, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    SIBLING_REGISTRY.delete(repo);
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

interface SiblingTracker {
  push: (value: string) => number;
}

const SIBLING_REGISTRY = new Map<string, SiblingTracker>();

/**
 * Create a sibling worktree of `repoPath` checked out on a new branch
 * `branchName`. The sibling lives outside `repoPath/.git` so `git worktree
 * remove` works cleanly. Returns the absolute path of the new worktree.
 */
export async function addSiblingWorktree(
  repoPath: string,
  branchName: string,
): Promise<string> {
  const sibling = `${repoPath}-wt-${branchName}`;
  execSync(`git -C "${repoPath}" worktree add "${sibling}" -b "${branchName}"`, {
    encoding: 'utf8',
  });
  const tracker = SIBLING_REGISTRY.get(repoPath);
  if (tracker) tracker.push(sibling);
  return sibling;
}
