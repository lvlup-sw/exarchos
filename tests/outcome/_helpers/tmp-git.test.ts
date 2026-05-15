import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTmpGit, addSiblingWorktree } from './tmp-git.js';

describe('withTmpGit', () => {
  it('TmpGit_InitsRepo_HasGitDir', async () => {
    let observedRepo: string | undefined;
    await withTmpGit(async (repo) => {
      observedRepo = repo;
      expect(path.isAbsolute(repo)).toBe(true);
      expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    });
    // cleanup: tmpdir removed
    expect(fs.existsSync(observedRepo as string)).toBe(false);
  });

  it('TmpGit_AddSiblingWorktree_TargetCheckedOutElsewhere', async () => {
    await withTmpGit(async (repo) => {
      const sibling = await addSiblingWorktree(repo, 'integration');
      expect(path.isAbsolute(sibling)).toBe(true);
      // Sibling must live outside the .git/ tree.
      expect(sibling.startsWith(path.join(repo, '.git'))).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);

      const porcelain = execSync('git worktree list --porcelain', {
        cwd: repo,
        encoding: 'utf8',
      });
      // Two entries: main repo + sibling. Each entry starts with `worktree <path>`.
      const entries = porcelain
        .split(/\n\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(entries.length).toBe(2);
    });
  });
});
