// Integration tests for the local git merge adapter, against real temporary git repositories.
// `merge_orchestrate` lands the branch of a subagent worktree onto the integration branch with a
// local `git merge`. The tests check that the merge commit lands and that the executor rollback undoes it.
// `pure/execute-merge.test.ts` covers the pure executor with an injected `vcsMerge`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildLocalGitMergeAdapter,
  type LocalGitMergeAdapter,
} from '../../../../src/verbs/merge/local-git-merge.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';


function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/**
 * Builds a repo with two divergent branches:
 *   main: A → B
 *   feat: A → C
 * The branches touch different files, so `git merge feat` from `main` gives a clean merge commit.
 * The repo sets a commit identity, because `git commit` requires one.
 */
async function setupDivergentRepo(): Promise<{ repoRoot: string; mainHead: string; featHead: string }> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'local-git-merge-'));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(path.join(repoRoot, 'a.txt'), 'A\n');
  await git(repoRoot, ['add', 'a.txt']);
  await git(repoRoot, ['commit', '-m', 'A', '-q']);

  await git(repoRoot, ['checkout', '-b', 'feat', '-q']);
  writeFileSync(path.join(repoRoot, 'c.txt'), 'C\n');
  await git(repoRoot, ['add', 'c.txt']);
  await git(repoRoot, ['commit', '-m', 'C', '-q']);
  const featHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

  await git(repoRoot, ['checkout', 'main', '-q']);
  writeFileSync(path.join(repoRoot, 'b.txt'), 'B\n');
  await git(repoRoot, ['add', 'b.txt']);
  await git(repoRoot, ['commit', '-m', 'B', '-q']);
  const mainHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

  return { repoRoot, mainHead, featHead };
}

async function setupConflictRepo(): Promise<{ repoRoot: string }> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'local-git-merge-conflict-'));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(path.join(repoRoot, 'shared.txt'), 'original\n');
  await git(repoRoot, ['add', 'shared.txt']);
  await git(repoRoot, ['commit', '-m', 'init', '-q']);

  await git(repoRoot, ['checkout', '-b', 'feat', '-q']);
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'feat-version\n');
  await git(repoRoot, ['add', 'shared.txt']);
  await git(repoRoot, ['commit', '-m', 'feat edit', '-q']);

  await git(repoRoot, ['checkout', 'main', '-q']);
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'main-version\n');
  await git(repoRoot, ['add', 'shared.txt']);
  await git(repoRoot, ['commit', '-m', 'main edit', '-q']);

  return { repoRoot };
}

/** A real `gitExec` with the shape that the pure executor expects. */
const realGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return { stdout: '', exitCode: typeof status === 'number' ? status : 1 };
  }
};

describe('buildLocalGitMergeAdapter', () => {
  let cleanup: string[] = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(() => {
    for (const dir of cleanup) {
      rmrf(dir);
    }
  });

  describe('strategy=merge', () => {
    it('localMergeAdapter_NoFfMerge_ProducesMergeCommitWithTwoParents', async () => {
      const { repoRoot, mainHead, featHead } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter: LocalGitMergeAdapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      const result = await adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'merge' });

      expect(result.mergeSha).toBeTruthy();
      expect(result.mergeSha).toHaveLength(40);

      const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', result.mergeSha]))
        .trim()
        .split(' ');
      expect(parents.length).toBe(3);
      expect(parents[1]).toBe(mainHead);
      expect(parents[2]).toBe(featHead);
    });

    it('localMergeAdapter_LeavesCallerOnTargetBranch', async () => {
      const { repoRoot } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      await adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'merge' });

      const currentBranch = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      expect(currentBranch).toBe('main');
    });
  });

  describe('strategy=squash', () => {
    it('localMergeAdapter_Squash_ProducesSingleParentCommitWithFeatChanges', async () => {
      const { repoRoot, mainHead } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      const result = await adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'squash' });

      const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', result.mergeSha]))
        .trim()
        .split(' ');
      expect(parents.length).toBe(2);
      expect(parents[1]).toBe(mainHead);

      const fileList = await git(repoRoot, ['ls-tree', '-r', '--name-only', result.mergeSha]);
      expect(fileList).toMatch(/c\.txt/);
    });
  });

  describe('strategy=rebase', () => {
    /**
     * After the rebase and fast-forward, HEAD has one parent, and `mainHead` stays an ancestor of HEAD.
     * The `git` helper throws on a non-zero exit, so an empty result from `merge-base --is-ancestor` means success.
     */
    it('localMergeAdapter_Rebase_LinearHistory_NoMergeCommit', async () => {
      const { repoRoot, mainHead } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      const result = await adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'rebase' });

      const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', result.mergeSha]))
        .trim()
        .split(' ');
      expect(parents.length).toBe(2);

      const reachable = await git(repoRoot, ['merge-base', '--is-ancestor', mainHead, result.mergeSha]);
      expect(reachable).toBe('');
    });
  });

  describe('failure modes', () => {
    it('localMergeAdapter_TargetBranchMissing_Throws', async () => {
      const { repoRoot } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      await expect(
        adapter({ sourceBranch: 'feat', targetBranch: 'no-such-branch', strategy: 'merge' }),
      ).rejects.toThrow(/checkout.*no-such-branch/i);
    });

    /**
     * The executor runs `git reset --keep <rollbackSha>`, not the adapter.
     * After a conflict, HEAD stays resolvable and does not move past its value before the merge.
     */
    it('localMergeAdapter_MergeConflict_ThrowsAndLeavesNoCommit', async () => {
      const { repoRoot } = await setupConflictRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      const before = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

      await expect(
        adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'merge' }),
      ).rejects.toThrow(/merge|conflict/i);

      const after = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
      expect(after).toBeTruthy();
      expect(after).toBe(before);
    });

    it('localMergeAdapter_SourceBranchMissing_Throws', async () => {
      const { repoRoot } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      await expect(
        adapter({ sourceBranch: 'no-such-source', targetBranch: 'main', strategy: 'merge' }),
      ).rejects.toThrow(/no-such-source|merge/i);
    });
  });

  describe('end-to-end with executor rollback', () => {
    /**
     * The adapter runs through `executeMerge` against a real repo, and the rollback restores HEAD.
     * The test checks out the target first, so the recovery point that the executor reads is the target HEAD.
     */
    it('localMergeAdapter_MergeFails_ExecutorResetsToRollbackSha_HeadRestored', async () => {
      const { repoRoot } = await setupConflictRepo();
      cleanup.push(repoRoot);

      const { executeMerge } = await import('../../../../src/verbs/pure/execute-merge.js');
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      await git(repoRoot, ['checkout', 'main', '-q']);
      const before = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

      const result = await executeMerge({
        sourceBranch: 'feat',
        targetBranch: 'main',
        strategy: 'merge',
        gitExec: realGitExec,
        vcsMerge: adapter,
        persistState: async () => {},
        repoRoot,
      });

      expect(result.phase).toBe('rolled-back');
      const after = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
      expect(after).toBe(before);
    });
  });
});
