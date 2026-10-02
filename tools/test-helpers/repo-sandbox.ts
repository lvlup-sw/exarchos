// A scratch copy of part of the live checkout, under the OS temp directory.
//
// Tests must not write into the checkout they run from: parallel test files
// read the same tree, and a file that one test creates or rewrites for a
// moment is seen by another (#2030). A test that must change a tree copies
// the paths it needs here, changes the copy, and points the code under test
// at the sandbox root. `tests/architecture/no-live-checkout-writes.test.ts`
// forbids every other write under the repository root from test code.
//
// The sandbox runs git through the async spawn helper, so it never blocks the
// worker (#2029). It deletes itself through `rmrf`, so a leaked SQLite handle
// fails the test and a delete that Windows refuses is left for the end-of-run
// sweep (#2027).

import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from './spawn.js';
import { rmrf } from './temp-dir.js';

/** The root of the checkout this module is part of. Tests read it and never write to it. */
export const LIVE_CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What to put in a new sandbox. */
export interface RepoSandboxOptions {
  /** A short name for the temp directory. */
  readonly prefix: string;
  /** Repo-relative files or directories to copy from the live checkout. */
  readonly copy?: readonly string[];
  /** Repo-relative files to write after the copy, with their content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Make the sandbox a git repository with one commit that holds every file. */
  readonly git?: boolean;
}

/** A sandbox made by {@link makeRepoSandbox}. */
export interface RepoSandbox {
  /** The sandbox root, as a real path, so it equals what a child process reports. */
  readonly root: string;
  /** The absolute path inside the sandbox for a repo-relative path. */
  path(relative: string): string;
  /** Writes a file inside the sandbox and creates its parent directories. */
  write(relative: string, content: string | Uint8Array): string;
  /** Runs git in the sandbox with a fixed identity and no inherited `GIT_*` variables, and returns stdout. */
  git(...args: string[]): Promise<string>;
  /** Removes the sandbox through `rmrf`. A second call does nothing. */
  remove(): void;
}

/** Fixed settings so a developer's global git config cannot change a sandbox commit. */
const GIT_CONFIG = [
  '-c', 'user.name=exarchos-sandbox',
  '-c', 'user.email=sandbox@exarchos.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.hooksPath=.git/no-hooks',
];

/** Rejects an absolute path or one that leaves the root, so a typo cannot reach the live tree. */
function insideRoot(root: string, relative: string): string {
  if (relative.length === 0 || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new Error(`repo-sandbox: '${relative}' must be a non-empty repo-relative path`);
  }
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (back.length === 0 || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`repo-sandbox: '${relative}' resolves outside the sandbox`);
  }
  return resolved;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return env;
}

/** Creates a sandbox, copies `copy` from the live checkout into it, then writes `files`. */
export async function makeRepoSandbox(options: RepoSandboxOptions): Promise<RepoSandbox> {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `exarchos-sandbox-${options.prefix}-`)));
  let removed = false;
  const sandbox: RepoSandbox = {
    root,
    path: (relative) => insideRoot(root, relative),
    write: (relative, content) => {
      const target = insideRoot(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    git: (...args) => execFileAsync('git', [...GIT_CONFIG, ...args], { cwd: root, env: gitEnv() }),
    remove: () => {
      if (removed) return;
      removed = true;
      rmrf(root);
    },
  };
  try {
    for (const relative of options.copy ?? []) {
      const source = insideRoot(LIVE_CHECKOUT_ROOT, relative);
      if (!existsSync(source)) throw new Error(`repo-sandbox: '${relative}' does not exist in the live checkout`);
      const target = insideRoot(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
    for (const [relative, content] of Object.entries(options.files ?? {})) sandbox.write(relative, content);
    if (options.git === true) {
      await sandbox.git('init', '-q');
      await sandbox.git('add', '-A');
      await sandbox.git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'sandbox');
    }
  } catch (err) {
    sandbox.remove();
    throw err;
  }
  return sandbox;
}
