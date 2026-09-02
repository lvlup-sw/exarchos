import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SqliteBackend, SchemaVersionTooNewError, SCHEMA_VERSION } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

// ─── P05-04: schema-identity freshness at store open (ART-009) ──────────────
//
// An event store written under a schema identity NEWER than this binary
// understands must not be silently opened — the older binary would re-stamp
// its own lower version and operate against a schema whose invariants it does
// not know. The directional policy mirrors the forward-only migration
// machinery: older stores migrate, equal stores open, strictly-newer stores
// are refused.

describe('SqliteBackend schema-identity freshness (P05-04)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rmrfAsync(d)));
  });

  async function tempDbPath(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return path.join(dir, 'schema-freshness.db');
  }

  /** Reach the live driver handle to seed the schema_version ledger the way a
   * differently-versioned binary would have stamped it. Reflection is the
   * repo's established pattern for driving backend internals in tests (see the
   * DR-4 rollback test's `stmts` access). */
  function stampSchemaVersion(backend: SqliteBackend, version: number): void {
    const db = (backend as unknown as { db: { exec(sql: string): void } }).db;
    db.exec('DELETE FROM schema_version');
    db.exec(
      `INSERT INTO schema_version (version, appliedAt) VALUES (${version}, '2024-01-01T00:00:00.000Z')`,
    );
  }

  it('FreshStore_OpensWithoutError', async () => {
    const dbPath = await tempDbPath('schema-fresh-');
    const backend = new SqliteBackend(dbPath);
    expect(() => backend.initialize()).not.toThrow();
    backend.close();
  });

  it('EqualSchemaStore_Reopens_WithoutError', async () => {
    const dbPath = await tempDbPath('schema-equal-');
    const first = new SqliteBackend(dbPath);
    first.initialize(); // stamps schema_version = SCHEMA_VERSION
    first.close();

    const reopened = new SqliteBackend(dbPath);
    expect(() => reopened.initialize()).not.toThrow();
    reopened.close();
  });

  it('OlderSchemaStore_Opens_ForwardMigratePolicy', async () => {
    const dbPath = await tempDbPath('schema-older-');
    const first = new SqliteBackend(dbPath);
    first.initialize();
    // Rewrite the ledger to an OLDER identity — the guard must NOT refuse this
    // (older stores are forward-migrated, proving the comparison is `>` not
    // `!==`).
    stampSchemaVersion(first, SCHEMA_VERSION - 1);
    first.close();

    const reopened = new SqliteBackend(dbPath);
    expect(() => reopened.initialize()).not.toThrow();
    reopened.close();
  });

  it('NewerSchemaStore_Refused_WithTypedError', async () => {
    const dbPath = await tempDbPath('schema-newer-');
    const first = new SqliteBackend(dbPath);
    first.initialize();
    stampSchemaVersion(first, SCHEMA_VERSION + 1);
    first.close();

    const reopened = new SqliteBackend(dbPath);
    let caught: unknown;
    try {
      reopened.initialize();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaVersionTooNewError);
    const typed = caught as SchemaVersionTooNewError;
    expect(typed.code).toBe('SCHEMA_VERSION_TOO_NEW');
    expect(typed.storeVersion).toBe(SCHEMA_VERSION + 1);
    expect(typed.binaryVersion).toBe(SCHEMA_VERSION);
    expect(typed.message).toContain('newer Exarchos release');
    // The refused handle is closed so the file isn't left locked; a subsequent
    // open attempt still refuses (idempotent, no state advanced).
    const retry = new SqliteBackend(dbPath);
    expect(() => retry.initialize()).toThrow(SchemaVersionTooNewError);
  });
});
