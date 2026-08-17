import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(), statSync: vi.fn() },
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

import { handleReviewDiff, REVIEW_DIFF_CAPS } from '../../../../src/verbs/review/review-diff.js';

/**
 * Build a synthetic unified diff with `files` files × `hunksPerFile` hunks.
 * When `uniqueMarkers` is true, each hunk's added line carries a globally
 * unique marker (`HUNK_MARKER_<i>`) so a test can count how many times any
 * single hunk's text appears across the whole response.
 */
function makeLargeDiff(
  files: number,
  hunksPerFile: number,
  uniqueMarkers = false,
): { diff: string; stat: string; nameOnly: string; markers: string[] } {
  const fileNames: string[] = [];
  const diffParts: string[] = [];
  const statParts: string[] = [];
  const markers: string[] = [];
  let hunkIndex = 0;
  for (let f = 0; f < files; f++) {
    const file = `src/module${f}.ts`;
    fileNames.push(file);
    diffParts.push(`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`);
    for (let h = 0; h < hunksPerFile; h++) {
      const line = 1 + h * 20;
      // Angle-bracket boundaries so `<HUNK_MARKER_1>` is not a substring of
      // `<HUNK_MARKER_10>` — the occurrence-count assertion relies on this.
      const marker = uniqueMarkers ? `<HUNK_MARKER_${hunkIndex}>` : `ADDED_${f}_${h}`;
      markers.push(marker);
      diffParts.push(
        `@@ -${line},3 +${line},4 @@`,
        ` ctx ${f}-${h}`,
        `+${marker}`,
        ` end ${f}-${h}`,
      );
      hunkIndex++;
    }
    statParts.push(` ${file} | ${hunksPerFile * 2} +`);
  }
  return {
    diff: diffParts.join('\n') + '\n',
    stat: statParts.join('\n') + `\n ${files} files changed\n`,
    nameOnly: fileNames.join('\n') + '\n',
    markers,
  };
}

/** Wire up mocks for a successful review_diff over the given fixture. */
function mockDiff(fixture: { diff: string; stat: string; nameOnly: string }): void {
  vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats);
  vi.mocked(execFileSync)
    .mockReturnValueOnce('.git\n') // rev-parse --git-dir
    .mockReturnValueOnce('feature/big\n') // branch --show-current
    .mockReturnValueOnce(fixture.stat) // diff --stat
    .mockReturnValueOnce(fixture.nameOnly) // diff --name-only
    .mockReturnValueOnce(fixture.diff); // diff --unified=3
}

describe('handleReviewDiff', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handleReviewDiff_ValidWorktree_ReturnsFormattedDiff', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats);

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
    // The raw diff lives ONLY in data.diff — the report must not re-embed it.
    expect(data.diff).toContain('diff --git');
    expect(data.report).not.toContain('added line');
    expect(data.report).not.toContain('```diff');
  });

  it('handleReviewDiff_MissingWorktree_ReturnsError', async () => {
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });

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

  it('handleReviewDiff_FileNotDirectory_ReturnsError', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as unknown as fs.Stats);

    const result = await handleReviewDiff(
      { worktreePath: '/some/file.txt' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Not a directory'),
    });
  });

  it('handleReviewDiff_NotGitRepo_ReturnsError', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats);
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
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats);

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
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats);
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
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats);
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

  it('reviewDiff_LargeDiff_EmbedsEachHunkAtMostOnce', async () => {
    // 60 hunks across 6 files, each with a globally-unique added-line marker.
    const fixture = makeLargeDiff(6, 10, /* uniqueMarkers */ true);
    mockDiff(fixture);

    const result = await handleReviewDiff(
      { worktreePath: '/big/worktree', baseBranch: 'main' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);

    // The double-embed is gone: no hunk's unique text appears more than once
    // anywhere in the response (data.diff + data.report combined).
    for (const marker of fixture.markers) {
      const occurrences = serialized.split(marker).length - 1;
      expect(occurrences, `marker ${marker} appeared ${occurrences} times`).toBeLessThanOrEqual(1);
    }

    // Sanity: the diff is actually embedded once (not simply dropped wholesale).
    const data = result.data as { diff: string; hunksTotal: number };
    expect(data.diff).toContain(fixture.markers[0]);
    expect(data.hunksTotal).toBe(60);
  });

  it('reviewDiff_LargeDiffFixture_StaysUnderBudget', async () => {
    // A very large diff: 20 files × 30 hunks = 600 hunks.
    const fixture = makeLargeDiff(20, 30);
    mockDiff(fixture);

    const result = await handleReviewDiff(
      { worktreePath: '/big/worktree', baseBranch: 'main' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diff: string;
      truncated: boolean;
      hunksTotal: number;
      hunksReturned: number;
      report: string;
    };

    // The embedded diff is capped to the contract's bounds.
    expect(data.hunksTotal).toBe(600);
    expect(data.truncated).toBe(true);
    expect(data.hunksReturned).toBe(REVIEW_DIFF_CAPS.maxHunks);
    expect(data.diff.length).toBeLessThanOrEqual(REVIEW_DIFF_CAPS.maxChars);

    // Report carries a steering hint to the uncapped path, but not the diff.
    expect(data.report).toContain('git diff main...HEAD');
    expect(data.report).not.toContain('```diff');

    // Whole-response budget: without capping + single-copy, a 600-hunk diff
    // embedded twice blows well past this ceiling.
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(REVIEW_DIFF_CAPS.maxChars + 10_000);
  });
});
