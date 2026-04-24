import { describe, it, expect } from 'vitest';

import { SqliteBackend } from '../sqlite-backend.js';

describe('sqlite-backend bun:sqlite import contract', () => {
  it('SqliteBackend_ConstructsFromInMemoryPath_ViaBunSqliteImport', () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    expect(typeof backend.close).toBe('function');
    backend.close();
  });
});
