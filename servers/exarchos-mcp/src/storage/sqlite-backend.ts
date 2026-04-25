import { Database, type Statement } from 'bun:sqlite';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type { StorageBackend, EventSender, ViewCacheEntry, DrainResult } from './backend.js';
import { VersionConflictError } from './memory-backend.js';

// ─── Schema DDL ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;

const SCHEMA_DDL = `
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
  insertEvent: Statement;
  upsertSequence: Statement;
  selectSequence: Statement;
  selectEvents: Statement;
  getState: Statement;
  upsertState: Statement;
  selectAllStates: Statement;
  getStateVersion: Statement;
  insertOutbox: Statement;
  selectPendingOutbox: Statement;
  updateOutboxConfirmed: Statement;
  updateOutboxFailed: Statement;
  updateOutboxDeadLetter: Statement;
  getViewCache: Statement;
  upsertViewCache: Statement;
  insertSchemaVersion: Statement;
}

// ─── SqliteBackend ──────────────────────────────────────────────────────────

const MAX_OUTBOX_RETRIES = 5;

/**
 * SQLite-backed implementation of StorageBackend.
 * Uses bun:sqlite for synchronous, high-performance operations.
 * Supports WAL mode for concurrent read/write access.
 */
export class SqliteBackend implements StorageBackend {
  private db!: Database;
  private stmts!: Statements;
  private outboxIdCounter = 0;

  /** Cache for dynamically built prepared statements (queryEvents). Key = SQL string. */
  private queryStmtCache: Map<string, Statement> = new Map();

  constructor(private readonly dbPath: string) {}

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  initialize(): void {
    this.db = new Database(this.dbPath);

    // Tune the connection for concurrent read/write (WAL, NORMAL sync) and
    // read-heavy access patterns (256 MB memory-mapped I/O).
    // Note: `bun:sqlite` has no `.pragma()` helper — write-pragmas go through
    // `db.exec()` and read-pragmas through `db.query().all()`.
    this.applyConnectionPragmas();

    // Execute schema DDL
    this.db.exec(SCHEMA_DDL);

    // Run migrations for existing databases
    this.migrateSchema();

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

  /**
   * Apply the fixed set of connection-level pragmas (WAL, synchronous=NORMAL,
   * mmap_size=256MB). Kept in a single helper so the values and order are
   * easy to audit — pragma order matters for some SQLite configurations.
   */
  private applyConnectionPragmas(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA mmap_size = 268435456');
  }

  /**
   * Run incremental schema migrations for existing databases.
   * V1 -> V2: Add payload column to events table for full event preservation.
   */
  private migrateSchema(): void {
    // Check if payload column already exists
    const columns = this.db
      .prepare("PRAGMA table_info(events)")
      .all() as Array<{ name: string }>;

    const hasPayload = columns.some((col) => col.name === 'payload');

    if (!hasPayload) {
      this.db.exec('ALTER TABLE events ADD COLUMN payload TEXT');
    }
  }

  private prepareStatements(): Statements {
    return {
      insertEvent: this.db.prepare(
        'INSERT OR IGNORE INTO events (streamId, sequence, type, timestamp, data, payload) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      upsertSequence: this.db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
      ),
      selectSequence: this.db.prepare(
        'SELECT sequence FROM sequences WHERE streamId = ?',
      ),
      selectEvents: this.db.prepare(
        'SELECT streamId, sequence, type, timestamp, data, payload FROM events WHERE streamId = ? ORDER BY sequence',
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
    const payload = JSON.stringify(event);

    const insertFn = this.db.transaction(() => {
      this.stmts.insertEvent.run(
        streamId,
        event.sequence,
        event.type,
        event.timestamp,
        data,
        payload,
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

    let sql = `SELECT streamId, sequence, type, timestamp, data, payload FROM events WHERE ${conditions.join(' AND ')} ORDER BY sequence`;

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

    // Cache prepared statements by SQL string for repeated query patterns
    let stmt = this.queryStmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.queryStmtCache.set(sql, stmt);
    }

    const rows = stmt.all(...params) as Array<{
      streamId: string;
      sequence: number;
      type: string;
      timestamp: string;
      data: string | null;
      payload: string | null;
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

      // When seeding from disk (no existing row, no expectedVersion),
      // initialize backend version from state._version to stay in sync
      // with the persisted version counter. (#948)
      let newVersion: number;
      if (!existing && expectedVersion === undefined) {
        const stateVersion = (state as Record<string, unknown>)._version;
        newVersion = typeof stateVersion === 'number' ? stateVersion : currentVersion + 1;
      } else {
        newVersion = currentVersion + 1;
      }
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

  async drainOutbox(
    streamId: string,
    sender: EventSender,
    batchSize?: number,
  ): Promise<DrainResult> {
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
        // Await the sender's Promise before marking confirmed — fire-and-
        // forget would silently swallow async rejections (network timeout,
        // remote 5xx) and strand the event with no retry path. Mirrors the
        // outbox.ts fallback pattern at line 181.
        await sender.appendEvents(streamId, [
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

  // ─── Cleanup Operations ─────────────────────────────────────────────────

  deleteStream(streamId: string): void {
    const deleteFn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM sequences WHERE streamId = ?').run(streamId);
    });
    deleteFn();
  }

  deleteState(featureId: string): void {
    this.db.prepare('DELETE FROM workflow_state WHERE featureId = ?').run(featureId);
  }

  pruneEvents(streamId: string, beforeTimestamp: string): number {
    const result = this.db
      .prepare('DELETE FROM events WHERE streamId = ? AND timestamp < ?')
      .run(streamId, beforeTimestamp);
    return result.changes;
  }

  // ─── Integrity Probe ────────────────────────────────────────────────────

  /**
   * Run `PRAGMA integrity_check` and return its first-row verdict.
   *
   * bun:sqlite is synchronous; wrapping in a Promise lets the caller
   * bound this probe with `Promise.race` (EventStore.runIntegrityCheck
   * applies the timeout — this method is responsible only for honouring
   * `signal` and producing the pragma result string).
   *
   * When `signal` is pre-aborted, rejects immediately with AbortError
   * without opening a pragma; when aborted mid-probe the pragma will
   * still complete (sqlite has no cancellation for synchronous work),
   * but we discard the result and reject.
   */
  async runIntegrityPragma(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        // bun:sqlite returns the PRAGMA integrity_check column unnamed
        // (key is the empty string), unlike better-sqlite3 which keys it
        // by the pragma name. The migration to bun:sqlite (v2.9) silently
        // turned every verdict into '' under the old `rows[0]?.integrity_check`
        // access, so the self-heal path always treated databases as healthy.
        const rows = this.db.query('PRAGMA integrity_check').all() as Array<Record<string, string>>;
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        const firstRow = rows[0];
        const verdict =
          firstRow?.integrity_check ?? // tolerate either-named driver
          firstRow?.[''] ??             // bun:sqlite shape
          '';
        resolve(verdict);
      } catch (err) {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private rowToEvent(row: {
    streamId: string;
    sequence: number;
    type: string;
    timestamp: string;
    data: string | null;
    payload: string | null;
  }): WorkflowEvent {
    // Prefer full payload (preserves all fields); fall back to field-by-field for pre-migration rows
    if (row.payload) {
      return JSON.parse(row.payload) as WorkflowEvent;
    }

    return {
      streamId: row.streamId,
      sequence: row.sequence,
      type: row.type,
      timestamp: row.timestamp,
      ...(row.data ? { data: JSON.parse(row.data) } : {}),
    } as WorkflowEvent;
  }
}
