import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { SqliteBackend } from '../sqlite-backend.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── WAL Concurrency Tests ──────────────────────────────────────────────────

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
    // Close all backends before removing temp directory
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
    }
  });

  it('SqliteBackend_fileBased_UsesWALJournalMode', () => {
    const dbPath = createTempDb();
    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    // Access the internal db to check journal_mode pragma
    const db = (backend as unknown as { db: { pragma: (sql: string) => Array<{ journal_mode: string }> } }).db;
    const result = db.pragma('journal_mode');

    expect(result[0].journal_mode).toBe('wal');
  });

  it('SqliteBackend_twoInstances_ConcurrentReadWriteNoBlocking', () => {
    const dbPath = createTempDb();

    // Open two separate SqliteBackend instances on the same file
    const writer = trackBackend(new SqliteBackend(dbPath));
    writer.initialize();

    const reader = trackBackend(new SqliteBackend(dbPath));
    reader.initialize();

    // Writer appends events
    for (let i = 1; i <= 5; i++) {
      writer.appendEvent('stream-a', makeEvent({ streamId: 'stream-a', sequence: i }));
    }

    // Reader queries concurrently — should not throw SQLITE_BUSY
    const events = reader.queryEvents('stream-a');
    expect(events).toHaveLength(5);

    // Writer appends more while reader is active
    for (let i = 6; i <= 10; i++) {
      writer.appendEvent('stream-a', makeEvent({ streamId: 'stream-a', sequence: i }));
    }

    // Reader should see the new events
    const allEvents = reader.queryEvents('stream-a');
    expect(allEvents).toHaveLength(10);

    // Verify ordering is correct
    for (let i = 0; i < allEvents.length; i++) {
      expect(allEvents[i].sequence).toBe(i + 1);
    }
  });

  it('SqliteBackend_twoReaders_ConsistentSnapshotsDuringWrite', () => {
    const dbPath = createTempDb();

    // Writer seeds initial data
    const writer = trackBackend(new SqliteBackend(dbPath));
    writer.initialize();

    for (let i = 1; i <= 3; i++) {
      writer.appendEvent('stream-b', makeEvent({ streamId: 'stream-b', sequence: i }));
    }

    // Open two readers
    const reader1 = trackBackend(new SqliteBackend(dbPath));
    reader1.initialize();

    const reader2 = trackBackend(new SqliteBackend(dbPath));
    reader2.initialize();

    // Both readers should see the same initial state
    const snapshot1 = reader1.queryEvents('stream-b');
    const snapshot2 = reader2.queryEvents('stream-b');

    expect(snapshot1).toHaveLength(3);
    expect(snapshot2).toHaveLength(3);

    // Writer adds more events
    for (let i = 4; i <= 6; i++) {
      writer.appendEvent('stream-b', makeEvent({ streamId: 'stream-b', sequence: i }));
    }

    // After the write commits, both readers should see 6 events
    const afterWrite1 = reader1.queryEvents('stream-b');
    const afterWrite2 = reader2.queryEvents('stream-b');

    expect(afterWrite1).toHaveLength(6);
    expect(afterWrite2).toHaveLength(6);

    // Both readers see the same data
    expect(afterWrite1.map((e) => e.sequence)).toEqual(afterWrite2.map((e) => e.sequence));
  });
});
