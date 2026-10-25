/**
 * The shared git observation of a tree: its root, its repository, its branch and its head commit.
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

/** The exit code with which git reports a detached HEAD to `symbolic-ref --quiet`, and an unborn HEAD to `rev-parse --verify --quiet`. */
const GIT_ABSENT_EXIT_CODE = 1;

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
type TreeObservation =
  | {
      readonly kind: 'tree';
      readonly toplevel: string;
      readonly repository: string;
      readonly branch?: string;
      readonly head?: string;
    }
  | { readonly kind: 'no-work-tree'; readonly path: string }
  | { readonly kind: 'unobservable'; readonly cause: string };

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
 * Observes the tree that holds `dir` with three git calls: the root and the common dir, the branch of HEAD, and the HEAD commit.
 * The root and the common dir go through {@link canonicalPath}, so a symbolic link or a short name gives the same tree.
 * A directory outside any git work tree gives `no-work-tree` with its canonical path. A path that does not exist keeps its lexical form.
 */
export async function observeTree(dir: string): Promise<TreeObservation> {
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

  const [branchOutcome, headOutcome] = await Promise.all([
    runGit(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD']),
  ]);
  const branch = optionalRead(branchOutcome, 'the branch of HEAD');
  if (branch.kind === 'failed') return { kind: 'unobservable', cause: branch.cause };
  const head = optionalRead(headOutcome, 'the HEAD commit');
  if (head.kind === 'failed') return { kind: 'unobservable', cause: head.cause };

  return {
    kind: 'tree',
    toplevel: canonicalPath(toplevel),
    repository: canonicalPath(commonDir),
    ...(branch.value === undefined ? {} : { branch: branch.value }),
    ...(head.value === undefined ? {} : { head: head.value }),
  };
}
