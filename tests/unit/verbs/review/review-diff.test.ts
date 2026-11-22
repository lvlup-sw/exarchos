import { describe, it, expect, afterEach } from 'vitest';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { handleReviewDiff, REVIEW_DIFF_CAPS } from '../../../../src/verbs/review/review-diff.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The absolute real path of the fixture Git on the test process PATH. */
function fixtureGit(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { continue; }
  }
  throw new Error('The fixture needs Git on PATH');
}

const GIT = fixtureGit();

/** The fixture Git environment: no global or system configuration and a fixed identity. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** Fixture Git in `cwd` through the absolute executable. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', cwd, ...args], { env: GIT_ENV, timeout: 30_000 })).trim();
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** Write each file under `dir`, with its directories, and commit them. */
async function commit(dir: string, files: Readonly<Record<string, string>>, message: string): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}

/**
 * A repository whose `main` holds `base`, with a checked-out `branch` that commits `changed`.
 * `main` then advances outside the task, so only a merge-base read sees the task alone.
 */
async function reviewRepo(
  base: Readonly<Record<string, string>>,
  changed: Readonly<Record<string, string>>,
  branch = 'feature/my-branch',
): Promise<{ readonly root: string; readonly repo: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'review-diff-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await commit(repo, { 'README.md': '# fixture\n', ...base }, 'base');
  await git(repo, 'checkout', '-q', '-b', branch);
  await commit(repo, changed, 'task');
  await git(repo, 'checkout', '-q', 'main');
  await commit(repo, { 'docs/after-the-fork.md': 'main only\n' }, 'advance');
  await git(repo, 'checkout', '-q', branch);
  return { root, repo };
}

/**
 * The base and changed text of `files` files with `hunksPerFile` separate hunks each.
 * With `uniqueMarkers`, the added line of each hunk carries a unique marker such as `<HUNK_MARKER_1>`.
 * The angle brackets stop one marker from matching inside another, so a test can count each hunk in the response.
 */
function largeFixture(files: number, hunksPerFile: number, uniqueMarkers = false): {
  readonly base: Record<string, string>; readonly changed: Record<string, string>; readonly markers: string[];
} {
  const base: Record<string, string> = {};
  const changed: Record<string, string> = {};
  const markers: string[] = [];
  let hunkIndex = 0;
  for (let f = 0; f < files; f++) {
    const lines = Array.from({ length: hunksPerFile * 20 }, (_, i) => `line ${f}-${i}`);
    const edited: string[] = [];
    for (const [i, line] of lines.entries()) {
      edited.push(line);
      if (i % 20 === 10) {
        const marker = uniqueMarkers ? `<HUNK_MARKER_${hunkIndex}>` : `ADDED_${f}_${i}`;
        markers.push(marker);
        edited.push(marker);
        hunkIndex++;
      }
    }
    base[`src/module${f}.ts`] = `${lines.join('\n')}\n`;
    changed[`src/module${f}.ts`] = `${edited.join('\n')}\n`;
  }
  return { base, changed, markers };
}

describe('handleReviewDiff', () => {
  const stateDir = '/tmp/test-state';

  /** The diff reads from the merge base of the base name. The raw diff appears only in `data.diff`, and the report does not embed it. */
  it('handleReviewDiff_ValidWorktree_ReturnsFormattedDiff', async () => {
    const { repo } = await reviewRepo({ 'src/bar.ts': 'one\ntwo\nthree\n' }, { 'src/foo.ts': 'added line\n', 'src/bar.ts': 'one\nTWO\nthree\n' });
    await git(repo, 'branch', 'develop', 'main~1');

    const result = await handleReviewDiff({ worktreePath: repo, baseBranch: 'develop' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { diff: string; filesChanged: number; report: string };
    expect(data.filesChanged).toBe(2);
    expect(data.report).toContain('## Review Diff');
    expect(data.report).toContain(`**Worktree:** ${repo}`);
    expect(data.report).toContain('**Branch:** feature/my-branch');
    expect(data.report).toContain('**Base:** develop');
    expect(data.report).toContain('### Changed Files');
    expect(data.report).toContain('2 files changed');
    expect(data.report).toContain('### Files Modified');
    expect(data.report).toContain('- `src/foo.ts`');
    expect(data.report).toContain('- `src/bar.ts`');
    expect(data.report).not.toContain('after-the-fork');
    expect(data.diff).toContain('diff --git');
    expect(data.report).not.toContain('added line');
    expect(data.report).not.toContain('```diff');
  });

  it('handleReviewDiff_MissingWorktree_ReturnsError', async () => {
    const result = await handleReviewDiff(
      { worktreePath: join(tmpdir(), 'review-diff-nonexistent', 'path') },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Directory not found'),
    });
  });

  it('handleReviewDiff_FileNotDirectory_ReturnsError', async () => {
    const { repo } = await reviewRepo({}, {});

    const result = await handleReviewDiff(
      { worktreePath: join(repo, 'README.md') },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Not a directory'),
    });
  });

  /** A path that the climb places in no checkout gives NOT_GIT_REPO. */
  it('handleReviewDiff_NotGitRepo_ReturnsError', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'review-diff-outside-')));
    roots.push(root);

    const result = await handleReviewDiff(
      { worktreePath: root },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'NOT_GIT_REPO',
      message: expect.stringContaining('Not a git repository'),
    });
  });

  /** A base with no common history gives a decided "no merge base", so each read diffs the base directly against the head. */
  it('handleReviewDiff_ThreeDotFails_FallsBackToTwoDot', async () => {
    const { repo } = await reviewRepo({}, { 'file.ts': 'one\n' });
    await git(repo, 'checkout', '-q', '--orphan', 'unrelated');
    await git(repo, 'rm', '-rqf', '.');
    await commit(repo, { 'other.ts': 'x\n' }, 'unrelated');
    await git(repo, 'checkout', '-q', 'feature/my-branch');

    const result = await handleReviewDiff(
      { worktreePath: repo, baseBranch: 'unrelated' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as { filesChanged: number; report: string };
    expect(data.filesChanged).toBe(3);
    expect(data.report).toContain('file.ts');
    expect(data.report).toContain('other.ts');
  });

  /** An empty task diff gives zero changed files and a `No changes` report. */
  it('handleReviewDiff_EmptyDiff_ReturnsNoDiff', async () => {
    const { repo } = await reviewRepo({}, {});

    const result = await handleReviewDiff(
      { worktreePath: repo },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as { filesChanged: number; report: string; diff: string };
    expect(data.filesChanged).toBe(0);
    expect(data.report).toContain('No changes');
  });

  /** With no arguments, the read climbs from the working directory and diffs against `main`. */
  it('handleReviewDiff_DefaultsToMainAndCwd', async () => {
    const { repo } = await reviewRepo({}, { 'x.ts': 'x\n' }, 'feature');
    await mkdir(join(repo, 'sub'));
    const previous = process.cwd();
    process.chdir(join(repo, 'sub'));
    let result: Awaited<ReturnType<typeof handleReviewDiff>>;
    try {
      result = await handleReviewDiff({}, stateDir);
    } finally {
      process.chdir(previous);
    }

    expect(result.success).toBe(true);
    const data = result.data as { report: string; filesChanged: number };
    expect(data.report).toContain('**Base:** main');
    expect(data.report).toContain('**Branch:** feature');
    expect(data.filesChanged).toBe(1);
  });

  /**
   * The fixture holds 60 hunks across 6 files, each with a unique marker.
   * No marker appears more than once in the serialized response, and the diff is still embedded.
   */
  it('reviewDiff_LargeDiff_EmbedsEachHunkAtMostOnce', async () => {
    const fixture = largeFixture(6, 10, true);
    const { repo } = await reviewRepo(fixture.base, fixture.changed);

    const result = await handleReviewDiff(
      { worktreePath: repo, baseBranch: 'main' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);

    for (const marker of fixture.markers) {
      const occurrences = serialized.split(marker).length - 1;
      expect(occurrences, `marker ${marker} appeared ${occurrences} times`).toBeLessThanOrEqual(1);
    }

    const data = result.data as { diff: string; hunksTotal: number };
    expect(data.diff).toContain(fixture.markers[0]);
    expect(data.hunksTotal).toBe(60);
  });

  /**
   * The fixture holds 600 hunks across 20 files. The embedded diff stays inside the caps.
   * The report points to the uncapped `git diff` command and does not embed the diff.
   * Without the cap and the single copy, the response goes far past the size ceiling.
   */
  it('reviewDiff_LargeDiffFixture_StaysUnderBudget', async () => {
    const fixture = largeFixture(20, 30);
    const { repo } = await reviewRepo(fixture.base, fixture.changed);

    const result = await handleReviewDiff(
      { worktreePath: repo, baseBranch: 'main' },
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

    expect(data.hunksTotal).toBe(600);
    expect(data.truncated).toBe(true);
    expect(data.hunksReturned).toBe(REVIEW_DIFF_CAPS.maxHunks);
    expect(data.diff.length).toBeLessThanOrEqual(REVIEW_DIFF_CAPS.maxChars);

    expect(data.report).toContain('git diff main...HEAD');
    expect(data.report).not.toContain('```diff');

    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(REVIEW_DIFF_CAPS.maxChars + 10_000);
  });

  /** A detached HEAD gives the empty branch name, as before. An unknown base, a tag base and an unusable Git path give DIFF_FAILED. */
  it('handleReviewDiff_DetachedUnknownBaseAndUnusableGit_KeepTheirOutcomes', async () => {
    const { root, repo } = await reviewRepo({}, { 'x.ts': 'x\n' });
    await git(repo, 'tag', 'only-a-tag', 'main');

    for (const result of [
      await handleReviewDiff({ worktreePath: repo, baseBranch: 'no-such-branch' }, stateDir),
      await handleReviewDiff({ worktreePath: repo, baseBranch: 'only-a-tag' }, stateDir),
      await handleReviewDiff({ worktreePath: repo }, stateDir, join(root, 'no-git')),
    ]) {
      expect(result.error?.code).toBe('DIFF_FAILED');
    }
    await git(repo, 'checkout', '-q', '--detach');
    const detached = await handleReviewDiff({ worktreePath: repo }, stateDir);
    expect(detached.success).toBe(true);
    expect((detached.data as { report: string }).report).toContain('**Branch:** \n');
  });

  /** A rename keeps the default rename detection, so the name list shows the new path once. */
  it('handleReviewDiff_Rename_KeepsRenameDetection', async () => {
    const { repo } = await reviewRepo({ 'src/old.ts': 'a\nb\nc\nd\ne\n' }, {});
    await git(repo, 'mv', 'src/old.ts', 'src/new.ts');
    await git(repo, 'commit', '-q', '-m', 'rename');

    const result = await handleReviewDiff({ worktreePath: repo }, stateDir);

    const data = result.data as { filesChanged: number; report: string };
    expect(data.filesChanged).toBe(1);
    expect(data.report).toContain('- `src/new.ts`');
    expect(data.report).not.toContain('- `src/old.ts`');
  });
});
