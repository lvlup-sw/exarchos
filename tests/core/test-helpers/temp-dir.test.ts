/**
 * The temp-dir helpers decide a test's verdict from what the code controls (#2027).
 *
 * A handle that its close cannot release fails the test and names the path.
 * A delete that the operating system refuses does not fail the test inside
 * the run root, and still fails it outside. The refusal is injected through
 * the `remove` seam, so these tests do not depend on Windows. They live in
 * the `core` project because it aliases `bun:sqlite` and opens real handles.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs, { type RmOptions } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Database } from '../../../src/storage/__shims__/bun-sqlite-node.js';
import { trackedDatabases } from '../../../src/storage/__shims__/open-database-registry.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import {
  LeakedHandleError,
  isInsideRunRoot,
  makeTempDir,
  rmrf,
  rmrfAsync,
} from '../../../tools/test-helpers/temp-dir.js';
import { TEST_TMP_ROOT_ENV } from '../../../tools/test-helpers/temp-run-root.js';

/** The refusal codes that the helpers leave for the sweep inside the run root. */
const REFUSALS: readonly string[] = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'];

/** Directories that a test made, removed after it with the real helper. */
const made: string[] = [];

/** Cleanup for a handle that a test held open on purpose. */
const releases: Array<() => void> = [];

/** A temp directory that the test owns, removed in `afterEach`. */
function scratch(prefix: string): string {
  const dir = makeTempDir(prefix);
  made.push(dir);
  return dir;
}

/** An error such as the operating system raises when it refuses a delete. */
function refusal(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked, rmdir`), { code });
}

/** A database under `dir` whose close throws while an iterator is still open. */
function heldOpenDatabase(dir: string): { file: string; release: () => void } {
  const file = path.join(dir, 'held.db');
  const db = new Database(file);
  db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2), (3);');
  const rows = db.prepare('SELECT v FROM t').iterate();
  rows.next();
  const release = (): void => {
    rows.return?.();
    db.close();
  };
  releases.push(release);
  return { file, release };
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const dir of made.splice(0)) rmrf(dir);
});

describe('rmrf leak check (#2027)', () => {
  it('Rmrf_HandleThatCannotClose_FailsNamingThePathAndTheCloseError', () => {
    const dir = scratch('leak-held-');
    const { file } = heldOpenDatabase(dir);

    let thrown: unknown;
    try {
      rmrf(dir);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(LeakedHandleError);
    expect(String(thrown)).toContain(file);
    expect(String(thrown)).toContain('busy executing a query');
    expect(fs.existsSync(dir), 'the helper deleted a tree that still has an open handle').toBe(true);
  });

  it('Rmrf_BackendWhoseCloseFails_FailsNamingThePath', () => {
    const dir = scratch('leak-backend-');
    const backend = new SqliteBackend(path.join(dir, 'exarchos.db'));
    backend.initialize();
    const db: unknown = Reflect.get(backend, 'db');
    if (!(db instanceof Database)) throw new Error('the backend did not open its connection through the shim');
    const rows = db.prepare('SELECT 1 AS v UNION ALL SELECT 2').iterate();
    rows.next();
    releases.push(() => {
      rows.return?.();
      backend.close();
    });

    expect(() => rmrf(dir)).toThrow(LeakedHandleError);
    expect(() => rmrf(dir)).toThrow(/exarchos\.db \(close error: TypeError: This database connection is busy/);
  });

  it('RmrfAsync_HandleThatCannotClose_RejectsNamingThePath', async () => {
    const dir = scratch('leak-held-async-');
    const { file } = heldOpenDatabase(dir);

    await expect(rmrfAsync(dir)).rejects.toThrow(file);
  });

  it('Rmrf_LeakedHandleThatCanClose_IsClosedAndTheTreeRemoved', () => {
    const dir = scratch('leak-closable-');
    const db = new Database(path.join(dir, 'leaked.db'));
    db.exec('CREATE TABLE t (v INTEGER);');
    expect(trackedDatabases().has(db)).toBe(true);

    rmrf(dir);

    expect(db.open).toBe(false);
    expect(trackedDatabases().has(db)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('Rmrf_HandleOutsideTheDirectory_IsLeftOpen', () => {
    const dir = scratch('leak-scope-');
    const elsewhere = scratch('leak-elsewhere-');
    const db = new Database(path.join(elsewhere, 'kept.db'));
    releases.push(() => db.close());

    rmrf(dir);

    expect(db.open, 'the helper closed a handle outside the directory it deleted').toBe(true);
  });
});

describe('rmrf refused delete (#2027)', () => {
  it.each(REFUSALS)('Rmrf_%sInsideTheRunRoot_LeavesTheTreeForTheSweep', (code) => {
    const runRoot = scratch('run-root-');
    const dir = fs.mkdtempSync(path.join(runRoot, 'refused-'));
    const remove = (): void => {
      throw refusal(code);
    };

    expect(() => rmrf(dir, { remove, runRoot })).not.toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it.each(REFUSALS)('RmrfAsync_%sInsideTheRunRoot_Resolves', async (code) => {
    const runRoot = scratch('run-root-async-');
    const dir = fs.mkdtempSync(path.join(runRoot, 'refused-'));
    const remove = async (): Promise<void> => {
      throw refusal(code);
    };

    await expect(rmrfAsync(dir, { remove, runRoot })).resolves.toBeUndefined();
  });

  it('Rmrf_RefusedDeleteOutsideTheRunRoot_Throws', () => {
    const runRoot = scratch('run-root-other-');
    const dir = scratch('outside-');
    const remove = (): void => {
      throw refusal('EBUSY');
    };

    expect(() => rmrf(dir, { remove, runRoot })).toThrow(/EBUSY/);
  });

  it('RmrfAsync_RefusedDeleteOutsideTheRunRoot_Rejects', async () => {
    const runRoot = scratch('run-root-other-async-');
    const dir = scratch('outside-async-');
    const remove = async (): Promise<void> => {
      throw refusal('EPERM');
    };

    await expect(rmrfAsync(dir, { remove, runRoot })).rejects.toThrow(/EPERM/);
  });

  it('Rmrf_RefusedDeleteWithNoRunRoot_Throws', () => {
    const dir = scratch('no-root-');
    const remove = (): void => {
      throw refusal('EBUSY');
    };

    expect(() => rmrf(dir, { remove, runRoot: undefined })).toThrow(/EBUSY/);
  });

  it('Rmrf_OtherErrorInsideTheRunRoot_Throws', () => {
    const runRoot = scratch('run-root-io-');
    const dir = fs.mkdtempSync(path.join(runRoot, 'io-'));
    const remove = (): void => {
      throw refusal('EIO');
    };

    expect(() => rmrf(dir, { remove, runRoot })).toThrow(/EIO/);
  });

  it('Rmrf_InsideTheRunRoot_DeletesOnceWithoutRetries', () => {
    const runRoot = scratch('run-root-once-');
    const dir = fs.mkdtempSync(path.join(runRoot, 'once-'));
    const calls: RmOptions[] = [];
    const remove = (_dir: string, options: RmOptions): void => {
      calls.push(options);
    };

    rmrf(dir, { remove, runRoot });

    expect(calls).toEqual([{ recursive: true, force: true }]);
  });
});

describe('run root in a core worker (#2027)', () => {
  it('TempRunRoot_CoreWorker_TmpdirIsInsideTheRunRoot', () => {
    const runRoot = process.env[TEST_TMP_ROOT_ENV];

    expect(runRoot, 'the global setup did not give this worker a run root').toBeTruthy();
    expect(fs.realpathSync.native(runRoot ?? '')).toBe(runRoot);
    expect(isInsideRunRoot(os.tmpdir(), runRoot)).toBe(true);
    expect(isInsideRunRoot(scratch('inherited-'), runRoot)).toBe(true);
  });
});
