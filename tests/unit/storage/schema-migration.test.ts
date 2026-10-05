import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
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

/** Creates a V1 database: the `events` table has no `payload` column. */
function createV1Database(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

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
 * Inserts a V1 event row, which has no `payload` value, and sets the
 * `sequences` row of the stream.
 */
function insertV1Event(
  db: Database,
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

  db.prepare(
    'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
  ).run(streamId, sequence);
}

/**
 * `initialize()` runs `migrateSchema()`, so a test migrates its database when
 * it initializes the backend. `createV5Database` builds an `events` table
 * without the three correlation columns and stamps versions 2 to 5. Then only
 * the V5 to V6 step runs on the next open.
 */
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
      }
    }
    backends.length = 0;

    if (tempDir) {
      rmrf(tempDir);
    }
  });

  it('migrateSchema_V1Database_AddsPayloadColumn', () => {
    const dbPath = createTempDb();

    const rawDb = createV1Database(dbPath);

    const columnsBefore = rawDb
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    const hasPayloadBefore = columnsBefore.some((col) => col.name === 'payload');
    expect(hasPayloadBefore).toBe(false);

    rawDb.close();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;
    const columnsAfter = db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    const hasPayloadAfter = columnsAfter.some((col) => col.name === 'payload');
    expect(hasPayloadAfter).toBe(true);
  });

  /**
   * The migration leaves `payload` NULL on a V1 row, so `rowToEvent` builds the
   * event from the columns.
   */
  it('migrateSchema_V1Events_QueryableViaRowToEventFallback', () => {
    const dbPath = createTempDb();

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

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const events = backend.queryEvents('stream-1');
    expect(events).toHaveLength(2);

    expect(events[0].streamId).toBe('stream-1');
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('workflow.started');
    expect(events[0].timestamp).toBe('2024-01-01T00:00:00.000Z');
    expect(events[0].data).toEqual({
      featureId: 'my-feature',
      workflowType: 'feature',
    });

    expect(events[1].streamId).toBe('stream-1');
    expect(events[1].sequence).toBe(2);
    expect(events[1].type).toBe('task.assigned');
    expect(events[1].data).toEqual({
      taskId: 'task-1',
      title: 'Implement feature',
    });
  });

  /**
   * `rowToEvent` builds the V1 event from the columns. It parses the V2 event
   * from `payload`, which keeps every field.
   */
  it('migrateSchema_V1AndV2EventsCoexist_BothQueryCorrectly', () => {
    const dbPath = createTempDb();

    const rawDb = createV1Database(dbPath);
    insertV1Event(rawDb, 'stream-mixed', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      featureId: 'mixed-feature',
      workflowType: 'feature',
    });
    rawDb.close();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

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

    const events = backend.queryEvents('stream-mixed');
    expect(events).toHaveLength(2);

    expect(events[0].streamId).toBe('stream-mixed');
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('workflow.started');
    expect(events[0].data).toEqual({
      featureId: 'mixed-feature',
      workflowType: 'feature',
    });

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

    const rawDb = createV1Database(dbPath);
    insertV1Event(rawDb, 'stream-idem', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      featureId: 'idem-feature',
    });
    rawDb.close();

    const backend1 = trackBackend(new SqliteBackend(dbPath));
    backend1.initialize();

    backend1.appendEvent(
      'stream-idem',
      makeEvent({ streamId: 'stream-idem', sequence: 2, type: 'task.assigned' }),
    );

    backend1.close();

    const backend2 = trackBackend(new SqliteBackend(dbPath));
    expect(() => backend2.initialize()).not.toThrow();

    const events = backend2.queryEvents('stream-idem');
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);

    const db = (backend2 as unknown as { db: Database }).db;
    const columns = db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    const payloadColumns = columns.filter((col) => col.name === 'payload');
    expect(payloadColumns).toHaveLength(1);
  });

  /**
   * `createV1Database` stamps no version. The assertion covers only version 3,
   * which the V2 to V3 step stamps.
   */
  it('migrateSchema_TracksSchemaVersion_InSchemaVersionTable', () => {
    const dbPath = createTempDb();

    const rawDb = createV1Database(dbPath);
    rawDb.close();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;
    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(3);
  });

  it('Migration_AddsProjectionSnapshotsTable_OnFreshDb', () => {
    const dbPath = createTempDb();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;

    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_snapshots'",
      )
      .get() as { name: string } | undefined;
    expect(tableRow).toBeDefined();
    expect(tableRow?.name).toBe('projection_snapshots');

    const columns = db
      .prepare('PRAGMA table_info(projection_snapshots)')
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = new Map(columns.map((c) => [c.name, c]));

    const expectedColumns: Array<{ name: string; type: string; notnull: number }> = [
      { name: 'stream_id', type: 'TEXT', notnull: 1 },
      { name: 'projection_id', type: 'TEXT', notnull: 1 },
      { name: 'projection_version', type: 'TEXT', notnull: 1 },
      { name: 'sequence', type: 'INTEGER', notnull: 1 },
      { name: 'payload', type: 'TEXT', notnull: 1 },
      { name: 'created_at', type: 'TEXT', notnull: 1 },
    ];

    for (const expected of expectedColumns) {
      const col = byName.get(expected.name);
      expect(col, `missing column ${expected.name}`).toBeDefined();
      expect(col!.type.toUpperCase()).toBe(expected.type);
      expect(col!.notnull).toBe(expected.notnull);
    }

    const pkColumns = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkColumns).toEqual([
      'stream_id',
      'projection_id',
      'projection_version',
      'sequence',
    ]);

    const indexRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projection_snapshots_latest'",
      )
      .get() as { name: string } | undefined;
    expect(indexRow).toBeDefined();
    expect(indexRow?.name).toBe('idx_projection_snapshots_latest');
  });

  function createV5Database(dbPath: string): Database {
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        streamId  TEXT NOT NULL,
        sequence  INTEGER NOT NULL,
        type      TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data      TEXT,
        payload   TEXT,
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
        streamId      TEXT NOT NULL,
        viewName      TEXT NOT NULL,
        state         TEXT NOT NULL,
        highWaterMark INTEGER NOT NULL,
        savedAt       TEXT NOT NULL,
        PRIMARY KEY (streamId, viewName)
      );

      CREATE TABLE IF NOT EXISTS sequences (
        streamId TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version   INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_snapshots (
        stream_id          TEXT NOT NULL,
        projection_id      TEXT NOT NULL,
        projection_version TEXT NOT NULL,
        sequence           INTEGER NOT NULL,
        payload            TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        PRIMARY KEY (stream_id, projection_id, projection_version, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_projection_snapshots_latest
        ON projection_snapshots(stream_id, projection_id, projection_version, sequence DESC);

      CREATE TABLE IF NOT EXISTS streams (
        streamId      TEXT PRIMARY KEY,
        workflow_type TEXT NOT NULL DEFAULT '__legacy',
        status        TEXT,
        createdAt     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_streams_workflow_type
        ON streams(workflow_type);
      CREATE INDEX IF NOT EXISTS idx_streams_workflow_type_status
        ON streams(workflow_type, status);

      CREATE TABLE IF NOT EXISTS idempotency_claims (
        streamId       TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL,
        eventIds       TEXT NOT NULL,
        sequences      TEXT NOT NULL,
        timestamps     TEXT NOT NULL,
        events_json    TEXT NOT NULL,
        claimedAt      TEXT NOT NULL,
        PRIMARY KEY (streamId, idempotencyKey)
      );
    `);

    const stamp = db.prepare(
      'INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)',
    );
    const now = '2024-01-01T00:00:00.000Z';
    for (const v of [2, 3, 4, 5]) {
      stamp.run(v, now);
    }

    return db;
  }

  function insertV5Event(
    db: Database,
    streamId: string,
    sequence: number,
    type: string,
    timestamp: string,
    payload: Record<string, unknown>,
  ): void {
    const data = payload.data ? JSON.stringify(payload.data) : null;
    db.prepare(
      'INSERT INTO events (streamId, sequence, type, timestamp, data, payload) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(streamId, sequence, type, timestamp, data, JSON.stringify(payload));
    db.prepare(
      'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
    ).run(streamId, sequence);
  }

  it('MigrateV5ToV6_LegacyV5Db_AddsCorrelationColumnsAndStampsLedger', () => {
    const dbPath = createTempDb();

    const rawDb = createV5Database(dbPath);
    insertV5Event(rawDb, 'stream-legacy', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      streamId: 'stream-legacy',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2024-01-01T00:00:00.000Z',
      schemaVersion: '1.0',
      data: { featureId: 'legacy-feature', workflowType: 'feature' },
    });
    insertV5Event(rawDb, 'stream-legacy', 2, 'task.assigned', '2024-01-01T00:01:00.000Z', {
      streamId: 'stream-legacy',
      sequence: 2,
      type: 'task.assigned',
      timestamp: '2024-01-01T00:01:00.000Z',
      schemaVersion: '1.0',
      data: { taskId: 'task-1', title: 'Legacy task' },
    });

    const v5Cols = rawDb
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    expect(v5Cols.some((c) => c.name === 'correlation_id')).toBe(false);

    rawDb.close();

    const backend = trackBackend(new SqliteBackend(dbPath));
    expect(() => backend.initialize()).not.toThrow();

    const db = (backend as unknown as { db: Database }).db;

    const columnsAfter = db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(columnsAfter.map((c) => [c.name, c]));
    for (const col of ['operation_id', 'correlation_id', 'causation_id']) {
      const info = byName.get(col);
      expect(info, `missing column ${col}`).toBeDefined();
      expect(info!.type.toUpperCase()).toBe('TEXT');
      expect(info!.notnull).toBe(0);
    }

    const versions = (
      db
        .prepare('SELECT version FROM schema_version ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toContain(6);

    const events = db
      .prepare('SELECT streamId, sequence, type FROM events WHERE streamId = ? ORDER BY sequence')
      .all('stream-legacy') as Array<{ streamId: string; sequence: number; type: string }>;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sequence: 1, type: 'workflow.started' });
    expect(events[1]).toMatchObject({ sequence: 2, type: 'task.assigned' });
  });

  /**
   * A new database has no ledger row, so the V5 to V6 step runs. The step finds
   * no row to backfill, so it must write no progress event to `__migration__`.
   */
  it('MigrateV5ToV6_FreshDbWithNoPriorEvents_NoOpsCleanly', () => {
    const dbPath = createTempDb();

    const backend = trackBackend(new SqliteBackend(dbPath));
    expect(() => backend.initialize()).not.toThrow();

    const db = (backend as unknown as { db: Database }).db;

    const versions = (
      db
        .prepare('SELECT version FROM schema_version ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toContain(6);

    const eventCount = (
      db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    ).n;
    expect(eventCount).toBe(0);

    const migrationRowCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE streamId = '__migration__'")
        .get() as { n: number }
    ).n;
    expect(migrationRowCount).toBe(0);
  });

  /**
   * One payload holds `operationId`, `correlationId` and `causationId` at the
   * top level, and one holds none of them. The backfill copies the three values
   * to the columns of the first row and leaves the second row NULL.
   */
  it('MigrateV5ToV6_LegacyV5DbWithPayloadEvents_BackfillsCorrelationColumns', () => {
    const dbPath = createTempDb();

    const rawDb = createV5Database(dbPath);

    insertV5Event(rawDb, 'stream-tagged', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      streamId: 'stream-tagged',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2024-01-01T00:00:00.000Z',
      schemaVersion: '1.0',
      operationId: 'op-A',
      correlationId: 'corr-A',
      causationId: 'cause-A',
      data: { featureId: 'tagged-feature' },
    });

    insertV5Event(rawDb, 'stream-untagged', 1, 'workflow.started', '2024-01-01T00:00:00.000Z', {
      streamId: 'stream-untagged',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2024-01-01T00:00:00.000Z',
      schemaVersion: '1.0',
      data: { featureId: 'untagged-feature' },
    });

    rawDb.close();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;

    const rowCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE streamId IN ('stream-tagged', 'stream-untagged')",
        )
        .get() as { n: number }
    ).n;
    expect(rowCount).toBe(2);

    const taggedRow = db
      .prepare(
        'SELECT operation_id, correlation_id, causation_id FROM events WHERE streamId = ? AND sequence = ?',
      )
      .get('stream-tagged', 1) as {
      operation_id: string | null;
      correlation_id: string | null;
      causation_id: string | null;
    };
    expect(taggedRow.operation_id).toBe('op-A');
    expect(taggedRow.correlation_id).toBe('corr-A');
    expect(taggedRow.causation_id).toBe('cause-A');

    const untaggedRow = db
      .prepare(
        'SELECT operation_id, correlation_id, causation_id FROM events WHERE streamId = ? AND sequence = ?',
      )
      .get('stream-untagged', 1) as {
      operation_id: string | null;
      correlation_id: string | null;
      causation_id: string | null;
    };
    expect(untaggedRow.operation_id).toBeNull();
    expect(untaggedRow.correlation_id).toBeNull();
    expect(untaggedRow.causation_id).toBeNull();
  });

  /**
   * 2,500 rows make three chunks at the chunk size of 1,000. Each chunk writes
   * one progress event to `__migration__`, and the test accepts three or more.
   */
  it('MigrateV5ToV6_LargeDb_ChunksBackfillAndEmitsProgressEvents', () => {
    const dbPath = createTempDb();

    const rawDb = createV5Database(dbPath);

    const TOTAL_EVENTS = 2500;
    const STREAMS = ['stream-A', 'stream-B', 'stream-C'];

    const seqByStream = new Map<string, number>(STREAMS.map((s) => [s, 0]));
    for (let i = 0; i < TOTAL_EVENTS; i++) {
      const streamId = STREAMS[i % STREAMS.length];
      const seq = (seqByStream.get(streamId) ?? 0) + 1;
      seqByStream.set(streamId, seq);
      insertV5Event(rawDb, streamId, seq, 'task.assigned', '2024-01-01T00:00:00.000Z', {
        streamId,
        sequence: seq,
        type: 'task.assigned',
        timestamp: '2024-01-01T00:00:00.000Z',
        schemaVersion: '1.0',
        operationId: `op-${i}`,
        correlationId: `corr-${i}`,
        causationId: `cause-${i}`,
        data: { i },
      });
    }
    rawDb.close();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;

    const stillNullCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM events
            WHERE streamId IN ('stream-A', 'stream-B', 'stream-C')
              AND correlation_id IS NULL`,
        )
        .get() as { n: number }
    ).n;
    expect(stillNullCount).toBe(0);

    const sample = db
      .prepare(
        'SELECT operation_id, correlation_id, causation_id FROM events WHERE streamId = ? AND sequence = ?',
      )
      .get('stream-A', 1) as {
      operation_id: string;
      correlation_id: string;
      causation_id: string;
    };
    expect(sample.operation_id).toBe('op-0');
    expect(sample.correlation_id).toBe('corr-0');
    expect(sample.causation_id).toBe('cause-0');

    const progressRows = db
      .prepare(
        `SELECT payload FROM events
          WHERE streamId = '__migration__'
            AND type = 'migration.correlation_backfill_progress'
          ORDER BY sequence`,
      )
      .all() as Array<{ payload: string }>;
    expect(progressRows.length).toBeGreaterThanOrEqual(3);

    for (const { payload } of progressRows) {
      const parsed = JSON.parse(payload) as {
        data?: { rowsBackfilled?: unknown; totalRowsRemaining?: unknown };
      };
      expect(typeof parsed.data?.rowsBackfilled).toBe('number');
      expect(typeof parsed.data?.totalRowsRemaining).toBe('number');
    }
  });

  /** Each correlation column is TEXT and accepts NULL (`notnull` is 0). */
  it('SqliteBackend_FreshDb_SchemaV6_HasCorrelationColumnsAndIndexes', () => {
    const dbPath = createTempDb();

    const backend = trackBackend(new SqliteBackend(dbPath));
    backend.initialize();

    const db = (backend as unknown as { db: Database }).db;

    const columns = db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(columns.map((c) => [c.name, c]));

    for (const col of ['operation_id', 'correlation_id', 'causation_id']) {
      const info = byName.get(col);
      expect(info, `missing column ${col}`).toBeDefined();
      expect(info!.type.toUpperCase()).toBe('TEXT');
      expect(info!.notnull).toBe(0);
    }

    const corrIdx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_correlation'",
      )
      .get() as { name: string } | undefined;
    expect(corrIdx?.name).toBe('idx_events_correlation');

    const causationIdx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_causation'",
      )
      .get() as { name: string } | undefined;
    expect(causationIdx?.name).toBe('idx_events_causation');

    const operationIdx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_operation'",
      )
      .get() as { name: string } | undefined;
    expect(operationIdx?.name).toBe('idx_events_operation');

    const versionRows = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC')
      .all() as Array<{ version: number }>;
    expect(versionRows.length).toBeGreaterThanOrEqual(1);
    expect(versionRows[0].version).toBe(6);
  });

  /**
   * The seed is a V1 schema plus the `payload` column and a ledger row for
   * version 2. After the second open, the ledger versions and the `appliedAt`
   * of version 3 are the same as after the first open.
   */
  it('SchemaMigration_V2ToV3_AppliesIdempotently', () => {
    const dbPath = createTempDb();

    const rawDb = createV1Database(dbPath);
    rawDb.exec('ALTER TABLE events ADD COLUMN payload TEXT');
    rawDb
      .prepare('INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)')
      .run(2, '2024-01-01T00:00:00.000Z');

    const seededRows = rawDb
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>;
    expect(seededRows).toEqual([{ version: 2 }]);

    rawDb.close();

    const backend1 = trackBackend(new SqliteBackend(dbPath));
    backend1.initialize();

    const db1 = (backend1 as unknown as { db: Database }).db;
    const rowsAfterFirst = db1
      .prepare('SELECT version, appliedAt FROM schema_version ORDER BY version')
      .all() as Array<{ version: number; appliedAt: string }>;
    const versionsAfterFirst = rowsAfterFirst.map((r) => r.version);
    expect(versionsAfterFirst).toContain(3);

    const v3Row = rowsAfterFirst.find((r) => r.version === 3);
    expect(v3Row).toBeDefined();
    const firstV3AppliedAt = v3Row!.appliedAt;

    backend1.close();

    const backend2 = trackBackend(new SqliteBackend(dbPath));
    expect(() => backend2.initialize()).not.toThrow();

    const db2 = (backend2 as unknown as { db: Database }).db;
    const rowsAfterSecond = db2
      .prepare('SELECT version, appliedAt FROM schema_version ORDER BY version')
      .all() as Array<{ version: number; appliedAt: string }>;

    expect(rowsAfterSecond.map((r) => r.version)).toEqual(
      rowsAfterFirst.map((r) => r.version),
    );

    const v3RowAfterSecond = rowsAfterSecond.find((r) => r.version === 3);
    expect(v3RowAfterSecond?.appliedAt).toBe(firstV3AppliedAt);
  });
});
