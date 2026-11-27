import { describe, it, expect, afterEach } from 'vitest';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CheckPolishScopeResult } from '../../../../src/verbs/gates/check-polish-scope.js';
import { handleCheckPolishScope } from '../../../../src/verbs/gates/check-polish-scope.js';
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

/** Write each named file under `dir`, with its directories, and commit them. */
async function commitFiles(dir: string, files: readonly string[], message: string): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), `${message} ${file}\n`);
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}

/**
 * A repository whose `main` holds `existing`, with a checked-out `task` branch that changes `changed`.
 * `main` then advances with a change outside the task, so only a merge-base read sees the task alone.
 */
async function scopeRepo(changed: readonly string[], existing: readonly string[] = []): Promise<{ readonly root: string; readonly repo: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'polish-scope-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await commitFiles(repo, ['README.md', ...existing], 'base');
  await git(repo, 'checkout', '-q', '-b', 'task');
  await commitFiles(repo, changed, 'task');
  await git(repo, 'checkout', '-q', 'main');
  await commitFiles(repo, ['docs/after-the-fork.md'], 'advance');
  await git(repo, 'checkout', '-q', 'task');
  return { root, repo };
}

describe('Check Polish Scope', () => {
  it('under limits — 3 files, 1 module → scopeOk: true', async () => {
    const { repo } = await scopeRepo(['src/foo.ts', 'src/bar.ts', 'src/baz.ts'], ['src/foo.test.ts', 'src/bar.test.ts', 'src/baz.test.ts']);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(true);
    expect(data.fileCount).toBe(3);
    expect(data.moduleCount).toBe(1);
    expect(data.triggers).toHaveLength(0);
    expect(data.checks.every((c) => c.passed)).toBe(true);
    expect(data.report).toContain('SCOPE OK');
  });

  it('file count exceeds 5 → scopeOk: false', async () => {
    const { repo } = await scopeRepo(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.fileCount).toBe(6);
    expect(data.triggers).toContain('File count (6) exceeds limit of 5');
    expect(data.report).toContain('SCOPE EXPANDED');
  });

  it('module boundaries crossed (>2 dirs) → scopeOk: false', async () => {
    const { repo } = await scopeRepo(['src/a.ts', 'lib/b.ts', 'tests/c.ts']);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.moduleCount).toBe(3);
    expect(data.triggers.some((t) => t.includes('Module boundaries crossed'))).toBe(true);
  });

  it('missing test files → scopeOk: false', async () => {
    const { repo } = await scopeRepo(['src/foo.ts', 'src/bar.ts'], ['src/foo.test.ts']);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.triggers.some((t) => t.includes('New test files needed for 1 files'))).toBe(true);
  });

  it('architectural docs needed — structural files across >1 module → scopeOk: false', async () => {
    const { repo } = await scopeRepo(['src/index.ts', 'lib/utils.ts']);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.triggers.some((t) => t.includes('Architectural documentation needed'))).toBe(true);
  });

  it('multiple triggers fire together', async () => {
    const { repo } = await scopeRepo(['src/a.ts', 'src/b.ts', 'lib/c.ts', 'tests/d.ts', 'pkg/e.ts', 'pkg/index.ts']);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.fileCount).toBe(6);
    expect(data.moduleCount).toBe(4);
    expect(data.triggers.length).toBeGreaterThanOrEqual(3);
    expect(data.triggers.some((t) => t.includes('File count'))).toBe(true);
    expect(data.triggers.some((t) => t.includes('Module boundaries'))).toBe(true);
    expect(data.triggers.some((t) => t.includes('test files needed'))).toBe(true);
    expect(data.triggers.some((t) => t.includes('Architectural documentation'))).toBe(true);
  });

  it('empty diff → scopeOk: true', async () => {
    const { repo } = await scopeRepo([]);

    const result = await handleCheckPolishScope({ repoRoot: repo });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(true);
    expect(data.fileCount).toBe(0);
    expect(data.moduleCount).toBe(0);
    expect(data.triggers).toHaveLength(0);
  });

  /** An unknown base name and a path outside any checkout give DIFF_FAILED with the base and the path, and no data. */
  it('both git diff attempts fail → DIFF_FAILED error', async () => {
    const { root, repo } = await scopeRepo(['src/foo.ts']);
    const outside = join(root, 'outside');
    await mkdir(outside);

    for (const result of [
      await handleCheckPolishScope({ repoRoot: repo, baseBranch: 'no-such-branch' }),
      await handleCheckPolishScope({ repoRoot: outside }),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_FAILED');
      expect(result.data).toBeUndefined();
    }
    const outsideResult = await handleCheckPolishScope({ repoRoot: outside });
    expect(outsideResult.error?.message).toContain('main');
    expect(outsideResult.error?.message).toContain(outside);
  });

  /** With no base name, the diff reads from the merge base of `main`. A base at the task head gives an empty diff. */
  it('default baseBranch is "main"', async () => {
    const { repo } = await scopeRepo(['src/foo.ts']);
    await git(repo, 'branch', 'develop', 'task');

    const byDefault = await handleCheckPolishScope({ repoRoot: repo });
    const fromDevelop = await handleCheckPolishScope({ repoRoot: repo, baseBranch: 'develop' });

    expect((byDefault.data as CheckPolishScopeResult).fileCount).toBe(1);
    expect((byDefault.data as CheckPolishScopeResult).report).toContain('**Base branch:** main');
    expect((fromDevelop.data as CheckPolishScopeResult).fileCount).toBe(0);
  });

  /** A refused storage check, an extra extension key and an unusable Git path give DIFF_FAILED, never an empty list. */
  it('CheckPolishScope_UnreadableChecksAndGitPath_GiveDiffFailed', async () => {
    const { root, repo } = await scopeRepo(['src/foo.ts']);
    expect((await handleCheckPolishScope({ repoRoot: repo }, join(root, 'no-git'))).error?.code).toBe('DIFF_FAILED');
    await git(repo, 'config', 'extensions.worktreeConfig', 'true');
    await git(repo, 'config', 'extensions.partialClone', 'origin');
    expect((await handleCheckPolishScope({ repoRoot: repo })).error?.code).toBe('DIFF_FAILED');
    await git(repo, 'config', '--unset', 'extensions.partialClone');
    expect((await handleCheckPolishScope({ repoRoot: repo })).success).toBe(true);
    await git(repo, 'config', 'includeIf.gitdir:/.path', '/untrusted/config');
    expect((await handleCheckPolishScope({ repoRoot: repo })).error?.code).toBe('DIFF_FAILED');
  });

  /** A base with no common history gives a decided "no merge base", so the read diffs the base directly against the head. */
  it('CheckPolishScope_UnrelatedBase_ReadsFromTheBaseDirectly', async () => {
    const { repo } = await scopeRepo(['src/foo.ts']);
    await git(repo, 'checkout', '-q', '--orphan', 'unrelated');
    await git(repo, 'rm', '-rqf', '.');
    await commitFiles(repo, ['other/x.ts'], 'unrelated');
    await git(repo, 'checkout', '-q', 'task');

    const result = await handleCheckPolishScope({ repoRoot: repo, baseBranch: 'unrelated' });

    expect(result.success).toBe(true);
    expect((result.data as CheckPolishScopeResult).fileCount).toBe(3);
  });
});
