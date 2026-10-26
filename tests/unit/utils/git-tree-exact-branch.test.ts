/**
 * Tests of two reads of the shared git observation: the exact branch name, and the status of a tree of another repository.
 *
 * Each case makes real repositories in which each task has its own linked worktree.
 * A tag with the name of a branch makes the short form of git print `heads/<name>`, so the branch read uses the full ref.
 * The status runs the `core.fsmonitor` command of its repository, so a tree of another repository gets no status.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { WIN32_SPAWN_HEADROOM } from '../../../vitest.config.js';
import { observeClaimedTree, observeTree } from '../../../src/utils/git-tree.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../../helpers/scoped-repository.js';

/** The budget of one case that makes repositories. Each such case spawns about thirty git processes. */
const CASE_TIMEOUT_MS = 30_000 * WIN32_SPAWN_HEADROOM;

/** The branch that each task forks from. Its name has a slash, as the integration branches of this repository do. */
const INTEGRATION_BRANCH = 'feat/integration';

/** The fixture of the checkout: one manifest. */
const FIXTURE = { 'package.json': '{ "name": "exact-branch-fixture", "private": true }\n' };

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

/**
 * Sets the `core.fsmonitor` command of a repository to a Node script that writes a marker file outside each work tree.
 * Git runs that command for each status of a tree of the repository. It returns the path of the marker file.
 */
async function markOnEachStatus(repository: ScopedRepository): Promise<string> {
  const marker = path.posix.join(repository.root, 'fsmonitor-ran');
  const hook = path.posix.join(repository.root, 'fsmonitor-hook.cjs');
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`, 'utf-8');
  await git(repository.checkout, ['config', 'core.fsmonitor', `node ${JSON.stringify(hook)}`]);
  return marker;
}

describe('observeTree reads the exact branch name', () => {
  /**
   * The checkout and a linked worktree each hold a branch that a tag of the same name shadows.
   * The short form of git prints `heads/<name>` there. The observation gives the name of the branch.
   */
  it('ObserveTree_ATagWithTheNameOfTheBranch_ReadsTheBranchName', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a');
    await git(repository.checkout, ['tag', INTEGRATION_BRANCH]);
    await git(repository.checkout, ['tag', 'task/task-a']);
    expect(await git(repository.checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe(`heads/${INTEGRATION_BRANCH}`);
    expect(await git(worktree, ['symbolic-ref', '--short', 'HEAD'])).toBe('heads/task/task-a');

    expect(await observeTree(repository.checkout)).toEqual({
      kind: 'tree',
      toplevel: repository.checkout,
      repository: `${repository.checkout}/.git`,
      branch: INTEGRATION_BRANCH,
      head: repository.baseCommit,
    });
    expect(await observeTree(worktree)).toMatchObject({ kind: 'tree', toplevel: worktree, branch: 'task/task-a' });
  }, CASE_TIMEOUT_MS);
});

describe('observeClaimedTree reads no status outside the scope repository', () => {
  /**
   * The other repository sets `core.fsmonitor` to a command that writes a marker file. The observation names the scope
   * repository, so it gives the tree with no ancestry and no status, and the command does not run.
   * Then a status in that tree writes the marker, so the command is live in the case.
   */
  it('ObserveClaimedTree_ATreeOfAnotherRepository_RunsNoStatus', async () => {
    const scope = await makeRepository();
    const other = await makeRepository();
    const worktree = await other.worktreeFor('task-a');
    await writeFile(path.join(worktree, 'notes.txt'), 'not committed\n', 'utf-8');
    const marker = await markOnEachStatus(other);

    const observed = await observeClaimedTree(worktree, other.baseCommit, `${scope.checkout}/.git`);

    expect(observed).toEqual({
      kind: 'tree',
      toplevel: worktree,
      repository: `${other.checkout}/.git`,
      branch: 'task/task-a',
      head: other.baseCommit,
      holdsBase: false,
      dirtyPaths: [],
    });
    expect(existsSync(marker)).toBe(false);
    await git(worktree, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
  }, CASE_TIMEOUT_MS);

  /**
   * The twin: a tree of the scope repository still gets the ancestry and the status, so its untracked file is listed.
   * The same tree observed against another repository gets neither read.
   */
  it('ObserveClaimedTree_ATreeOfTheScopeRepository_StillReadsTheStatus', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a');
    await writeFile(path.join(worktree, 'notes.txt'), 'not committed\n', 'utf-8');

    expect(await observeClaimedTree(worktree, repository.baseCommit, `${repository.checkout}/.git`)).toEqual({
      kind: 'tree',
      toplevel: worktree,
      repository: `${repository.checkout}/.git`,
      branch: 'task/task-a',
      head: repository.baseCommit,
      holdsBase: true,
      dirtyPaths: ['notes.txt'],
    });
    expect(await observeClaimedTree(worktree, repository.baseCommit, `${repository.root}/elsewhere/.git`)).toMatchObject({
      kind: 'tree',
      holdsBase: false,
      dirtyPaths: [],
    });
  }, CASE_TIMEOUT_MS);
});
