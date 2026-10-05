// `PRAGMA busy_timeout = 5000` gives the C layer of SQLite 5 seconds to resolve
// write contention between processes. After that, the bounded retry policy
// (`SQLITE_BUSY_RETRY_POLICY`) takes over.
//
// The two layers do different work. The C layer absorbs short lock contention
// silently. The JavaScript layer counts retries and reports a structured
// failure when the budget ends.

import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

describe('SqliteBackend connection PRAGMAs', () => {
  let tempDir: string | undefined;
  const backends: SqliteBackend[] = [];

  afterEach(() => {
    for (const b of backends) {
      try {
        b.close();
      } catch {
      }
    }
    backends.length = 0;
    if (tempDir) {
      rmrf(tempDir);
      tempDir = undefined;
    }
  });

  /**
   * `busy_timeout` is a connection-level pragma, so the test reads it through the
   * handle that `SqliteBackend` uses. The column name differs between drivers
   * (`timeout`, `busy_timeout`, or unnamed), so the test accepts all three.
   */
  it('SqliteBackend_AppliesBusyTimeoutPragmaOnInitialize', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'exarchos-pragma-'));
    const dbPath = join(tempDir, 'test.db');

    const backend = new SqliteBackend(dbPath);
    backends.push(backend);
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;
    const rows = db.query('PRAGMA busy_timeout').all() as Array<
      Record<string, number>
    >;
    expect(rows).toHaveLength(1);

    const firstRow = rows[0];
    const value =
      firstRow.timeout ??
      firstRow.busy_timeout ??
      firstRow[''] ??
      undefined;

    expect(value).toBe(5000);
  });
});
