import { describe, it, expect } from 'vitest';

import { closeOpenDatabases } from '../../../src/storage/__shims__/bun-sqlite-node.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';

describe('sqlite-backend bun:sqlite import contract', () => {
  it('SqliteBackend_ConstructsFromInMemoryPath_ViaBunSqliteImport', () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    expect(typeof backend.close).toBe('function');
    backend.close();
  });

  it('SqliteBackend_AfterInitialize_AppliesSynchronousNormalPragma', () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    const db = (backend as unknown as {
      db: { query: (sql: string) => { all: () => Array<{ synchronous: number }> } };
    }).db;
    const row = db.query('PRAGMA synchronous').all()[0];
    expect(row?.synchronous).toBe(1);
    backend.close();
  });

  /**
   * `PRAGMA synchronous` reports 2 for FULL. This read-back fails if
   * `applyConnectionPragmas` ignores `'full'` and always sets NORMAL.
   */
  it('SqliteBackend_AfterInitializeWithFull_AppliesSynchronousFullPragma', () => {
    const backend = new SqliteBackend(':memory:', { synchronous: 'full' });
    backend.initialize();
    const db = (backend as unknown as {
      db: { query: (sql: string) => { all: () => Array<{ synchronous: number }> } };
    }).db;
    const row = db.query('PRAGMA synchronous').all()[0];
    expect(row?.synchronous).toBe(2);
    backend.close();
  });

  it('CloseOpenDatabases_EmptySet_DoesNotThrow', () => {
    expect(() => closeOpenDatabases()).not.toThrow();
  });

  it('CloseOpenDatabases_ClosesTrackedShimHandles', async () => {
    const { Database } = await import('../../../src/storage/__shims__/bun-sqlite-node.js');
    const db = new Database(':memory:');
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
    closeOpenDatabases();
    expect(() => db.prepare('SELECT 1 AS n').get()).toThrow();
  });
});
