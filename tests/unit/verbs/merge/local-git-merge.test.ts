// ─── Local Git Merge Adapter — integration tests against real temp git repos ──
//
// DR-MO-2 / #1194 — `merge_orchestrate` is a *local* SDLC handoff: it lands a
// subagent worktree's branch onto the integration branch via `git merge`, with
// a recorded rollback sha so a `git reset --hard` actually undoes the merge.
//
// These tests exercise the production adapter against a real `git init`
// temp repo so we verify the merge commit actually lands (and rolls back).
// The pure executor + DI'd vcsMerge story is covered by
// `pure/execute-merge.test.ts`; this file covers the production wiring.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildLocalGitMergeAdapter,
  type LocalGitMergeAdapter,
} from '../../../../src/verbs/merge/local-git-merge.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/**
 * Build a git repo with two divergent branches:
 *   main: A → B
 *   feat: A → C
 * `feat` is set up so that `git merge feat` from `main` produces a clean
 * merge commit (no conflict) by touching different files.
 */
async function setupDivergentRepo(): Promise<{ repoRoot: string; mainHead: string; featHead: string }> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'local-git-merge-'));
  // identity required by `git commit`
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(path.join(repoRoot, 'a.txt'), 'A\n');
  await git(repoRoot, ['add', 'a.txt']);
  await git(repoRoot, ['commit', '-m', 'A', '-q']);

  // feat branches off A, adds C.
  await git(repoRoot, ['checkout', '-b', 'feat', '-q']);
  writeFileSync(path.join(repoRoot, 'c.txt'), 'C\n');
  await git(repoRoot, ['add', 'c.txt']);
  await git(repoRoot, ['commit', '-m', 'C', '-q']);
  const featHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

  // main advances with B.
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

// Adapter uses the same `gitExec` shape the pure executor expects.
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('buildLocalGitMergeAdapter', () => {
  let cleanup: string[] = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(() => {
    for (const dir of cleanup) {
      rmSync(dir, { recursive: true, force: true });
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

      // The new HEAD is a merge commit with two parents: mainHead and featHead.
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

      // Squash merge produces a single-parent commit on top of mainHead.
      const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', result.mergeSha]))
        .trim()
        .split(' ');
      expect(parents.length).toBe(2);
      expect(parents[1]).toBe(mainHead);

      // The squash commit must include feat's changes (c.txt).
      const fileList = await git(repoRoot, ['ls-tree', '-r', '--name-only', result.mergeSha]);
      expect(fileList).toMatch(/c\.txt/);
    });
  });

  describe('strategy=rebase', () => {
    it('localMergeAdapter_Rebase_LinearHistory_NoMergeCommit', async () => {
      const { repoRoot, mainHead } = await setupDivergentRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      const result = await adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'rebase' });

      // After rebase + ff-merge, the resulting HEAD has a single parent
      // (the rebased source commit's parent chain ends at mainHead).
      const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', result.mergeSha]))
        .trim()
        .split(' ');
      expect(parents.length).toBe(2); // single parent → linear

      // mainHead must be reachable from the new HEAD (no rewrite of main).
      const reachable = await git(repoRoot, ['merge-base', '--is-ancestor', mainHead, result.mergeSha]);
      // exit 0 = ancestor; we just need this to not have thrown
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

    it('localMergeAdapter_MergeConflict_ThrowsAndLeavesNoCommit', async () => {
      const { repoRoot } = await setupConflictRepo();
      cleanup.push(repoRoot);
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      const before = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

      await expect(
        adapter({ sourceBranch: 'feat', targetBranch: 'main', strategy: 'merge' }),
      ).rejects.toThrow(/merge|conflict/i);

      // Caller (executor) is responsible for `git reset --hard <rollbackSha>`.
      // Adapter must leave HEAD where it found it (or in mid-merge state) so
      // the executor's reset does meaningful work. We assert that HEAD is
      // still resolvable (no detached/corrupt state).
      const after = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
      expect(after).toBeTruthy();
      // In conflict state, HEAD has not advanced past `before`.
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
    it('localMergeAdapter_MergeFails_ExecutorResetsToRollbackSha_HeadRestored', async () => {
      // Integration: this is the test that asserts the rollback machinery
      // actually undoes a real local merge — the dead-rollback bug #1194 was
      // about. Wire the adapter through executeMerge with a real repo and
      // confirm git reset restores HEAD after the rollback path runs.
      const { repoRoot } = await setupConflictRepo();
      cleanup.push(repoRoot);

      const { executeMerge } = await import('../../../../src/verbs/pure/execute-merge.js');
      const adapter = buildLocalGitMergeAdapter(realGitExec, repoRoot);

      // Caller must be on target before invoking the executor (precondition
      // documented on the adapter). #1194 follow-up may move this checkout
      // into the handler.
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
