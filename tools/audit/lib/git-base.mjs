// @ts-check
/**
 * @fileoverview Git helpers that compare the working tree with a base branch.
 *
 * On a pull request the base is `origin/$GITHUB_BASE_REF`. If the shallow checkout does not
 * have it, `resolveBase` fetches it with depth 1. A pull request without `GITHUB_BASE_REF` fails
 * closed. On a push run, and locally without `origin/main`, there is no base and the caller skips.
 */

import { execFileSync, spawnSync } from 'node:child_process';

/** Raised when a base is required but git cannot supply it. */
export class GitBaseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GitBaseError';
  }
}

/**
 * Run git and return its standard output.
 *
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The commit that a ref names, or `undefined` when git does not know the ref.
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {string | undefined}
 */
export function revParse(ref, cwd) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Make a remote branch available, with a depth-1 fetch when the checkout does not have it.
 *
 * @param {string} branch
 * @param {string} cwd
 * @returns {string} A ref that names the branch tip.
 */
function ensureRemoteBranch(branch, cwd) {
  const remoteRef = `origin/${branch}`;
  if (revParse(remoteRef, cwd) !== undefined) return remoteRef;
  const fetched = spawnSync('git', ['fetch', '--depth=1', 'origin', branch], { cwd, encoding: 'utf8' });
  if (fetched.status === 0 && revParse('FETCH_HEAD', cwd) !== undefined) return 'FETCH_HEAD';
  throw new GitBaseError(`cannot resolve ${remoteRef}, and \`git fetch origin ${branch}\` failed: ${fetched.stderr.trim()}`);
}

/**
 * The base to compare with, or a reason to skip the comparison.
 *
 * @typedef {{ ref: string, mode: 'explicit' | 'pull-request' | 'local' } | { ref: undefined, mode: 'push' | 'none', reason: string }} BaseResolution
 */

/**
 * Resolve the base branch for this run.
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {NodeJS.ProcessEnv} input.env
 * @param {string} [input.explicit] A ref that the caller names, which wins over everything else.
 * @returns {BaseResolution}
 */
export function resolveBase({ cwd, env, explicit }) {
  if (explicit !== undefined) {
    if (revParse(explicit, cwd) === undefined) throw new GitBaseError(`--base ${explicit} does not name a commit.`);
    return { ref: explicit, mode: 'explicit' };
  }
  const event = env.GITHUB_EVENT_NAME ?? '';
  if (event.startsWith('pull_request')) {
    const branch = env.GITHUB_BASE_REF ?? '';
    if (branch.length === 0) {
      throw new GitBaseError('this is a pull_request run, but GITHUB_BASE_REF is not set. Refusing to skip the base comparison.');
    }
    return { ref: ensureRemoteBranch(branch, cwd), mode: 'pull-request' };
  }
  if (env.GITHUB_ACTIONS === 'true') {
    return { ref: undefined, mode: 'push', reason: 'push run: the pull request already made this comparison' };
  }
  if (revParse('origin/main', cwd) === undefined) {
    return { ref: undefined, mode: 'none', reason: 'no origin/main in this checkout' };
  }
  const mergeBase = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd, encoding: 'utf8' });
  return { ref: mergeBase.status === 0 ? mergeBase.stdout.trim() : 'origin/main', mode: 'local' };
}

/**
 * Read files at a ref in one `git cat-file --batch` call. A path that does not exist at the ref maps to `undefined`.
 *
 * @param {string} ref
 * @param {readonly string[]} paths
 * @param {string} cwd
 * @returns {Map<string, string | undefined>}
 */
export function readAtRef(ref, paths, cwd) {
  /** @type {Map<string, string | undefined>} */
  const out = new Map();
  if (paths.length === 0) return out;
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    input: paths.map((p) => `${ref}:${p}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) throw new GitBaseError(`git cat-file --batch failed: ${String(result.stderr)}`);
  const buffer = result.stdout;
  let cursor = 0;
  for (const p of paths) {
    const newline = buffer.indexOf(10, cursor);
    if (newline === -1) throw new GitBaseError(`git cat-file --batch ended early at ${p}.`);
    const header = buffer.subarray(cursor, newline).toString('utf8');
    cursor = newline + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      out.set(p, undefined);
      continue;
    }
    const size = Number(header.split(' ')[2]);
    if (!Number.isInteger(size)) throw new GitBaseError(`unexpected git cat-file header for ${p}: ${header}`);
    out.set(p, header.split(' ')[1] === 'blob' ? buffer.subarray(cursor, cursor + size).toString('utf8') : undefined);
    cursor += size + 1;
  }
  return out;
}

/**
 * The change between a ref and the working tree, by path.
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {{ renamedFrom: Map<string, string>, added: Set<string> }} `renamedFrom` maps a new path to its old path.
 */
export function diffFromRef(ref, cwd) {
  const tokens = git(['diff', '-M', '--name-status', '-z', ref], cwd).split('\0').filter((t) => t.length > 0);
  /** @type {Map<string, string>} */
  const renamedFrom = new Map();
  /** @type {Set<string>} */
  const added = new Set();
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[i + 1] ?? '';
      const to = tokens[i + 2] ?? '';
      if (status.startsWith('R')) renamedFrom.set(to, from);
      else added.add(to);
      i += 3;
    } else {
      if (status === 'A') added.add(tokens[i + 1] ?? '');
      i += 2;
    }
  }
  return { renamedFrom, added };
}

/**
 * Every tracked file in the working tree, as POSIX paths.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function trackedFiles(cwd) {
  return git(['ls-files', '-z'], cwd).split('\0').filter((p) => p.length > 0);
}
