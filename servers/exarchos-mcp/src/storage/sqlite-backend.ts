import Database from 'better-sqlite3';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type { StorageBackend, EventSender, ViewCacheEntry, DrainResult } from './backend.js';
import { VersionConflictError } from './memory-backend.js';

// ─── Schema DDL ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
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
`;

// ─── Prepared Statements ────────────────────────────────────────────────────

interface Statements {
  insertEvent: Database.Statement;
  upsertSequence: Database.Statement;
  selectSequence: Database.Statement;
  selectEvents: Database.Statement;
  getState: Database.Statement;
  upsertState: Database.Statement;
  selectAllStates: Database.Statement;
  getStateVersion: Database.Statement;
  insertOutbox: Database.Statement;
  selectPendingOutbox: Database.Statement;
  updateOutboxConfirmed: Database.Statement;
  updateOutboxFailed: Database.Statement;
  updateOutboxDeadLetter: Database.Statement;
  getViewCache: Database.Statement;
  upsertViewCache: Database.Statement;
  insertSchemaVersion: Database.Statement;
}

// ─── SqliteBackend ──────────────────────────────────────────────────────────

const MAX_OUTBOX_RETRIES = 5;

/**
 * SQLite-backed implementation of StorageBackend.
 * Uses better-sqlite3 for synchronous, high-performance operations.
 * Supports WAL mode for concurrent read/write access.
 */
export class SqliteBackend implements StorageBackend {
  private db!: Database.Database;
  private stmts!: Statements;
  private outboxIdCounter = 0;

  constructor(private readonly dbPath: string) {}

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  initialize(): void {
    this.db = new Database(this.dbPath);

    // Enable WAL mode and set synchronous to NORMAL for performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Enable memory-mapped I/O (256 MB) for read-heavy workloads
    this.db.pragma('mmap_size = 268435456');

    // Execute schema DDL
    this.db.exec(SCHEMA_DDL);

    // Track schema version
    const existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(SCHEMA_VERSION) as { version: number } | undefined;

    if (!existing) {
      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
        .run(SCHEMA_VERSION, new Date().toISOString());
    }

    // Initialize prepared statements
    this.stmts = this.prepareStatements();
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }

  private prepareStatements(): Statements {
    return {
      insertEvent: this.db.prepare(
        'INSERT INTO events (streamId, sequence, type, timestamp, data) VALUES (?, ?, ?, ?, ?)',
      ),
      upsertSequence: this.db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
      ),
      selectSequence: this.db.prepare(
        'SELECT sequence FROM sequences WHERE streamId = ?',
      ),
      selectEvents: this.db.prepare(
        'SELECT streamId, sequence, type, timestamp, data FROM events WHERE streamId = ? ORDER BY sequence',
      ),
      getState: this.db.prepare(
        'SELECT state, version FROM workflow_state WHERE featureId = ?',
      ),
      upsertState: this.db.prepare(
        `INSERT INTO workflow_state (featureId, state, version, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(featureId) DO UPDATE SET state = excluded.state, version = excluded.version, updatedAt = excluded.updatedAt`,
      ),
      selectAllStates: this.db.prepare(
        'SELECT featureId, state FROM workflow_state',
      ),
      getStateVersion: this.db.prepare(
        'SELECT version FROM workflow_state WHERE featureId = ?',
      ),
      insertOutbox: this.db.prepare(
        'INSERT INTO outbox (id, streamId, event, status, attempts, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      selectPendingOutbox: this.db.prepare(
        'SELECT id, streamId, event, attempts FROM outbox WHERE streamId = ? AND status = ? ORDER BY createdAt',
      ),
      updateOutboxConfirmed: this.db.prepare(
        'UPDATE outbox SET status = ?, lastAttemptAt = ? WHERE id = ?',
      ),
      updateOutboxFailed: this.db.prepare(
        'UPDATE outbox SET status = ?, attempts = ?, lastAttemptAt = ?, nextRetryAt = ?, error = ? WHERE id = ?',
      ),
      updateOutboxDeadLetter: this.db.prepare(
        'UPDATE outbox SET status = ?, lastAttemptAt = ?, error = ? WHERE id = ?',
      ),
      getViewCache: this.db.prepare(
        'SELECT state, highWaterMark FROM view_cache WHERE streamId = ? AND viewName = ?',
      ),
      upsertViewCache: this.db.prepare(
        `INSERT INTO view_cache (streamId, viewName, state, highWaterMark, savedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(streamId, viewName) DO UPDATE SET state = excluded.state, highWaterMark = excluded.highWaterMark, savedAt = excluded.savedAt`,
      ),
      insertSchemaVersion: this.db.prepare(
        'INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)',
      ),
    };
  }

  // ─── Event Operations ───────────────────────────────────────────────────

  appendEvent(streamId: string, event: WorkflowEvent): void {
    const data = event.data ? JSON.stringify(event.data) : null;

    const insertFn = this.db.transaction(() => {
      this.stmts.insertEvent.run(
        streamId,
        event.sequence,
        event.type,
        event.timestamp,
        data,
      );
      this.stmts.upsertSequence.run(streamId, event.sequence);
    });

    insertFn();
  }

  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[] {
    // Build dynamic query based on filters
    const conditions: string[] = ['streamId = ?'];
    const params: unknown[] = [streamId];

    if (filters?.sinceSequence !== undefined) {
      conditions.push('sequence > ?');
      params.push(filters.sinceSequence);
    }

    if (filters?.type) {
      conditions.push('type = ?');
      params.push(filters.type);
    }

    if (filters?.since) {
      conditions.push('timestamp >= ?');
      params.push(filters.since);
    }

    if (filters?.until) {
      conditions.push('timestamp <= ?');
      params.push(filters.until);
    }

    let sql = `SELECT streamId, sequence, type, timestamp, data FROM events WHERE ${conditions.join(' AND ')} ORDER BY sequence`;

    if (filters?.limit !== undefined && filters?.offset !== undefined) {
      sql += ` LIMIT ? OFFSET ?`;
      params.push(filters.limit, filters.offset);
    } else if (filters?.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(filters.limit);
    } else if (filters?.offset !== undefined) {
      sql += ` LIMIT -1 OFFSET ?`;
      params.push(filters.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      streamId: string;
      sequence: number;
      type: string;
      timestamp: string;
      data: string | null;
    }>;

    return rows.map((row) => this.rowToEvent(row));
  }

  getSequence(streamId: string): number {
    const row = this.stmts.selectSequence.get(streamId) as { sequence: number } | undefined;
    return row ? row.sequence : 0;
  }

  listStreams(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT streamId FROM sequences ORDER BY streamId')
      .all() as Array<{ streamId: string }>;
    return rows.map((row) => row.streamId);
  }

  // ─── State Operations ───────────────────────────────────────────────────

  getState(featureId: string): WorkflowState | null {
    const row = this.stmts.getState.get(featureId) as { state: string; version: number } | undefined;
    if (!row) return null;
    return JSON.parse(row.state) as WorkflowState;
  }

  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void {
    const setFn = this.db.transaction(() => {
      const existing = this.stmts.getStateVersion.get(featureId) as { version: number } | undefined;
      const currentVersion = existing ? existing.version : 0;

      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new VersionConflictError(featureId, expectedVersion, currentVersion);
      }

      const newVersion = currentVersion + 1;
      this.stmts.upsertState.run(
        featureId,
        JSON.stringify(state),
        newVersion,
        new Date().toISOString(),
      );
    });

    setFn();
  }

  listStates(): Array<{ featureId: string; state: WorkflowState }> {
    const rows = this.stmts.selectAllStates.all() as Array<{ featureId: string; state: string }>;
    return rows.map((row) => ({
      featureId: row.featureId,
      state: JSON.parse(row.state) as WorkflowState,
    }));
  }

  // ─── Outbox Operations ──────────────────────────────────────────────────

  addOutboxEntry(streamId: string, event: WorkflowEvent): string {
    this.outboxIdCounter++;
    const id = `outbox-${this.outboxIdCounter}-${Date.now()}`;
    this.stmts.insertOutbox.run(
      id,
      streamId,
      JSON.stringify(event),
      'pending',
      0,
      new Date().toISOString(),
    );
    return id;
  }

  drainOutbox(streamId: string, sender: EventSender, batchSize?: number): DrainResult {
    const rows = this.stmts.selectPendingOutbox.all(streamId, 'pending') as Array<{
      id: string;
      streamId: string;
      event: string;
      attempts: number;
    }>;

    if (rows.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const batch = batchSize !== undefined ? rows.slice(0, batchSize) : rows;
    let sent = 0;
    let failed = 0;
    const now = new Date().toISOString();

    for (const row of batch) {
      const event = JSON.parse(row.event) as WorkflowEvent;
      try {
        // Synchronous call — better-sqlite3 is synchronous, sender is async but invoked fire-and-forget
        sender.appendEvents(streamId, [
          {
            streamId: event.streamId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            type: event.type,
            correlationId: event.correlationId,
            causationId: event.causationId,
            agentId: event.agentId,
            agentRole: event.agentRole,
            source: event.source,
            schemaVersion: event.schemaVersion,
            data: event.data,
            ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
          },
        ]);

        this.stmts.updateOutboxConfirmed.run('confirmed', now, row.id);
        sent++;
      } catch {
        const newAttempts = row.attempts + 1;

        if (newAttempts >= MAX_OUTBOX_RETRIES) {
          // Dead-letter after max retries
          this.stmts.updateOutboxDeadLetter.run('dead-letter', now, 'Max retries exceeded', row.id);
        } else {
          // Schedule retry with exponential backoff
          const retryDelayMs = Math.pow(2, newAttempts) * 1000;
          const nextRetry = new Date(Date.now() + retryDelayMs).toISOString();
          this.stmts.updateOutboxFailed.run(
            'pending',
            newAttempts,
            now,
            nextRetry,
            'Send failed',
            row.id,
          );
        }
        failed++;
      }
    }

    return { sent, failed };
  }

  // ─── View Cache Operations ──────────────────────────────────────────────

  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null {
    const row = this.stmts.getViewCache.get(streamId, viewName) as {
      state: string;
      highWaterMark: number;
    } | undefined;

    if (!row) return null;

    return {
      state: JSON.parse(row.state),
      highWaterMark: row.highWaterMark,
    };
  }

  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void {
    this.stmts.upsertViewCache.run(
      streamId,
      viewName,
      JSON.stringify(state),
      hwm,
      new Date().toISOString(),
    );
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private rowToEvent(row: {
    streamId: string;
    sequence: number;
    type: string;
    timestamp: string;
    data: string | null;
  }): WorkflowEvent {
    return {
      streamId: row.streamId,
      sequence: row.sequence,
      type: row.type,
      timestamp: row.timestamp,
      ...(row.data ? { data: JSON.parse(row.data) } : {}),
    } as WorkflowEvent;
  }
}
