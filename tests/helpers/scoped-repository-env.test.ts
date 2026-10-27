/**
 * Tests that the scoped repository helper ignores an inherited repository location.
 *
 * A git hook sets `GIT_DIR` for the commands that it runs, so a test that a hook runs inherits it.
 * The case sets `GIT_DIR` to another repository, then builds a scoped repository and a worktree.
 * The reads of the case drop each `GIT_` variable, so they read the repository that they name.
 * The case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { toPosix } from '../../src/utils/paths.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository } from './scoped-repository.js';

/** The budget of the case. It spawns about twenty git processes. */
const CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/inherited-git-dir';

/** The fixture of the scoped repository. */
const FIXTURE = { 'package.json': '{ "name": "inherited-git-dir-fixture", "private": true }\n' };

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** The environment of the process with no `GIT_` variable, so a read names its repository with `-C` alone. */
function readEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return env;
}

/** Runs one git command in a repository and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args], { env: readEnvironment() })).trim();
}

/** Makes another repository with one commit on `main`, and deletes it after the case. */
async function otherRepository(): Promise<string> {
  const dir = makeTempDir('scoped-repository-env-other-');
  roots.push(dir);
  await git(dir, ['init', '-q', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), 'the other repository\n', 'utf-8');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-q', '-m', 'the commit of the other repository']);
  return dir;
}

/** Each ref of a repository with its commit, the commit count of all refs, and the ref of HEAD. */
async function stateOf(repository: string): Promise<readonly string[]> {
  return [
    await git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']),
    await git(repository, ['rev-list', '--all', '--count']),
    await git(repository, ['symbolic-ref', 'HEAD']),
  ];
}

describe('scopedRepository with an inherited repository location', () => {
  /** The fixture makes its own repository. The other repository gains no commit and no ref, and HEAD stays on `main`. */
  it('ScopedRepository_AnInheritedGitDir_DoesNotRedirectTheFixture', async () => {
    const other = await otherRepository();
    const before = await stateOf(other);
    expect(before[1]).toBe('1');
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));

    const repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: FIXTURE });
    roots.push(repository.root);
    const worktree = await repository.worktreeFor('task-a', { 'src/a.js': 'export const a = 1;\n' });
    vi.unstubAllEnvs();

    expect(await stateOf(other)).toEqual(before);
    expect(await git(repository.checkout, ['rev-parse', 'HEAD'])).toBe(repository.baseCommit);
    expect(await git(repository.checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe(INTEGRATION_BRANCH);
    expect(toPosix(await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']))).toBe(
      `${repository.checkout}/.git`,
    );
    expect(await git(worktree, ['rev-list', '--count', 'HEAD'])).toBe('2');
  }, CASE_TIMEOUT_MS);
});
