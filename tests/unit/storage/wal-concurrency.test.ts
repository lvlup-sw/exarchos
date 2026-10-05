import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'workflow.started',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

describe('SqliteBackend WAL Concurrency (file-based)', () => {
  let tempDir: string;
  const backends: SqliteBackend[] = [];

  function createTempDb(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'exarchos-wal-'));
    return join(tempDir, 'test.db');
  }

  function trackBackend(backend: SqliteBackend): SqliteBackend {
    backends.push(backend);
    return backend;
  }

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
    }
  });

  it('SqliteBackend_fileBased_UsesWALJournalMode', () => {
    const dbPath = createTempDb();
    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: { query: (sql: string) => { all: () => Array<{ journal_mode: string }> } } }).db;
    const result = db.query('PRAGMA journal_mode').all();

    expect(result[0].journal_mode).toBe('wal');
  });

  /**
   * Two backends hold the same file open. The writes and the reads run in
   * sequence, and a read must not throw SQLITE_BUSY.
   */
  it('SqliteBackend_twoInstances_ConcurrentReadWriteNoBlocking', () => {
    const dbPath = createTempDb();

    const writer = trackBackend(new SqliteBackend(dbPath));
    writer.initialize();

    const reader = trackBackend(new SqliteBackend(dbPath));
    reader.initialize();

    for (let i = 1; i <= 5; i++) {
      writer.appendEvent('stream-a', makeEvent({ streamId: 'stream-a', sequence: i }));
    }

    const events = reader.queryEvents('stream-a');
    expect(events).toHaveLength(5);

    for (let i = 6; i <= 10; i++) {
      writer.appendEvent('stream-a', makeEvent({ streamId: 'stream-a', sequence: i }));
    }

    const allEvents = reader.queryEvents('stream-a');
    expect(allEvents).toHaveLength(10);

    for (let i = 0; i < allEvents.length; i++) {
      expect(allEvents[i].sequence).toBe(i + 1);
    }
  });

  /**
   * Each reader queries before and after the second write, never during it.
   * Both readers must see the same events.
   */
  it('SqliteBackend_twoReaders_ConsistentSnapshotsDuringWrite', () => {
    const dbPath = createTempDb();

    const writer = trackBackend(new SqliteBackend(dbPath));
    writer.initialize();

    for (let i = 1; i <= 3; i++) {
      writer.appendEvent('stream-b', makeEvent({ streamId: 'stream-b', sequence: i }));
    }

    const reader1 = trackBackend(new SqliteBackend(dbPath));
    reader1.initialize();

    const reader2 = trackBackend(new SqliteBackend(dbPath));
    reader2.initialize();

    const snapshot1 = reader1.queryEvents('stream-b');
    const snapshot2 = reader2.queryEvents('stream-b');

    expect(snapshot1).toHaveLength(3);
    expect(snapshot2).toHaveLength(3);

    for (let i = 4; i <= 6; i++) {
      writer.appendEvent('stream-b', makeEvent({ streamId: 'stream-b', sequence: i }));
    }

    const afterWrite1 = reader1.queryEvents('stream-b');
    const afterWrite2 = reader2.queryEvents('stream-b');

    expect(afterWrite1).toHaveLength(6);
    expect(afterWrite2).toHaveLength(6);

    expect(afterWrite1.map((e) => e.sequence)).toEqual(afterWrite2.map((e) => e.sequence));
  });
});
