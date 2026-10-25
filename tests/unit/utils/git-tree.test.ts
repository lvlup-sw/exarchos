/**
 * Tests of the shared git observation of a tree, and of its two path forms.
 *
 * The observation cases make a real repository in which each task has its own linked worktree.
 * Each such case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 * The path cases read the file system only. Each missing path of these cases keeps its text on every platform.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';

import { WIN32_SPAWN_HEADROOM } from '../../../vitest.config.js';
import { canonicalPath, normalizedPath, observeTree } from '../../../src/utils/git-tree.js';
import { toPosix } from '../../../src/utils/paths.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../../helpers/scoped-repository.js';

/** The budget of one case that makes a repository. Each such case spawns about fifteen git processes. */
const CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/observed';

/** The fixture of the checkout: two files, one of them in a subdirectory. */
const FIXTURE = {
  'package.json': '{ "name": "observed-fixture", "private": true }\n',
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

/**
 * Makes a temp tree outside git with a directory `real` and a symbolic link `link` to it, and deletes it after the case.
 * The link is a junction on win32, because a junction needs no privilege there.
 */
function makeLinkedDirectory(prefix: string): { readonly root: string; readonly real: string; readonly link: string } {
  const root = makeTempDir(prefix);
  roots.push(root);
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  mkdirSync(real);
  symlinkSync(real, link, 'junction');
  return { root, real, link };
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

describe('observeTree', () => {
  /** A linked worktree gives its own root and its own head, and the common dir of the checkout. */
  it('ObserveTree_ALinkedWorktree_GivesItsRootTheCommonDirTheBranchAndTheHead', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a', { 'src/b.js': 'export const b = 2;\n' });
    const head = await git(worktree, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(repository.baseCommit);

    expect(await observeTree(worktree)).toEqual({
      kind: 'tree',
      toplevel: worktree,
      repository: `${repository.checkout}/.git`,
      branch: 'task/task-a',
      head,
    });
  }, CASE_TIMEOUT_MS);

  /** A directory inside a worktree gives the root of that worktree, not the directory. */
  it('ObserveTree_ASubdirectory_GivesTheRootOfItsWorkTree', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-b');

    expect(await observeTree(path.join(worktree, 'src'))).toEqual({
      kind: 'tree',
      toplevel: worktree,
      repository: `${repository.checkout}/.git`,
      branch: 'task/task-b',
      head: repository.baseCommit,
    });
  }, CASE_TIMEOUT_MS);

  /** A worktree with a detached HEAD gives its head and no branch. */
  it('ObserveTree_ADetachedHead_GivesNoBranch', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-c');
    await git(worktree, ['switch', '-q', '--detach']);

    const observed = await observeTree(worktree);

    expect(observed).toEqual({
      kind: 'tree',
      toplevel: worktree,
      repository: `${repository.checkout}/.git`,
      head: repository.baseCommit,
    });
    expect(observed).not.toHaveProperty('branch');
  }, CASE_TIMEOUT_MS);

  /** A directory outside git, named through a symbolic link, gives no work tree and the real path of the directory. */
  it('ObserveTree_ADirectoryOutsideGit_GivesNoWorkTreeWithItsCanonicalPath', async () => {
    const { root, link } = makeLinkedDirectory('git-tree-outside-');
    const expected = `${toPosix(realpathSync.native(root))}/real`;

    expect(await observeTree(link)).toEqual({ kind: 'no-work-tree', path: expected });
  }, CASE_TIMEOUT_MS);

  /** A path that does not exist gives no work tree and its lexical form, with no drive on win32. */
  it('ObserveTree_AMissingPath_GivesNoWorkTreeWithItsLexicalPath', async () => {
    expect(await observeTree('/nonexistent-git-tree-observation/task/../work')).toEqual({
      kind: 'no-work-tree',
      path: '/nonexistent-git-tree-observation/work',
    });
  }, CASE_TIMEOUT_MS);
});

describe('canonicalPath', () => {
  /** The canonical form expands the link, and the lexical form keeps it. */
  it('CanonicalPath_ASymbolicLink_GivesTheRealPathInPosixForm', () => {
    const { root, link } = makeLinkedDirectory('git-tree-link-');
    const expected = `${toPosix(realpathSync.native(root))}/real`;

    expect(canonicalPath(link)).toBe(expected);
    expect(normalizedPath(link)).toBe(toPosix(link));
    expect(normalizedPath(link)).not.toBe(expected);
  });

  /** A POSIX-absolute path that does not exist keeps its normalized text on every platform. */
  it('CanonicalPath_AMissingPosixAbsolutePath_KeepsItsTextWithNoDrive', () => {
    expect(canonicalPath('/nonexistent-settle-worktree')).toBe('/nonexistent-settle-worktree');
    expect(canonicalPath('/nonexistent-settle-worktree/task-second/./extra/..')).toBe(
      '/nonexistent-settle-worktree/task-second',
    );
    expect(normalizedPath('/nonexistent-settle-worktree/task-second/./extra/..')).toBe(
      '/nonexistent-settle-worktree/task-second',
    );
  });

  /** A win32 path gives its POSIX form with its drive, also on a POSIX host. */
  it('CanonicalPath_AWin32Path_GivesItsPosixFormOnAnyHost', () => {
    expect(canonicalPath('C:\\nonexistent-git-tree\\task\\..\\work')).toBe('C:/nonexistent-git-tree/work');
    expect(normalizedPath('C:\\nonexistent-git-tree\\task\\..\\work')).toBe('C:/nonexistent-git-tree/work');
  });
});
