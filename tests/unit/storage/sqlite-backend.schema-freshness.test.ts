import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SqliteBackend, SchemaVersionTooNewError, SCHEMA_VERSION } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * A binary must not open a store with a schema version newer than its own.
 * Without the guard, the binary stamps its lower version and runs against a
 * schema that it does not know. The backend migrates an older store, opens an
 * equal store, and refuses a newer store.
 *
 * `stampSchemaVersion` rewrites the ledger through the live driver handle, to
 * give the store the version of a different binary.
 */
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

  /** The first `initialize()` stamps `SCHEMA_VERSION` in the ledger. */
  it('EqualSchemaStore_Reopens_WithoutError', async () => {
    const dbPath = await tempDbPath('schema-equal-');
    const first = new SqliteBackend(dbPath);
    first.initialize();
    first.close();

    const reopened = new SqliteBackend(dbPath);
    expect(() => reopened.initialize()).not.toThrow();
    reopened.close();
  });

  /**
   * An older ledger version must pass. This proves that the guard compares with
   * `>` and not with `!==`.
   */
  it('OlderSchemaStore_Opens_ForwardMigratePolicy', async () => {
    const dbPath = await tempDbPath('schema-older-');
    const first = new SqliteBackend(dbPath);
    first.initialize();
    stampSchemaVersion(first, SCHEMA_VERSION - 1);
    first.close();

    const reopened = new SqliteBackend(dbPath);
    expect(() => reopened.initialize()).not.toThrow();
    reopened.close();
  });

  /**
   * The guard closes the refused handle, so the file stays unlocked. The backend
   * refuses a second open in the same way.
   */
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
    const retry = new SqliteBackend(dbPath);
    expect(() => retry.initialize()).toThrow(SchemaVersionTooNewError);
  });
});
