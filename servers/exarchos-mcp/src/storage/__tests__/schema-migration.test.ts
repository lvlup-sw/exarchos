import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
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

/**
 * Creates a V1 database schema (without the `payload` column on events).
 * This simulates a database created before the V1->V2 migration was introduced.
 */
function createV1Database(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      streamId  TEXT NOT NULL,
      sequence  INTEGER NOT NULL,
      type      TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data      TEXT,
      PRIMARY KEY (streamId, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(streamId, type);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(streamId, timestamp);

    CREATE TABLE IF NOT EXISTS workflow_state (
      featureId TEXT PRIMARY KEY,
      state     TEXT NOT NULL,
      version   INTEGER NOT NULL DEFAULT 1,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id          TEXT PRIMARY KEY,
      streamId    TEXT NOT NULL,
      event       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      createdAt   TEXT NOT NULL,
      lastAttemptAt TEXT,
      nextRetryAt   TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(streamId, status);

    CREATE TABLE IF NOT EXISTS view_cache (
      streamId    TEXT NOT NULL,
      viewName    TEXT NOT NULL,
      state       TEXT NOT NULL,
      highWaterMark INTEGER NOT NULL,
      savedAt     TEXT NOT NULL,
      PRIMARY KEY (streamId, viewName)
    );

    CREATE TABLE IF NOT EXISTS sequences (
      streamId TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );
  `);

  return db;
}

/**
 * Inserts a V1-style event (no payload column) directly into the events table.
 */
function insertV1Event(
  db: Database.Database,
  streamId: string,
  sequence: number,
  type: string,
  timestamp: string,
  data?: Record<string, unknown>,
): void {
  const dataJson = data ? JSON.stringify(data) : null;
  db.prepare(
    'INSERT INTO events (streamId, sequence, type, timestamp, data) VALUES (?, ?, ?, ?, ?)',
  ).run(streamId, sequence, type, timestamp, dataJson);

  // Also update the sequences table like SqliteBackend does
  db.prepare(
    'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
  ).run(streamId, sequence);
}

// ─── Schema Migration Tests ─────────────────────────────────────────────────

describe('SqliteBackend Schema Migration V1->V2', () => {
  let tempDir: string;
  const backends: SqliteBackend[] = [];

  function createTempDb(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'exarchos-migration-'));
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
        // already closed
      }
    }
    backends.length = 0;

    if (tempDir) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it('migrateSchema_V1Database_AddsPayloadColumn', () => {
    const dbPath = createTempDb();

    // Create a V1 database (no payload column)
    const rawDb = createV1Database(dbPath);

    // Verify no payload column exists yet
    const columnsBefore = rawDb
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    const hasPayloadBefore = columnsBefore.some((col) => col.name === 'payload');
    expect(hasPayloadBefore).toBe(false);

    rawDb.close();

    // Open with SqliteBackend which triggers migrateSchema()
    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    // Verify the payload column now exists
    const db = (backend as unknown as { db: Database.Database }).db;
    const columnsAfter = db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    const hasPayloadAfter = columnsAfter.some((col) => col.name === 'payload');
    expect(hasPayloadAfter).toBe(true);
  });

  it('migrateSchema_V1Events_QueryableViaRowToEventFallback', () => {
    const dbPath = createTempDb();

    // Create V1 database with events (no payload column)
    const rawDb = createV1Database(dbPath);
    insertV1Event(rawDb, 'stream-1', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      featureId: 'my-feature',
      workflowType: 'feature',
    });
    insertV1Event(rawDb, 'stream-1', 2, 'task.assigned', '2024-01-01T00:01:00.000Z', {
      taskId: 'task-1',
      title: 'Implement feature',
    });
    rawDb.close();

    // Open with SqliteBackend — migration adds payload column but existing rows have NULL payload
    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    // Query events — rowToEvent should fall back to field-by-field reconstruction
    const events = backend.queryEvents('stream-1');
    expect(events).toHaveLength(2);

    // Verify first event fields are reconstructed correctly
    expect(events[0].streamId).toBe('stream-1');
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('workflow.started');
    expect(events[0].timestamp).toBe('2024-01-01T00:00:00.000Z');
    expect(events[0].data).toEqual({
      featureId: 'my-feature',
      workflowType: 'feature',
    });

    // Verify second event
    expect(events[1].streamId).toBe('stream-1');
    expect(events[1].sequence).toBe(2);
    expect(events[1].type).toBe('task.assigned');
    expect(events[1].data).toEqual({
      taskId: 'task-1',
      title: 'Implement feature',
    });
  });

  it('migrateSchema_V1AndV2EventsCoexist_BothQueryCorrectly', () => {
    const dbPath = createTempDb();

    // Create V1 database with a V1 event
    const rawDb = createV1Database(dbPath);
    insertV1Event(rawDb, 'stream-mixed', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      featureId: 'mixed-feature',
      workflowType: 'feature',
    });
    rawDb.close();

    // Open with SqliteBackend — migrates and allows new V2 events
    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    // Append a V2 event (with full payload JSON)
    const v2Event = makeEvent({
      streamId: 'stream-mixed',
      sequence: 2,
      type: 'task.assigned',
      timestamp: '2024-01-02T00:00:00.000Z',
      correlationId: 'corr-v2',
      agentId: 'agent-v2',
      source: 'mcp-tool',
      data: { taskId: 'task-2', title: 'V2 task' },
    });
    backend.appendEvent('stream-mixed', v2Event);

    // Query all events — both V1 (fallback) and V2 (payload) should work
    const events = backend.queryEvents('stream-mixed');
    expect(events).toHaveLength(2);

    // V1 event (reconstructed from fields)
    expect(events[0].streamId).toBe('stream-mixed');
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('workflow.started');
    expect(events[0].data).toEqual({
      featureId: 'mixed-feature',
      workflowType: 'feature',
    });

    // V2 event (deserialized from payload — preserves all fields)
    expect(events[1].streamId).toBe('stream-mixed');
    expect(events[1].sequence).toBe(2);
    expect(events[1].type).toBe('task.assigned');
    expect(events[1].correlationId).toBe('corr-v2');
    expect(events[1].agentId).toBe('agent-v2');
    expect(events[1].source).toBe('mcp-tool');
    expect(events[1].data).toEqual({ taskId: 'task-2', title: 'V2 task' });
  });

  it('migrateSchema_CalledTwice_IsIdempotent', () => {
    const dbPath = createTempDb();

    // Create V1 database with an event
    const rawDb = createV1Database(dbPath);
    insertV1Event(rawDb, 'stream-idem', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      featureId: 'idem-feature',
    });
    rawDb.close();

    // First SqliteBackend opens and migrates
    const backend1 = trackBackend(new SqliteBackend(dbPath));
    backend1.initialize();

    // Append a V2 event through the first backend
    backend1.appendEvent(
      'stream-idem',
      makeEvent({ streamId: 'stream-idem', sequence: 2, type: 'task.assigned' }),
    );

    backend1.close();

    // Second SqliteBackend opens the same DB — migrateSchema runs again (idempotent)
    const backend2 = trackBackend(new SqliteBackend(dbPath));
    expect(() => backend2.initialize()).not.toThrow();

    // All data should still be intact
    const events = backend2.queryEvents('stream-idem');
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);

    // Verify the payload column still exists (only one)
    const db = (backend2 as unknown as { db: Database.Database }).db;
    const columns = db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    const payloadColumns = columns.filter((col) => col.name === 'payload');
    expect(payloadColumns).toHaveLength(1);
  });

  it('migrateSchema_TracksSchemaVersion_InSchemaVersionTable', () => {
    const dbPath = createTempDb();

    // Create V1 database (no schema_version entries)
    const rawDb = createV1Database(dbPath);
    rawDb.close();

    // Open with SqliteBackend — migration + schema version tracking
    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    // Check the schema_version table contains the current SCHEMA_VERSION (2)
    const db = (backend as unknown as { db: Database.Database }).db;
    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The current SCHEMA_VERSION is 2 (from sqlite-backend.ts)
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(2);
  });
});
