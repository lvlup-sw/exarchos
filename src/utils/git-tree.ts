/**
 * The shared git observation of a tree: its root, its repository, its branch and its head commit.
 * Three more reads serve `prepare`: the repository of a directory, the commit of a ref, and the ancestry of two commits.
 * The observation of a claimed tree serves `settle`: it adds whether HEAD holds the base commit, and the first dirty paths.
 *
 * The two path forms follow `normalizeRepoPath` of `paths.ts`. The canonical form is the real path
 * in POSIX form, as `git rev-parse --show-toplevel` prints it. The lexical form reads no file, so it
 * serves a path that does not exist. The module spawns git with the async `execFile`, with a
 * timeout and an output cap. It imports nothing from `src/verbs`.
 */
import { execFile } from 'node:child_process';

import { lexicalRepoPath, normalizeRepoPath } from './paths.js';

/** The wall-clock budget of one git call. A call that runs longer gives an unobservable tree. */
const GIT_TIMEOUT_MS = 30_000;

/** The output cap of one git call. Each call prints a few short lines, so a larger output is a fault. */
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * The exit code with which git reports a detached HEAD to `symbolic-ref --quiet`, and an unborn HEAD or a missing ref to `rev-parse --verify --quiet`.
 * `merge-base --is-ancestor` exits with it for a commit that is not an ancestor.
 */
const GIT_ABSENT_EXIT_CODE = 1;

/**
 * The prefix of the full name of a branch.
 * The branch read removes it from the ref of HEAD. A ref with no such prefix keeps its full name.
 */
const BRANCH_REF_PREFIX = 'refs/heads/';

/** The outcome of one git call: the exit code and the output, or the cause when git did not run to its end. */
type GitOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'failed'; readonly cause: string };

/**
 * What git observes at a directory.
 * A `tree` is a git work tree: its canonical root, its canonical common dir, the branch of HEAD and the HEAD commit.
 * A detached HEAD gives no branch, and a HEAD with no commit gives no head.
 * A `no-work-tree` is a path outside any git work tree, in canonical form. A path that does not exist keeps its lexical form.
 * An `unobservable` tree is one where git did not start, did not end in time, or failed in an unexpected way.
 */
export type TreeObservation =
  | {
      readonly kind: 'tree';
      readonly toplevel: string;
      readonly repository: string;
      readonly branch?: string;
      readonly head?: string;
    }
  | { readonly kind: 'no-work-tree'; readonly path: string }
  | { readonly kind: 'unobservable'; readonly cause: string };

/**
 * Where git finds the repository of a directory: the canonical root of its work tree and the canonical common dir.
 * A `no-work-tree` and an `unobservable` directory have the meaning that they have in {@link TreeObservation}.
 */
export type RepositoryObservation =
  | { readonly kind: 'repository'; readonly toplevel: string; readonly repository: string }
  | { readonly kind: 'no-work-tree'; readonly path: string }
  | { readonly kind: 'unobservable'; readonly cause: string };

/** The commit of a ref: the full object name, no commit, or the cause when git did not answer. */
export type CommitRead =
  | { readonly kind: 'commit'; readonly commit: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unobservable'; readonly cause: string };

/** Whether one commit is an ancestor of another, or the cause when git did not answer. A commit is an ancestor of itself. */
export type AncestryRead =
  | { readonly kind: 'ancestor' }
  | { readonly kind: 'not-ancestor' }
  | { readonly kind: 'unobservable'; readonly cause: string };

/**
 * What git observes at a claimed worktree.
 * A `tree` adds two reads to the tree of {@link TreeObservation}. `holdsBase` says that HEAD holds the base commit.
 * `dirtyPaths` holds at most five paths that `git status --porcelain` prints under the ignore rules of git. An empty list is a clean tree.
 * A `no-work-tree` and an `unobservable` claimed tree have the meaning that they have in {@link TreeObservation}.
 *
 * A tree of another repository than the scope repository gets neither read. It has `holdsBase: false` and no dirty path.
 * Rule 3 refuses such a tree before rules 7 and 8 read the two fields.
 */
export type ClaimedTreeObservation =
  | (Extract<TreeObservation, { readonly kind: 'tree' }> & {
      readonly holdsBase: boolean;
      readonly dirtyPaths: readonly string[];
    })
  | Exclude<TreeObservation, { readonly kind: 'tree' }>;

/**
 * The seam over the observation of a claimed worktree. The default is {@link observeClaimedTree}.
 * The third argument is the canonical common dir of the scope, when the caller judges against a scope.
 */
export type TreeObserver = (
  dir: string,
  baseCommit: string,
  repository?: string,
) => Promise<ClaimedTreeObservation>;

/** The most dirty paths that one observation of a claimed worktree keeps. */
const DIRTY_PATH_LIMIT = 5;

/** The width of the status code and its space at the start of each line of `git status --porcelain`. */
const PORCELAIN_STATUS_WIDTH = 3;

/** One value of an optional git read: the value, no value, or the cause of a failed read. */
type OptionalRead =
  | { readonly kind: 'read'; readonly value?: string }
  | { readonly kind: 'failed'; readonly cause: string };

/**
 * The lexical form of a path: absolute, normalized and in POSIX form, with no file read.
 * A POSIX-absolute input gets no drive on win32. Use it for a path that does not exist, and for a path that an earlier build recorded.
 */
export function normalizedPath(p: string): string {
  return lexicalRepoPath(p);
}

/**
 * The canonical form of a path: the real path of its lexical form, in POSIX form.
 * The real path expands a symbolic link and a Windows 8.3 short name. When the real path fails, the canonical form is the lexical form.
 */
export function canonicalPath(p: string): string {
  return normalizeRepoPath(p);
}

/** Runs one git call to its end. The promise does not reject. */
function runGit(args: readonly string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        [...args],
        { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ kind: 'exited', exitCode: 0, stdout, stderr });
          } else if (typeof error.code === 'number' && error.killed !== true) {
            resolve({ kind: 'exited', exitCode: error.code, stdout, stderr });
          } else {
            resolve({ kind: 'failed', cause: error.message });
          }
        },
      );
    } catch (error) {
      resolve({ kind: 'failed', cause: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** The first line of the output of a git call that exited with 0, or no value when git reports the value as absent. */
function optionalRead(outcome: GitOutcome, what: string): OptionalRead {
  if (outcome.kind === 'failed') return outcome;
  if (outcome.exitCode === 0) {
    const value = outcome.stdout.trim();
    return value.length > 0 ? { kind: 'read', value } : { kind: 'read' };
  }
  if (outcome.exitCode === GIT_ABSENT_EXIT_CODE) return { kind: 'read' };
  return { kind: 'failed', cause: `git could not read ${what} (exit ${outcome.exitCode}): ${outcome.stderr.trim()}` };
}

/**
 * Finds the repository of `dir` with one git call, which prints the root of the work tree and the common dir.
 * Both go through {@link canonicalPath}, so a symbolic link or a short name gives the same repository.
 * A directory outside any git work tree gives `no-work-tree` with its canonical path. A path that does not exist keeps its lexical form.
 */
export async function observeRepository(dir: string): Promise<RepositoryObservation> {
  const located = await runGit([
    '-C',
    dir,
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
  ]);
  if (located.kind === 'failed') return { kind: 'unobservable', cause: located.cause };
  const [toplevel, commonDir] = located.stdout.split(/\r?\n/).map((line) => line.trim());
  if (located.exitCode !== 0 || !toplevel || !commonDir) {
    return { kind: 'no-work-tree', path: canonicalPath(dir) };
  }
  return { kind: 'repository', toplevel: canonicalPath(toplevel), repository: canonicalPath(commonDir) };
}

/**
 * Resolves `ref` to a commit in the repository of `dir`.
 * The end-of-options mark keeps git from reading a ref that starts with a dash as an option.
 * A ref that names no commit gives `absent`.
 */
export async function resolveCommit(dir: string, ref: string): Promise<CommitRead> {
  const read = optionalRead(
    await runGit(['-C', dir, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]),
    `the commit of ${ref}`,
  );
  if (read.kind === 'failed') return { kind: 'unobservable', cause: read.cause };
  return read.value === undefined ? { kind: 'absent' } : { kind: 'commit', commit: read.value };
}

/**
 * Asks git whether `ancestor` is an ancestor of `descendant` in the repository of `dir`.
 * Git exits with 0 for an ancestor and with 1 for a commit that is not one.
 * Another exit, such as for a commit that the repository does not hold, gives `unobservable` with the words of git.
 */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<AncestryRead> {
  const outcome = await runGit(['-C', dir, 'merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]);
  if (outcome.kind === 'failed') return { kind: 'unobservable', cause: outcome.cause };
  if (outcome.exitCode === 0) return { kind: 'ancestor' };
  if (outcome.exitCode === GIT_ABSENT_EXIT_CODE) return { kind: 'not-ancestor' };
  return {
    kind: 'unobservable',
    cause: `git could not compare ${ancestor} with ${descendant} (exit ${outcome.exitCode}): ${outcome.stderr.trim()}`,
  };
}

/**
 * The branch name of the full ref of HEAD. A ref under `refs/heads/` loses that prefix, and another ref keeps its full name.
 * The short form of git is not exact: when a tag has the name of the branch, git prints `heads/<name>`.
 */
function branchNameOf(ref: string): string {
  return ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
}

/**
 * Observes the tree that holds `dir` with three git calls: the root and the common dir, the full ref of HEAD, and the HEAD commit.
 * The root and the common dir are those of {@link observeRepository}. The branch is the full ref with no `refs/heads/` prefix.
 * A directory outside any git work tree gives `no-work-tree` with its canonical path. A path that does not exist keeps its lexical form.
 */
export async function observeTree(dir: string): Promise<TreeObservation> {
  const located = await observeRepository(dir);
  if (located.kind !== 'repository') return located;

  const [branchOutcome, headOutcome] = await Promise.all([
    runGit(['-C', dir, 'symbolic-ref', '--quiet', 'HEAD']),
    runGit(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD']),
  ]);
  const branch = optionalRead(branchOutcome, 'the branch of HEAD');
  if (branch.kind === 'failed') return { kind: 'unobservable', cause: branch.cause };
  const head = optionalRead(headOutcome, 'the HEAD commit');
  if (head.kind === 'failed') return { kind: 'unobservable', cause: head.cause };

  return {
    kind: 'tree',
    toplevel: located.toplevel,
    repository: located.repository,
    ...(branch.value === undefined ? {} : { branch: branchNameOf(branch.value) }),
    ...(head.value === undefined ? {} : { head: head.value }),
  };
}

/**
 * Observes a claimed worktree with five git calls: the three calls of {@link observeTree}, the ancestry of the base commit, and the status.
 * The status runs with `--no-optional-locks`, so the call writes no index refresh.
 * A HEAD that git cannot compare with the base commit does not hold it. Examples are a HEAD with no commit, and a base commit that the repository does not hold.
 * A directory outside any git work tree gives `no-work-tree`, as in {@link observeTree}.
 *
 * With `repository`, a tree whose common dir is another repository gets neither the ancestry call nor the status call.
 * The status can run a command that the config of that repository names, such as `core.fsmonitor`.
 */
export async function observeClaimedTree(
  dir: string,
  baseCommit: string,
  repository?: string,
): Promise<ClaimedTreeObservation> {
  const tree = await observeTree(dir);
  if (tree.kind !== 'tree') return tree;
  if (repository !== undefined && tree.repository !== repository) return { ...tree, holdsBase: false, dirtyPaths: [] };

  const [ancestry, status] = await Promise.all([
    runGit(['-C', dir, 'merge-base', '--is-ancestor', '--end-of-options', baseCommit, 'HEAD']),
    runGit(['--no-optional-locks', '-C', dir, 'status', '--porcelain']),
  ]);
  if (ancestry.kind === 'failed') return { kind: 'unobservable', cause: ancestry.cause };
  if (status.kind === 'failed') return { kind: 'unobservable', cause: status.cause };
  if (status.exitCode !== 0) {
    return {
      kind: 'unobservable',
      cause: `git could not read the status (exit ${status.exitCode}): ${status.stderr.trim()}`,
    };
  }
  const dirtyPaths = status.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > PORCELAIN_STATUS_WIDTH)
    .slice(0, DIRTY_PATH_LIMIT)
    .map((line) => line.slice(PORCELAIN_STATUS_WIDTH));
  return { ...tree, holdsBase: ancestry.exitCode === 0, dirtyPaths };
}
