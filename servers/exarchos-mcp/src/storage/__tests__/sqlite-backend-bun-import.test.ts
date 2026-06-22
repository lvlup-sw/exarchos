import { describe, it, expect } from 'vitest';

import { SqliteBackend } from '../sqlite-backend.js';

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

  it('SqliteBackend_AfterInitializeWithFull_AppliesSynchronousFullPragma', () => {
    // DR-4 read-back proof for the opt-in FULL posture. `PRAGMA synchronous`
    // reports 2 (FULL); the symmetric NORMAL=1 case is proven above. Without
    // this, a regression where `applyConnectionPragmas` ignored 'full' and
    // always emitted NORMAL would still pass the construct-and-append tests.
    const backend = new SqliteBackend(':memory:', { synchronous: 'full' });
    backend.initialize();
    const db = (backend as unknown as {
      db: { query: (sql: string) => { all: () => Array<{ synchronous: number }> } };
    }).db;
    const row = db.query('PRAGMA synchronous').all()[0];
    expect(row?.synchronous).toBe(2);
    backend.close();
  });
});
