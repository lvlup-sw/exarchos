/**
 * Temp directories for tests: create one, then check it for leaked handles and delete it.
 *
 * `rmrf` and `rmrfAsync` first close every tracked SQLite handle under the
 * directory. If a handle stays open, they throw an error that names the
 * database path and the close error. That check does not depend on the
 * operating system. Then they delete the directory once. Windows can refuse a
 * delete while a process that the test does not control (an antivirus or the
 * search indexer) holds a file. Inside the run root that the vitest global
 * setup creates, a refused delete is left for the end-of-run sweep and the
 * test passes. Outside the run root, a refused delete still throws (#2027).
 */
import type { RmOptions } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { trackedDatabases } from '../../src/storage/__shims__/open-database-registry.js';
import { TEST_TMP_ROOT_ENV } from './temp-run-root.js';

/**
 * The real `node:fs`. A test file can mock `node:fs`, but teardown must still
 * act on the real tree, so this module loads it through `require`, which a
 * vitest mock does not replace.
 */
const fs: typeof import('node:fs') = createRequire(import.meta.url)('node:fs');

/** The error codes with which an operating system refuses to delete a held tree. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/**
 * The options for a delete inside the run root. One attempt only: a refusal
 * there is left for the sweep, so a retry only costs time.
 */
const INSIDE_ROOT_REMOVE: RmOptions = { recursive: true, force: true };

/**
 * The options for a delete outside the run root. A refusal there fails the
 * test, so the delete keeps a small retry budget for a transient lock.
 */
const OUTSIDE_ROOT_REMOVE: RmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

/** The run root that the global setup gave this process, if any. */
const RUN_ROOT = process.env[TEST_TMP_ROOT_ENV] === '' ? undefined : process.env[TEST_TMP_ROOT_ENV];

/** The part of the storage backend's handle registry that the leak check uses. */
interface BackendRegistry {
  /** Closes every backend whose database file is under the directory. */
  closeOpenUnder(dir: string): void;
}

/**
 * Loads the storage backend's registry. Only the tiers that alias `bun:sqlite`
 * can load the backend. Elsewhere (the other tiers, or a script under `tsx`)
 * the import fails on the `bun:` specifier. No backend can be open there, so
 * there is nothing to close. Any other import error is thrown.
 */
async function loadBackendRegistry(): Promise<BackendRegistry | undefined> {
  try {
    const storage = await import('../../src/storage/sqlite-backend.js');
    return storage.SqliteBackend;
  } catch (err) {
    if (String(err).includes('bun:')) return undefined;
    throw err;
  }
}

/** The storage backend's registry, or undefined in a tier without SQLite. */
const backendRegistry = await loadBackendRegistry();

/** A tracked handle under a directory that its close did not release. */
export interface LeakedHandle {
  /** The database file that is still open. */
  readonly path: string;
  /** The error that the close threw, or undefined if it threw nothing. */
  readonly closeError: unknown;
}

/** A test left a handle open under a directory that it deleted. */
export class LeakedHandleError extends Error {
  /** The directory that the test asked to delete. */
  readonly dir: string;
  /** Every handle that is still open under it. */
  readonly leaks: readonly LeakedHandle[];

  constructor(dir: string, leaks: readonly LeakedHandle[]) {
    const detail = leaks.map((leak) => `${leak.path} (close error: ${describeError(leak.closeError)})`);
    super(`A tracked SQLite handle under ${dir} is still open after close: ${detail.join('; ')}`);
    this.name = 'LeakedHandleError';
    this.dir = dir;
    this.leaks = leaks;
  }
}

/** The ways a test of this module can change a delete. */
export interface RemovalSeams {
  /** Deletes the tree. The default is `fs.rmSync`. */
  readonly remove?: (dir: string, options: RmOptions) => void;
  /** The run root. The default is the root that the global setup created. */
  readonly runRoot?: string | undefined;
}

/** The asynchronous form of {@link RemovalSeams}. */
export interface AsyncRemovalSeams {
  /** Deletes the tree. The default is `fs.promises.rm`. */
  readonly remove?: (dir: string, options: RmOptions) => Promise<void>;
  /** The run root. The default is the root that the global setup created. */
  readonly runRoot?: string | undefined;
}

/**
 * Closes every tracked handle under `dir`, then throws a
 * {@link LeakedHandleError} if one is still open.
 */
export function releaseHandlesUnder(dir: string): void {
  backendRegistry?.closeOpenUnder(dir);
  const root = canonicalPath(dir);
  const leaks: LeakedHandle[] = [];
  for (const db of [...trackedDatabases()]) {
    if (!db.open || !isFileName(db.name) || !isWithin(root, canonicalPath(db.name))) continue;
    let closeError: unknown;
    try {
      db.close();
    } catch (err) {
      closeError = err;
    }
    if (db.open) leaks.push({ path: db.name, closeError });
  }
  if (leaks.length > 0) throw new LeakedHandleError(dir, leaks);
}

/**
 * Deletes a temp directory after the leak check. A missing directory is not
 * an error, so this is safe in every `afterEach`.
 */
export function rmrf(dir: string, seams: RemovalSeams = {}): void {
  releaseHandlesUnder(dir);
  const inside = isInsideRunRoot(dir, 'runRoot' in seams ? seams.runRoot : RUN_ROOT);
  const remove = seams.remove ?? fs.rmSync;
  try {
    remove(dir, inside ? INSIDE_ROOT_REMOVE : OUTSIDE_ROOT_REMOVE);
  } catch (err) {
    if (inside && isRefusal(err)) return;
    throw err;
  }
}

/** The asynchronous form of {@link rmrf}, for teardown that awaits `fs.promises.rm`. */
export async function rmrfAsync(dir: string, seams: AsyncRemovalSeams = {}): Promise<void> {
  releaseHandlesUnder(dir);
  const inside = isInsideRunRoot(dir, 'runRoot' in seams ? seams.runRoot : RUN_ROOT);
  const remove = seams.remove ?? fs.promises.rm;
  try {
    await remove(dir, inside ? INSIDE_ROOT_REMOVE : OUTSIDE_ROOT_REMOVE);
  } catch (err) {
    if (inside && isRefusal(err)) return;
    throw err;
  }
}

/** Creates a unique temp directory under the OS temp root and returns its path. */
export function makeTempDir(prefix = 'exarchos-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** True when `dir` is the run root or a path inside it. */
export function isInsideRunRoot(dir: string, runRoot: string | undefined): boolean {
  return runRoot !== undefined && runRoot !== '' && isWithin(canonicalPath(runRoot), canonicalPath(dir));
}

/** True when the error is one with which the operating system refuses a delete. */
function isRefusal(err: unknown): boolean {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' && REFUSAL_CODES.has(err.code);
}

/** True when a connection name is a file, not an in-memory or temporary database. */
function isFileName(name: string): boolean {
  return name !== '' && name !== ':memory:' && !name.startsWith('file:');
}

/** True when `candidate` is `root` or a path below it. Both must be canonical. */
function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The long, real form of a path. A Windows 8.3 short name or a symlink would
 * otherwise make a contained path look outside. If the path does not exist,
 * the parent is resolved and the leaf is added back.
 */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

/** A one-line description of a thrown value. */
function describeError(err: unknown): string {
  if (err === undefined) return 'none';
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
