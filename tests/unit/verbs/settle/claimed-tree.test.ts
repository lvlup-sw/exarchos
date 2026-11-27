/**
 * Tests of the constrained observation of a claimed tree, which `task_complete` and the settle fallback use.
 *
 * Each case makes a real repository in which each task has its own linked worktree.
 * The cases cover tracked symbolic links and submodules under both policies, and the split of the two policies.
 * They also cover a checkout with no commit, the limit of the dirty paths, and the checkouts that the worktree listing refuses.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { WIN32_SPAWN_HEADROOM } from '../../../../vitest.config.js';
import { observeConstrainedClaimedTree, type ClaimedTreePolicy } from '../../../../src/verbs/settle/claimed-tree.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../../../helpers/scoped-repository.js';

/** The budget of one case that makes repositories. Each such case spawns about forty git processes. */
const CASE_TIMEOUT_MS = 30_000 * WIN32_SPAWN_HEADROOM;

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feat/claimed';

/** The fixture of the checkout: one manifest. */
const FIXTURE = { 'package.json': '{ "name": "claimed-tree-fixture", "private": true }\n' };

/** Both policies of a claimed tree. */
const POLICIES: readonly ClaimedTreePolicy[] = ['immutable', 'mutable'];

/** A full commit ID that no fixture repository holds. */
const UNKNOWN_COMMIT = 'f'.repeat(40);

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

/** Makes a repository with one commit in `dir`, with a local identity and no signing. */
async function initWithCommit(dir: string, file: string, text: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, file), text, 'utf-8');
  await git(dir, ['add', '--', file]);
  await git(dir, ['commit', '-q', '-m', 'the first commit']);
}

/**
 * Commits a tracked symbolic link `link` to the manifest and a submodule `sub` in the worktree of a task.
 * The submodule is an embedded repository that the worktree records as a gitlink.
 */
async function withLinkAndSubmodule(repository: ScopedRepository): Promise<string> {
  const worktree = await repository.worktreeFor('task-a');
  symlinkSync('package.json', path.join(worktree, 'link'));
  await initWithCommit(path.join(worktree, 'sub'), 'inner.txt', 'inner\n');
  await git(worktree, ['add', '--', 'link', 'sub']);
  await git(worktree, ['commit', '-q', '-m', 'a tracked link and a submodule']);
  return worktree;
}

/** Observes a claimed tree of the scope repository under one policy. */
function observe(repository: ScopedRepository, dir: string, policy: ClaimedTreePolicy, base = repository.baseCommit) {
  return observeConstrainedClaimedTree(dir, base, `${repository.checkout}/.git`, policy);
}

describe('observeConstrainedClaimedTree reads tracked links and submodules', () => {
  /**
   * A tree with a tracked symbolic link and a submodule at its head is a clean tree under both policies.
   * The closed listings refused such a tree before, so each claim against a pinned scope was unobservable.
   */
  it.skipIf(process.platform === 'win32')('ObserveConstrainedClaimedTree_ACleanTreeWithALinkAndASubmodule_IsCleanUnderBothPolicies', async () => {
    const repository = await makeRepository();
    const worktree = await withLinkAndSubmodule(repository);
    const head = await git(worktree, ['rev-parse', 'HEAD']);

    for (const policy of POLICIES) {
      expect(await observe(repository, worktree, policy)).toEqual({
        kind: 'tree',
        toplevel: worktree,
        repository: `${repository.checkout}/.git`,
        branch: 'task/task-a',
        head,
        holdsBase: true,
        dirtyPaths: [],
      });
    }
  }, CASE_TIMEOUT_MS);

  /** A tracked link with a new target differs from its index entry, so the link is a dirty path under both policies. */
  it.skipIf(process.platform === 'win32')('ObserveConstrainedClaimedTree_ALinkWithANewTarget_IsADirtyPathUnderBothPolicies', async () => {
    const repository = await makeRepository();
    const worktree = await withLinkAndSubmodule(repository);
    unlinkSync(path.join(worktree, 'link'));
    symlinkSync('sub', path.join(worktree, 'link'));

    for (const policy of POLICIES) {
      expect(await observe(repository, worktree, policy)).toMatchObject({ kind: 'tree', holdsBase: true, dirtyPaths: ['link'] });
    }
  }, CASE_TIMEOUT_MS);

  /** A staged gitlink of a new submodule commit differs from the head entry, so the submodule is a dirty path under both policies. */
  it.skipIf(process.platform === 'win32')('ObserveConstrainedClaimedTree_AStagedSubmoduleCommit_IsADirtyPathUnderBothPolicies', async () => {
    const repository = await makeRepository();
    const worktree = await withLinkAndSubmodule(repository);
    const inner = path.join(worktree, 'sub');
    await writeFile(path.join(inner, 'inner.txt'), `${await readFile(path.join(inner, 'inner.txt'), 'utf-8')}more\n`, 'utf-8');
    await git(inner, ['commit', '-q', '-am', 'a new submodule commit']);
    await git(worktree, ['add', '--', 'sub']);

    for (const policy of POLICIES) {
      expect(await observe(repository, worktree, policy)).toMatchObject({ kind: 'tree', holdsBase: true, dirtyPaths: ['sub'] });
    }
  }, CASE_TIMEOUT_MS);
});

describe('observeConstrainedClaimedTree judges the base and the bounds', () => {
  /**
   * A base commit that the repository does not hold leaves the ancestry unreadable.
   * The immutable policy refuses the tree as unobservable. The mutable policy reads a tree that does not hold the base.
   */
  it('ObserveConstrainedClaimedTree_AnUnknownBaseCommit_SplitsThePolicies', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a');

    expect(await observe(repository, worktree, 'immutable', UNKNOWN_COMMIT)).toMatchObject({ kind: 'unobservable' });
    expect(await observe(repository, worktree, 'mutable', UNKNOWN_COMMIT)).toMatchObject({
      kind: 'tree',
      head: repository.baseCommit,
      holdsBase: false,
      dirtyPaths: [],
    });
  }, CASE_TIMEOUT_MS);

  /** A checkout with no commit is unobservable under both policies, because the closed listings compare the checkout with its head. */
  it('ObserveConstrainedClaimedTree_ACheckoutWithNoCommit_IsUnobservable', async () => {
    const root = makeTempDir('claimed-tree-unborn-');
    roots.push(root);
    await git(root, ['init', '-q', '--initial-branch=main']);

    for (const policy of POLICIES) {
      expect(await observeConstrainedClaimedTree(root, UNKNOWN_COMMIT, undefined, policy)).toEqual({
        kind: 'unobservable',
        cause: 'The task checkout has no commit',
      });
    }
  }, CASE_TIMEOUT_MS);

  /** A tree with seven untracked files keeps the first five dirty paths in listing order. */
  it('ObserveConstrainedClaimedTree_SevenUntrackedFiles_KeepsTheFirstFive', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a');
    for (let index = 1; index <= 7; index++) await writeFile(path.join(worktree, `u${index}.txt`), 'untracked\n', 'utf-8');

    expect(await observe(repository, worktree, 'immutable')).toMatchObject({
      kind: 'tree',
      dirtyPaths: ['u1.txt', 'u2.txt', 'u3.txt', 'u4.txt', 'u5.txt'],
    });
  }, CASE_TIMEOUT_MS);
});

describe('observeConstrainedClaimedTree refuses a checkout that is not one registered checkout', () => {
  /** A main checkout that the configuration marks bare is unobservable. */
  it('ObserveConstrainedClaimedTree_ABareCheckout_IsUnobservable', async () => {
    const repository = await makeRepository();
    await git(repository.checkout, ['config', 'core.bare', 'true']);

    expect(await observe(repository, repository.checkout, 'immutable')).toMatchObject({ kind: 'unobservable' });
  }, CASE_TIMEOUT_MS);

  /** A linked worktree whose administrative entry points at a missing location is prunable, so it is unobservable. */
  it('ObserveConstrainedClaimedTree_APrunableWorktree_IsUnobservable', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a');
    const admin = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir']);
    await writeFile(path.join(admin, 'gitdir'), `${repository.root}/missing/.git\n`, 'utf-8');
    expect(await git(repository.checkout, ['worktree', 'list', '--porcelain'])).toContain('prunable');

    expect(await observe(repository, worktree, 'immutable')).toMatchObject({ kind: 'unobservable' });
  }, CASE_TIMEOUT_MS);

  /** A directory whose `.git` file names the administrative entry of another worktree is not registered, so it is unobservable. */
  it('ObserveConstrainedClaimedTree_AnUnregisteredCheckout_IsUnobservable', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a');
    const admin = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const copy = path.join(repository.root, 'unregistered');
    mkdirSync(copy);
    await writeFile(path.join(copy, '.git'), `gitdir: ${admin}\n`, 'utf-8');
    await writeFile(path.join(copy, 'package.json'), FIXTURE['package.json'], 'utf-8');

    expect(await observe(repository, copy, 'immutable')).toMatchObject({ kind: 'unobservable' });
  }, CASE_TIMEOUT_MS);
});
