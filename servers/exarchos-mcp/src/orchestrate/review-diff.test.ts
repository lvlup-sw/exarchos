import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn() },
  existsSync: vi.fn(),
}));

import { handleReviewDiff } from './review-diff.js';

describe('handleReviewDiff', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handleReviewDiff_ValidWorktree_ReturnsFormattedDiff', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // git rev-parse --git-dir (verify git repo)
    vi.mocked(execFileSync)
      .mockReturnValueOnce('.git\n')
      // git branch --show-current
      .mockReturnValueOnce('feature/my-branch\n')
      // git diff ...HEAD --stat (three-dot stat)
      .mockReturnValueOnce(' src/foo.ts | 10 ++++\n src/bar.ts | 5 ++---\n 2 files changed, 7 insertions(+), 3 deletions(-)\n')
      // git diff ...HEAD --name-only (three-dot name-only)
      .mockReturnValueOnce('src/foo.ts\nsrc/bar.ts\n')
      // git diff ...HEAD --unified=3 (three-dot unified)
      .mockReturnValueOnce('diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n+added line\n');

    const result = await handleReviewDiff(
      { worktreePath: '/my/worktree', baseBranch: 'develop' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as { diff: string; filesChanged: number; report: string };
    expect(data.filesChanged).toBe(2);
    expect(data.report).toContain('## Review Diff');
    expect(data.report).toContain('**Worktree:** /my/worktree');
    expect(data.report).toContain('**Branch:** feature/my-branch');
    expect(data.report).toContain('**Base:** develop');
    expect(data.report).toContain('### Changed Files');
    expect(data.report).toContain('### Files Modified');
    expect(data.report).toContain('- `src/foo.ts`');
    expect(data.report).toContain('- `src/bar.ts`');
    expect(data.report).toContain('### Diff Content');
    expect(data.report).toContain('```diff');
    expect(data.diff).toContain('diff --git');
  });

  it('handleReviewDiff_MissingWorktree_ReturnsError', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await handleReviewDiff(
      { worktreePath: '/nonexistent/path' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Directory not found'),
    });
  });

  it('handleReviewDiff_NotGitRepo_ReturnsError', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = await handleReviewDiff(
      { worktreePath: '/not/a/repo' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'NOT_GIT_REPO',
      message: expect.stringContaining('Not a git repository'),
    });
  });

  it('handleReviewDiff_ThreeDotFails_FallsBackToTwoDot', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    let callCount = 0;
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      callCount++;
      const argsArr = args as string[];

      // git rev-parse --git-dir
      if (argsArr[0] === 'rev-parse') return '.git\n';
      // git branch --show-current
      if (argsArr[0] === 'branch') return 'my-branch\n';

      // For diff commands: three-dot fails, two-dot succeeds
      if (argsArr[0] === 'diff') {
        const diffSpec = argsArr[1] as string;
        if (diffSpec.includes('...')) {
          throw new Error('unknown revision');
        }
        // Two-dot fallback succeeds
        if (argsArr.includes('--stat')) return ' file.ts | 1 +\n 1 file changed\n';
        if (argsArr.includes('--name-only')) return 'file.ts\n';
        if (argsArr.includes('--unified=3')) return 'diff content\n';
      }

      return '';
    });

    const result = await handleReviewDiff(
      { worktreePath: '/my/worktree', baseBranch: 'main' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as { filesChanged: number; report: string };
    expect(data.filesChanged).toBe(1);
    expect(data.report).toContain('file.ts');
  });

  it('handleReviewDiff_EmptyDiff_ReturnsNoDiff', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockReturnValueOnce('.git\n')      // rev-parse
      .mockReturnValueOnce('main\n')      // branch
      .mockReturnValueOnce('')            // stat (empty)
      .mockReturnValueOnce('')            // name-only (empty)
      .mockReturnValueOnce('');           // unified (empty)

    const result = await handleReviewDiff(
      { worktreePath: '/my/worktree' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as { filesChanged: number; report: string; diff: string };
    expect(data.filesChanged).toBe(0);
    expect(data.report).toContain('No changes');
  });

  it('handleReviewDiff_DefaultsToMainAndCwd', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockReturnValueOnce('.git\n')
      .mockReturnValueOnce('feature\n')
      .mockReturnValueOnce(' x.ts | 1 +\n')
      .mockReturnValueOnce('x.ts\n')
      .mockReturnValueOnce('diff\n');

    const result = await handleReviewDiff({}, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('**Base:** main');
    // Verify cwd was used by checking execFileSync was called with cwd: process.cwd()
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      expect.anything(),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});
