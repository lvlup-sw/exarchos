// `closeOpenUnder` must close a handle whose path is an alias of the swept dir.
//
// `rmrf()` and `rmrfAsync()` close every open SQLite handle under a temp dir
// before they delete it. The sweep compares paths, so both paths must spell
// one location the same way. On Windows runners `os.tmpdir()` can give the 8.3
// short name while the store gives the long name. Then the sweep skips a
// contained handle, and the delete fails on a live `-shm` file. A symlink
// gives the same defect on every platform. The sweep canonicalizes both paths.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const created: string[] = [];

/**
 * Makes a canonical scratch parent. macOS reports `/var/…` for a
 * `/private/var/…` tmpdir. Without `realpathSync`, the harness itself adds an
 * alias of the kind that the tests examine.
 */
function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'close-under-')));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmrf(dir);
});

describe('SqliteBackend.closeOpenUnder — containment survives path aliasing', () => {
  /**
   * The backend opens the file through the alias, and the sweep gets the real
   * path, as `rmrf(tmpDir)` does. `initialize()` registers the handle, and the
   * constructor does not. The count check before the sweep proves that the set
   * is not empty. A second `close()` on the closed backend must not throw.
   */
  it('CloseOpenUnder_HandleOpenedViaAliasPath_IsStillClosed', () => {
    const parent = scratchDir();
    const realDir = join(parent, 'real');
    const aliasDir = join(parent, 'alias');
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir, 'dir');

    const backend = new SqliteBackend(join(aliasDir, 'exarchos.db'));
    backend.initialize();
    const before = SqliteBackend.openHandleCount();
    expect(before).toBeGreaterThan(0);

    SqliteBackend.closeOpenUnder(realDir);

    expect(
      SqliteBackend.openHandleCount(),
      'a handle contained in the swept directory survived because the two paths spelled it differently',
    ).toBe(before - 1);

    expect(() => {
      backend.close();
    }).not.toThrow();
  });

  /**
   * A `db.close()` that threw did not close the handle. If the backend leaves the
   * registry before the attempt, `openHandleCount()` reads zero while the OS
   * handle stays open. Then the sweep has nothing to retry, and teardown fails
   * with `EBUSY` on NTFS. The retry must succeed when the driver closes.
   */
  it('Close_UnderlyingCloseThrows_StaysRegisteredForARetry', () => {
    const parent = scratchDir();
    const backend = new SqliteBackend(join(parent, 'exarchos.db'));
    backend.initialize();
    const before = SqliteBackend.openHandleCount();
    expect(before).toBeGreaterThan(0);

    const db = (backend as unknown as { db: { close: () => void } }).db;
    const realClose = db.close.bind(db);
    let failNext = true;
    db.close = (): void => {
      if (failNext) throw new Error('driver refused to close');
      realClose();
    };

    expect(() => {
      backend.close();
    }).not.toThrow();
    expect(
      SqliteBackend.openHandleCount(),
      'a backend whose close threw was de-registered, so nothing can ever retry it',
    ).toBe(before);

    failNext = false;
    backend.close();
    expect(SqliteBackend.openHandleCount()).toBe(before - 1);
  });

  /**
   * The negative case. Without it, a sweep that closes every open handle passes
   * the alias test and closes unrelated stores. The count check before the sweep
   * proves that a handle exists.
   */
  it('CloseOpenUnder_HandleOutsideTheDirectory_IsLeftOpen', () => {
    const parent = scratchDir();
    const inside = join(parent, 'inside');
    const outside = join(parent, 'outside');
    mkdirSync(inside);
    mkdirSync(outside);

    const keep = new SqliteBackend(join(outside, 'exarchos.db'));
    keep.initialize();
    try {
      const before = SqliteBackend.openHandleCount();
      expect(before).toBeGreaterThan(0);
      SqliteBackend.closeOpenUnder(inside);
      expect(SqliteBackend.openHandleCount()).toBe(before);
    } finally {
      keep.close();
    }
  });
});
