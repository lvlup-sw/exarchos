// ─── closeOpenUnder must survive path ALIASING (#1699 / #1620) ───────────────
//
// `rmrf()`/`rmrfAsync()` sweep every open SQLite handle under a temp dir before
// removing it, which is what lets a test delete a tree containing a store some
// production call opened and the test never named. The sweep decides "is this
// handle under that dir?" by string prefix, so it is only as good as the two
// paths agreeing on ONE spelling of the same location.
//
// They do not always agree. On the Windows runners `os.tmpdir()` yields the 8.3
// SHORT name (`C:\Users\RUNNER~1\…`, visible verbatim in the failures) while a
// long-form normalisation anywhere in the store's construction yields
// `C:\Users\runneradmin\…`. Same directory, different strings — so `relative()`
// returns a `..`-path, the sweep skips a handle that IS contained, and `fs.rm`
// then hits `EBUSY: resource busy or locked, unlink '…\exarchos.db-shm'`. A live
// `-shm` proves a connection is still open: SQLite unlinks `-wal`/`-shm` when the
// last one closes, so this is a handle that was never swept, not a retry budget
// that was too small (see the note on RM_MAX_RETRIES in `test-helpers/temp-dir.ts`).
//
// A symlink is the same defect shape reachable on every platform: two paths
// naming one directory. If the sweep canonicalises, the alias is irrelevant.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteBackend } from './sqlite-backend.js';
import { rmrf } from '../test-helpers/temp-dir.js';

const created: string[] = [];

/**
 * A canonical scratch parent. `realpathSync` because macOS reports `/var/…` for
 * a `/private/var/…` tmpdir — without it the harness itself would introduce the
 * alias under test and the negative case could not be told apart.
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
  it('CloseOpenUnder_HandleOpenedViaAliasPath_IsStillClosed', () => {
    const parent = scratchDir();
    const realDir = join(parent, 'real');
    const aliasDir = join(parent, 'alias');
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir, 'dir');

    // The handle is opened through the ALIAS, exactly as a store constructed
    // from a differently-normalised path would be. `initialize()` is what opens
    // the file and registers the handle — constructing alone registers nothing,
    // so a version of this test without it would sweep an empty set and pass.
    const backend = new SqliteBackend(join(aliasDir, 'exarchos.db'));
    backend.initialize();
    const before = SqliteBackend.openHandleCount();
    expect(before).toBeGreaterThan(0);

    // …and swept by the REAL path, as `rmrf(tmpDir)` does in teardown.
    SqliteBackend.closeOpenUnder(realDir);

    expect(
      SqliteBackend.openHandleCount(),
      'a handle contained in the swept directory survived because the two paths spelled it differently',
    ).toBe(before - 1);

    // Idempotent: closing an already-closed backend must not throw.
    expect(() => {
      backend.close();
    }).not.toThrow();
  });

  it('CloseOpenUnder_HandleOutsideTheDirectory_IsLeftOpen', () => {
    // The negative twin. Without it, a sweep that closed EVERY open handle would
    // satisfy the case above while quietly killing unrelated stores.
    const parent = scratchDir();
    const inside = join(parent, 'inside');
    const outside = join(parent, 'outside');
    mkdirSync(inside);
    mkdirSync(outside);

    const keep = new SqliteBackend(join(outside, 'exarchos.db'));
    keep.initialize();
    try {
      const before = SqliteBackend.openHandleCount();
      // Non-vacuity: there has to BE a handle for "left open" to mean anything.
      expect(before).toBeGreaterThan(0);
      SqliteBackend.closeOpenUnder(inside);
      expect(SqliteBackend.openHandleCount()).toBe(before);
    } finally {
      keep.close();
    }
  });
});
