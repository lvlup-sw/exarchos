/**
 * The self-test of the scoped repository helper, on real git.
 *
 * Each case makes its own repository and reads it back with git. A case spawns several git
 * processes, so it sets its own timeout and does not raise the budget of its tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { toPosix } from '../../src/utils/paths.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from './scoped-repository.js';

/** The budget of one case. Each case spawns about fifteen git processes. */
const CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/scoped';

/** The fixture of the checkout: two files, one of them in a subdirectory. */
const FIXTURE = {
  'package.json': '{ "name": "scoped-fixture", "private": true }\n',
  'src/a.js': 'export const a = 1;\n',
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** Makes a repository with the fixture, and deletes it after the case. */
async function makeRepository(): Promise<ScopedRepository> {
  const repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: FIXTURE });
  roots.push(repository.root);
  return repository;
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

/** The absolute git common dir of a tree, in POSIX form. */
async function commonDirOf(tree: string): Promise<string> {
  return toPosix(await git(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

describe('scopedRepository', () => {
  /** The checkout holds the integration branch, and its history is the one commit of the fixture files. */
  it('ScopedRepository_ACheckout_HoldsOneCommitOfTheFixtureOnTheIntegrationBranch', async () => {
    const repository = await makeRepository();

    expect(await git(repository.checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe(INTEGRATION_BRANCH);
    expect(await git(repository.checkout, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(await git(repository.checkout, ['rev-parse', 'HEAD'])).toBe(repository.baseCommit);
    expect((await git(repository.checkout, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n')).toEqual([
      'package.json',
      'src/a.js',
    ]);
    expect(await readFile(path.join(repository.checkout, 'src/a.js'), 'utf-8')).toBe(FIXTURE['src/a.js']);
  }, CASE_TIMEOUT_MS);

  /** `main` exists and points to the base commit, so the integration branch holds no commit beyond it. */
  it('ScopedRepository_ACheckout_HoldsMainAtTheBaseCommit', async () => {
    const repository = await makeRepository();

    expect(await git(repository.checkout, ['rev-parse', '--verify', 'main'])).toBe(repository.baseCommit);
    expect(await git(repository.checkout, ['rev-parse', '--verify', INTEGRATION_BRANCH])).toBe(repository.baseCommit);
    expect(await git(repository.checkout, ['rev-list', '--count', `main..${INTEGRATION_BRANCH}`])).toBe('0');
  }, CASE_TIMEOUT_MS);

  /** Each worktree is a sibling of the checkout, so neither worktree shows as an untracked directory there. */
  it('ScopedRepository_TheCheckoutWithTwoWorktrees_HasAnEmptyStatus', async () => {
    const repository = await makeRepository();
    const first = await repository.worktreeFor('task-a');
    const second = await repository.worktreeFor('task-b', { 'src/b.js': 'export const b = 2;\n' });

    expect(path.posix.dirname(first)).toBe(path.posix.dirname(repository.checkout));
    expect(path.posix.dirname(second)).toBe(path.posix.dirname(repository.checkout));
    expect(await git(repository.checkout, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  }, CASE_TIMEOUT_MS);

  /**
   * A worktree is the root of its own work tree, outside the checkout. It holds the branch of its task, and its HEAD is
   * the base commit, so the branch holds no commit of its own.
   */
  it('ScopedRepository_WorktreeFor_ForksALinkedWorktreeOnItsOwnBranchAtTheBaseWithNoCommit', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor('task-a');

    expect(toPosix(await git(tree, ['rev-parse', '--show-toplevel']))).toBe(tree);
    expect(path.posix.relative(repository.checkout, tree).startsWith('..')).toBe(true);
    expect(await git(tree, ['symbolic-ref', '--short', 'HEAD'])).toBe('task/task-a');
    expect(await git(tree, ['rev-parse', 'HEAD'])).toBe(repository.baseCommit);
    expect(await git(tree, ['rev-list', '--count', `${INTEGRATION_BRANCH}..HEAD`])).toBe('0');
    expect(await git(repository.checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe(INTEGRATION_BRANCH);
  }, CASE_TIMEOUT_MS);

  /** The files of a call with files are one commit on the task branch, on top of the base. The integration branch does not move. */
  it('ScopedRepository_WorktreeForWithFiles_CommitsThemOnTheTaskBranch', async () => {
    const repository = await makeRepository();
    const red = '{ "name": "scoped-fixture", "scripts": { "lint": "exit 1" } }\n';
    const tree = await repository.worktreeFor('task-b', { 'package.json': red });

    expect(await git(tree, ['symbolic-ref', '--short', 'HEAD'])).toBe('task/task-b');
    expect(await git(tree, ['rev-list', '--count', `${INTEGRATION_BRANCH}..task/task-b`])).toBe('1');
    expect(await git(tree, ['rev-parse', 'HEAD~1'])).toBe(repository.baseCommit);
    expect(await git(tree, ['show', 'task/task-b:package.json'])).toBe(red.trim());
    expect(await git(tree, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(await git(repository.checkout, ['rev-parse', INTEGRATION_BRANCH])).toBe(repository.baseCommit);
  }, CASE_TIMEOUT_MS);

  /** A correction is one more commit in the worktree of its task, on the branch of that task. */
  it('ScopedRepository_CommitIn_AddsACommitOnTheBranchOfTheTask', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor('task-a', { 'src/a.js': 'export const a = 2;\n' });
    const before = await git(tree, ['rev-parse', 'HEAD']);

    await repository.commitIn('task-a', { 'src/a.js': 'export const a = 3;\n', 'test/a.test.js': 'export {};\n' });

    expect(await git(tree, ['rev-parse', 'HEAD~1'])).toBe(before);
    expect(await git(tree, ['rev-parse', 'HEAD'])).toBe(await git(tree, ['rev-parse', 'task/task-a']));
    expect(await git(tree, ['rev-list', '--count', `${INTEGRATION_BRANCH}..task/task-a`])).toBe('2');
    expect(await git(tree, ['show', 'task/task-a:src/a.js'])).toBe('export const a = 3;');
    expect(await git(tree, ['show', 'task/task-a:test/a.test.js'])).toBe('export {};');
    expect(await git(tree, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    await expect(repository.commitIn('task-z', { 'src/z.js': '' })).rejects.toThrow('has no worktree');
  }, CASE_TIMEOUT_MS);

  /** Two worktrees and the checkout are trees of one repository: each names the common dir of the checkout. */
  it('ScopedRepository_TwoWorktrees_ShareTheCommonDirOfTheCheckout', async () => {
    const repository = await makeRepository();
    const first = await repository.worktreeFor('task-a');
    const second = await repository.worktreeFor('task-b');
    const common = await commonDirOf(repository.checkout);

    expect(common).toBe(`${repository.checkout}/.git`);
    expect(await commonDirOf(first)).toBe(common);
    expect(await commonDirOf(second)).toBe(common);
    expect(toPosix(await git(first, ['rev-parse', '--path-format=absolute', '--git-dir']))).not.toBe(common);
  }, CASE_TIMEOUT_MS);

  /** A new worktree has no change, so its status is empty under the ignore rules of git. */
  it('ScopedRepository_AFreshWorktree_HasAnEmptyStatus', async () => {
    const repository = await makeRepository();
    const tree = await repository.worktreeFor('task-a');

    expect(await git(tree, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  }, CASE_TIMEOUT_MS);

  /** Two calls for one task, also two calls at the same time, give one worktree. A second call with files is refused. */
  it('ScopedRepository_ASecondCallForOneTask_ReturnsTheSameWorktree', async () => {
    const repository = await makeRepository();
    const [first, concurrent] = await Promise.all([repository.worktreeFor('task-a'), repository.worktreeFor('task-a')]);
    const later = await repository.worktreeFor('task-a');

    expect(concurrent).toBe(first);
    expect(later).toBe(first);
    const listed = (await git(repository.checkout, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    expect(listed).toHaveLength(2);
    await expect(repository.worktreeFor('task-a', { 'src/a.js': '' })).rejects.toThrow('Use commitIn');
  }, CASE_TIMEOUT_MS);
});
