/**
 * A real git repository for tests, in which each task has its own linked worktree.
 *
 * The checkout holds one commit of the fixture files on `main`. Then it switches to a new
 * integration branch at that commit, and it stays there. So `main` exists, and the integration
 * branch holds no commit beyond it.
 *
 * Each task gets a linked worktree on the branch `task/<taskId>`, at the tip of the integration
 * branch. The checkout and each worktree are sibling directories of one temp tree. So no worktree
 * shows in the status of the checkout.
 *
 * Each path that the helper returns is canonical: the real path in POSIX form. That is the form
 * that `git rev-parse --show-toplevel` prints, also for the 8.3 temp path of a Windows runner.
 */
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { toPosix } from '../../src/utils/paths.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir } from '../../tools/test-helpers/temp-dir.js';

/** The files of one commit: the path of each file relative to the root of its tree, and its text. */
export type FixtureFiles = Readonly<Record<string, string>>;

/** What a test gives to make a scoped repository. */
export interface ScopedRepositoryOptions {
  /** The branch that each task forks from. The checkout stays on it. */
  readonly integrationBranch: string;
  /** The files of the one commit of the checkout. */
  readonly files: FixtureFiles;
}

/** A checkout on the integration branch, and the linked worktree of each task. */
export interface ScopedRepository {
  /** The temp tree that holds the checkout and each worktree. A test deletes it to clean up. */
  readonly root: string;
  /** The canonical path of the checkout. */
  readonly checkout: string;
  /** The branch that the checkout holds and that each task forks from. */
  readonly integrationBranch: string;
  /** The one commit of the checkout. `main` and the integration branch both point to it. */
  readonly baseCommit: string;
  /**
   * Adds a linked worktree for the task on the branch `task/<taskId>`, at the tip of the integration
   * branch, and returns its canonical path. With `files`, it also commits them on the task branch.
   * A second call for one task returns the same worktree. A second call with `files` is refused,
   * because `commitIn` adds a commit to an existing worktree.
   */
  worktreeFor(taskId: string, files?: FixtureFiles): Promise<string>;
  /** Commits `files` in the existing worktree of the task, on the branch that the worktree holds. */
  commitIn(taskId: string, files: FixtureFiles): Promise<void>;
  /**
   * Switches the checkout to `main`, which holds the base commit, and adds a linked worktree outside the checkout that holds
   * the integration branch. It returns the canonical path of the checkout, which is the primary worktree, and of the linked worktree.
   * The integration branch then holds no commit beyond `main`. Call it once, before any task needs the integration branch in the checkout.
   */
  baseInLinkedWorktree(): Promise<BaseInLinkedWorktree>;
}

/** The two trees of {@link ScopedRepository.baseInLinkedWorktree}: the primary worktree on `main`, and the linked worktree of the base. */
export interface BaseInLinkedWorktree {
  readonly primary: string;
  readonly linked: string;
}

/** The characters that a task id can hold. The id names a branch and a directory, so it holds no separator. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

/** The real path of a directory in POSIX form. */
function canonicalPath(dir: string): string {
  return toPosix(realpathSync.native(dir));
}

/** Writes each file under the root of a tree, and makes its directory first. */
async function writeFiles(root: string, files: FixtureFiles): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf-8');
  }
}

/** Writes the files in a tree and commits them on the branch that the tree holds. */
async function commitFiles(tree: string, files: FixtureFiles, message: string): Promise<void> {
  await writeFiles(tree, files);
  await git(tree, ['add', '--', ...Object.keys(files)]);
  await git(tree, ['commit', '-q', '-m', message]);
}

/**
 * Makes the checkout in a new temp tree. Each git call that changes the repository runs after the
 * previous one ends, so two calls never compete for a lock of the repository.
 */
export async function scopedRepository(options: ScopedRepositoryOptions): Promise<ScopedRepository> {
  const root = canonicalPath(makeTempDir('scoped-repository-'));
  const checkoutDir = path.join(root, 'checkout');
  await mkdir(checkoutDir);
  await git(checkoutDir, ['init', '-q', '--initial-branch=main']);
  await git(checkoutDir, ['config', 'user.email', 'test@example.com']);
  await git(checkoutDir, ['config', 'user.name', 'Test']);
  await git(checkoutDir, ['config', 'commit.gpgsign', 'false']);
  await commitFiles(checkoutDir, options.files, 'the fixture of the integration branch');
  await git(checkoutDir, ['switch', '-q', '-c', options.integrationBranch]);
  const checkout = canonicalPath(checkoutDir);
  const baseCommit = await git(checkout, ['rev-parse', 'HEAD']);

  const worktrees = new Map<string, Promise<string>>();
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(step: () => Promise<T>): Promise<T> => {
    const next = queue.then(step, step);
    queue = next.catch(() => undefined);
    return next;
  };

  const addWorktree = async (taskId: string, files: FixtureFiles | undefined): Promise<string> => {
    const dir = path.join(root, `worktree-${taskId}`);
    await git(checkout, ['worktree', 'add', '-q', '-b', `task/${taskId}`, dir, options.integrationBranch]);
    const tree = canonicalPath(dir);
    if (files !== undefined) await commitFiles(tree, files, `${taskId}: the work of the task`);
    return tree;
  };

  return {
    root,
    checkout,
    integrationBranch: options.integrationBranch,
    baseCommit,
    worktreeFor(taskId, files) {
      if (!TASK_ID.test(taskId)) return Promise.reject(new Error(`the task id ${JSON.stringify(taskId)} cannot name a branch`));
      const existing = worktrees.get(taskId);
      if (existing !== undefined) {
        if (files === undefined) return existing;
        return Promise.reject(new Error(`task ${JSON.stringify(taskId)} has a worktree. Use commitIn to add a commit to it.`));
      }
      const added = serially(() => addWorktree(taskId, files));
      worktrees.set(taskId, added);
      return added;
    },
    async commitIn(taskId, files) {
      const existing = worktrees.get(taskId);
      if (existing === undefined) throw new Error(`task ${JSON.stringify(taskId)} has no worktree. Call worktreeFor first.`);
      const tree = await existing;
      await serially(() => commitFiles(tree, files, `${taskId}: a correction`));
    },
    baseInLinkedWorktree() {
      return serially(async () => {
        await git(checkout, ['switch', '-q', 'main']);
        const dir = path.join(root, 'base-worktree');
        await git(checkout, ['worktree', 'add', '-q', dir, options.integrationBranch]);
        return { primary: checkout, linked: canonicalPath(dir) };
      });
    },
  };
}
