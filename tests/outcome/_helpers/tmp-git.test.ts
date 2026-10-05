import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { withTmpGit, addSiblingWorktree } from './tmp-git.js';

describe('withTmpGit', () => {
  /** The helper must also remove the repo directory after the callback returns. */
  it('TmpGit_InitsRepo_HasGitDir', async () => {
    let observedRepo: string | undefined;
    await withTmpGit(async (repo) => {
      observedRepo = repo;
      expect(path.isAbsolute(repo)).toBe(true);
      expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    });
    expect(fs.existsSync(observedRepo as string)).toBe(false);
  });

  /**
   * The sibling must be outside the `.git` directory. `git worktree list --porcelain` separates its
   * entries with a blank line, and must show two: the repo and the sibling.
   */
  it('TmpGit_AddSiblingWorktree_TargetCheckedOutElsewhere', async () => {
    await withTmpGit(async (repo) => {
      const sibling = await addSiblingWorktree(repo, 'integration');
      expect(path.isAbsolute(sibling)).toBe(true);
      expect(sibling.startsWith(path.join(repo, '.git'))).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);

      const porcelain = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repo,
      });
      const entries = porcelain
        .split(/\n\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(entries.length).toBe(2);
    });
  });
});
