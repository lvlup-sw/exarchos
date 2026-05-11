// ─── Wave 1 (Task 1.8): PRAGMA busy_timeout C-layer safety net ───────────
//
// Audit finding §F2.2 (docs/research/2026-05-10-v2-10-pre2-implementation-
// audit-findings.md) calls for setting `PRAGMA busy_timeout = 5000` so
// SQLite's C layer has a 5-second window to silently resolve cross-process
// write contention before the JS-layer's bounded retry policy
// (SQLITE_BUSY_RETRY_POLICY in sqlite-backend.ts) escalates.
//
// The two layers are NOT redundant. The C layer is the silent absorption
// path — it observes intra-millisecond lock contention that the JS layer
// would otherwise surface as SQLITE_BUSY exceptions. The JS layer is the
// observability path — it counts retries and emits structured failures
// after the budget runs out. Removing either layer breaks one of those
// guarantees.

import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteBackend } from './sqlite-backend.js';

describe('SqliteBackend connection PRAGMAs', () => {
  let tempDir: string | undefined;
  const backends: SqliteBackend[] = [];

  afterEach(() => {
    for (const b of backends) {
      try {
        b.close();
      } catch {
        // already closed
      }
    }
    backends.length = 0;
    if (tempDir) {
      rmSync(tempDir, { recursive: true });
      tempDir = undefined;
    }
  });

  it('SqliteBackend_AppliesBusyTimeoutPragmaOnInitialize', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'exarchos-pragma-'));
    const dbPath = join(tempDir, 'test.db');

    const backend = new SqliteBackend(dbPath);
    backends.push(backend);
    backend.initialize();

    // Reach into the backend to read its own PRAGMA value. We could also
    // open a sibling Database handle pointed at the same file, but
    // busy_timeout is a connection-level pragma (per-handle, not on-disk),
    // so the only correct way to verify it is to query through the same
    // handle SqliteBackend uses for writes.
    const db = (backend as unknown as { db: Database }).db;
    const rows = db.query('PRAGMA busy_timeout').all() as Array<
      Record<string, number>
    >;
    expect(rows).toHaveLength(1);

    // PRAGMA busy_timeout returns the value in a single column. Column
    // name varies across drivers: better-sqlite3 uses `timeout`,
    // bun:sqlite has historically returned the value under `busy_timeout`
    // or unnamed. Tolerate all three shapes so the assertion is portable.
    const firstRow = rows[0];
    const value =
      firstRow.timeout ??
      firstRow.busy_timeout ??
      firstRow[''] ??
      undefined;

    expect(value).toBe(5000);
  });
});
