import { Database, type Statement } from 'bun:sqlite';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type { StorageBackend, EventSender, ViewCacheEntry, DrainResult } from './backend.js';
import { VersionConflictError } from './memory-backend.js';

// ─── AtomicAppender wire types (#1259, T06/T07) ─────────────────────────────
//
// These are the shape passed in by `AtomicAppender`'s SQLite-backed body.
// They are intentionally NOT the canonical `WorkflowEvent` because the
// appender owns sequence allocation and timestamp generation — the
// backend just persists the pre-computed row. Keeping the wire shape
// minimal means the substrate boundary stays narrow and testable.

/** A single pre-allocated event row ready for INSERT. */
export interface AtomicAppendEvent {
  /** Pre-allocated by the appender from `readSequenceHighWaterMark + i + 1`. */
  sequence: number;
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
  /**
   * The full PublicPersistedEvent serialized as JSON. Persisted into
   * `events.payload` so `rowToEvent` can rehydrate the canonical shape on
   * read — preserving idempotencyKey, eventId, correlationId, etc.
   */
  payload: string;
}

/**
 * Shape of an entry returned from `lookupIdempotencyClaim`. Mirrors
 * `PublicPersistedEvent` from `event-store/atomic-appender.ts` — kept here
 * as a structural alias so the storage module does not import from the
 * event-store module (one-way dependency: event-store → storage).
 */
export interface PublicPersistedEventLike {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

// ─── Schema DDL ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 3;

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

-- Idempotency claims for AtomicAppender SQLite-backed body (#1259, T06/T07).
-- Each row records the eventIds, sequences, and timestamps committed under a
-- given (streamId, idempotencyKey) so a retry returns the canonical
-- PublicPersistedEvent shape rather than a synthesized re-walk of the
-- caller's current request body. PRIMARY KEY enforces single-claim semantics
-- per stream/key; events_json stores the full PublicPersistedEvent list as
-- JSON so cache-hit fidelity matches the in-memory v2.9 cache.
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
  // AtomicAppender SQLite-backed body (#1259, T06/T07)
  selectIdempotencyClaim: Statement;
  insertIdempotencyClaim: Statement;
  insertEventStrict: Statement;
}

// ─── SqliteBackend ──────────────────────────────────────────────────────────

const MAX_OUTBOX_RETRIES = 5;

/**
 * Bounded retry policy for SQLITE_BUSY surfaced by the substrate
 * `atomicAppend` write path (#1259, T09, DR-12).
 *
 * The C-level `busy_timeout` pragma is intentionally NOT set — the
 * design (DR-12) routes BUSY recovery through the JS layer so the
 * appender owns observability of retry counts. With `busy_timeout` left
 * at the SQLite default (0), every BUSY surfaces as a thrown error and
 * this layer alone decides whether to retry or escalate.
 *
 * Backoff: `min(baseDelayMs * 2^(attempt-1), maxDelayMs)`. With
 * `baseDelayMs=5, maxDelayMs=100`, the budget across 4 inter-attempt
 * sleeps tops out near 5+10+20+40 = 75 ms — well below the per-call
 * latency budgets of upstream consumers (event_batch_append SLO).
 */
const SQLITE_BUSY_RETRY_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 5,
  maxDelayMs: 100,
} as const;

/**
 * Thrown by `atomicAppend` when SQLITE_BUSY persists past the retry
 * budget. Carries the most-recent driver error as `cause` so the
 * caller (AtomicAppender) can surface a structured `storage_busy`
 * reason without re-inspecting the SQLite error code itself.
 *
 * Distinct error class (rather than re-using SqliteError) because the
 * boundary contract is: SqliteBackend throws either a generic
 * SqliteError (caller treats as io-error) or this typed exhausted
 * marker (caller maps to storage_busy). Keeping the distinction in
 * the type system means the translation is unambiguous.
 */
export class SqliteBusyExhaustedError extends Error {
  override readonly name = 'SqliteBusyExhaustedError';
  readonly code = 'SQLITE_BUSY_EXHAUSTED';
  constructor(
    public readonly attempts: number,
    public override readonly cause: Error,
  ) {
    super(`SQLITE_BUSY persisted after ${attempts} attempts: ${cause.message}`);
  }
}

/**
 * Thrown by `initialize()` when the SQLite database file cannot be
 * opened or read because its bytes are not a valid SQLite database
 * (`SQLITE_NOTADB`) or are structurally broken (`SQLITE_CORRUPT`).
 * The substrate makes corruption a non-recoverable, operator-visible
 * event by design (#1259, T10, DR-12) — auto-rebuilding would silently
 * destroy the evidence operators need to diagnose root cause and would
 * mask data-loss surfaces.
 *
 * The message is deliberately operator-facing: it names the file path
 * and instructs the operator to inspect manually. Consumers should not
 * catch this error and continue — it terminates lifecycle startup.
 */
export class SqliteCorruptError extends Error {
  override readonly name = 'SqliteCorruptError';
  readonly code = 'SQLITE_CORRUPT';
  constructor(
    public readonly dbPath: string,
    public override readonly cause: Error,
  ) {
    super(
      `SQLite database at ${dbPath} is corrupt or not a database (${cause.message}). ` +
        `Manual operator remediation required: inspect the file, restore from backup, ` +
        `or move it aside before retrying. Auto-rebuild is intentionally disabled.`,
    );
  }
}

/**
 * Detect SQLITE_BUSY in a thrown driver error. `bun:sqlite` and
 * `better-sqlite3` (the test-time shim) both expose `.code` as a
 * stringified SQLite error code on their thrown `SqliteError`
 * instances. Falls back to a defensive `false` for non-Error throws.
 */
function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_BUSY';
}

/**
 * Detect SQLITE_CORRUPT and SQLITE_NOTADB. Both surface during
 * `initialize()` against a malformed file and both are operator-fatal
 * in the same way — the substrate cannot proceed and auto-recovery is
 * by design refused.
 */
function isSqliteCorrupt(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
}

/** Sleep helper used by the BUSY retry layer. Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  /**
   * Clock used for outbox retry-eligibility checks. Injectable so tests can
   * advance time without sleeping for real-world backoff windows
   * (`Math.pow(2, attempts) * 1000` ms — up to 32 s before dead-lettering).
   * Defaults to wall-clock time.
   */
  private readonly clock: () => Date;

  constructor(private readonly dbPath: string, opts: { clock?: () => Date } = {}) {
    this.clock = opts.clock ?? (() => new Date());
  }

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
   * V2 -> V3: Scaffolding step (no DDL change). Reserves SCHEMA_VERSION=3 so
   *           later tasks (T02-T04, T12) can register new event types and
   *           tolerant deserialization under a versioned DB shape.
   *
   * Each step short-circuits if its target version is already present in the
   * `schema_version` table, so running migrateSchema() twice on a V3 DB is a
   * no-op (idempotent).
   */
  private migrateSchema(): void {
    // V1 -> V2: payload column. Idempotent via PRAGMA-driven column check —
    // this predates the schema_version table being used as a migration ledger.
    const columns = this.db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;

    const hasPayload = columns.some((col) => col.name === 'payload');

    if (!hasPayload) {
      this.db.exec('ALTER TABLE events ADD COLUMN payload TEXT');
    }

    // V2 -> V3: gated by the schema_version ledger. Only runs when version 3
    // has not yet been recorded. The step body itself is a no-op today
    // (scaffolding for downstream tasks); idempotency comes from the version
    // check, not the body.
    const v3Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(3) as { version: number } | undefined;

    if (!v3Existing) {
      this.migrateV2ToV3();
    }
  }

  /**
   * V2 -> V3 migration step. Currently a no-op pass-through — registered as a
   * named helper so downstream foundation tasks (T02-T04 register new event
   * types, T12 wires tolerant deserialization) have a single seam to extend
   * without rewriting the runner.
   */
  private migrateV2ToV3(): void {
    // No-op. SCHEMA_VERSION=3 itself is recorded by the ledger insert in
    // initialize() once this method returns.
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
      // Honour the exponential-backoff `nextRetryAt` written by
      // `updateOutboxFailed` — without this filter, every drain would
      // immediately retry every failed entry regardless of its scheduled
      // retry time, defeating the backoff and risking a retry storm
      // against a downstream that's already failing. Caller passes an
      // ISO timestamp from `clock()`; rows with NULL `nextRetryAt` (never
      // failed) are always eligible.
      selectPendingOutbox: this.db.prepare(
        `SELECT id, streamId, event, attempts FROM outbox
         WHERE streamId = ? AND status = ?
           AND (nextRetryAt IS NULL OR nextRetryAt <= ?)
         ORDER BY createdAt`,
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
      // AtomicAppender substrate primitives (#1259, T06/T07).
      selectIdempotencyClaim: this.db.prepare(
        'SELECT eventIds, sequences, timestamps, events_json FROM idempotency_claims WHERE streamId = ? AND idempotencyKey = ?',
      ),
      // Strict INSERT (no OR IGNORE): a (streamId, idempotencyKey) collision
      // raises a constraint error so the wrapping transaction can ROLLBACK
      // and the caller observes a typed `idempotency-claimed` failure.
      insertIdempotencyClaim: this.db.prepare(
        'INSERT INTO idempotency_claims (streamId, idempotencyKey, eventIds, sequences, timestamps, events_json, claimedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      // Strict event INSERT: collisions on (streamId, sequence) PRIMARY KEY
      // raise instead of being silently swallowed (the existing
      // `insertEvent` statement uses OR IGNORE for the dual-write replica
      // path; AtomicAppender requires hard failure on collision).
      insertEventStrict: this.db.prepare(
        'INSERT INTO events (streamId, sequence, type, timestamp, data, payload) VALUES (?, ?, ?, ?, ?, ?)',
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

  // ─── AtomicAppender SQLite Body (#1259, T06/T07) ────────────────────────

  /**
   * Look up a previously-committed idempotency claim. Returns the persisted
   * events under the (streamId, idempotencyKey) pair so a retry observes
   * the canonical PublicPersistedEvent shape — same contract as the v2.9
   * in-memory cache hit path.
   *
   * Returns undefined when no claim exists. The caller (AtomicAppender)
   * runs this BEFORE opening the BEGIN IMMEDIATE transaction so cache
   * hits short-circuit without touching the write path.
   */
  lookupIdempotencyClaim(
    streamId: string,
    idempotencyKey: string,
  ):
    | {
        eventIds: string[];
        sequences: number[];
        timestamps: string[];
        events: PublicPersistedEventLike[];
      }
    | undefined {
    const row = this.stmts.selectIdempotencyClaim.get(streamId, idempotencyKey) as
      | { eventIds: string; sequences: string; timestamps: string; events_json: string }
      | undefined;
    if (!row) return undefined;
    return {
      eventIds: JSON.parse(row.eventIds) as string[],
      sequences: JSON.parse(row.sequences) as number[],
      timestamps: JSON.parse(row.timestamps) as string[],
      events: JSON.parse(row.events_json) as PublicPersistedEventLike[],
    };
  }

  /**
   * Read the current sequence high-water mark for a stream. AtomicAppender
   * uses this BEFORE opening the transaction to compute base+i sequences;
   * the transaction's strict-insert into `events` will raise on conflict
   * if a sibling appender slipped in (the per-stream Promise mutex is the
   * first-tier guard; this is the second-tier check).
   */
  readSequenceHighWaterMark(streamId: string): number {
    const row = this.stmts.selectSequence.get(streamId) as { sequence: number } | undefined;
    return row ? row.sequence : 0;
  }

  /**
   * Atomic append: a single `BEGIN IMMEDIATE` transaction wrapping the
   * idempotency-key claim, the per-stream sequence upsert, the event
   * INSERTs, and (when the caller passes pre-built outbox rows) the
   * outbox INSERTs. Commits as a unit; rolls back on any error.
   *
   * Throws on:
   *   - SQLITE_CONSTRAINT (idempotency collision or sequence collision)
   *   - Any underlying SQLite error (BUSY, IO, etc.)
   *
   * The caller (AtomicAppender) translates thrown errors into the typed
   * `AppendResult` failure shape. Returning instead of throwing would
   * require leaking SQLite-specific reason codes through the backend
   * boundary, which inverts the design's storage-handle abstraction.
   *
   * `bun:sqlite`'s `db.transaction(fn)` wrapper opens a `BEGIN` (deferred)
   * by default; the design (DR-1) calls for `BEGIN IMMEDIATE` so the
   * write lock is acquired up-front — preventing two transactions from
   * running their reads in parallel and racing to write. We pass
   * `'immediate'` to honour that.
   */
  async atomicAppend(args: {
    streamId: string;
    idempotencyKey: string | null;
    events: AtomicAppendEvent[];
    claim?: {
      eventIds: string[];
      sequences: number[];
      timestamps: string[];
      events_json: string;
    };
  }): Promise<void> {
    const txn = this.db.transaction(() => {
      // Idempotency claim (single row per (streamId, key)) — strict INSERT
      // so a collision aborts the txn, ROLLBACK is automatic via the
      // wrapper, and no half-written event/claim survives.
      if (args.idempotencyKey !== null && args.claim) {
        this.stmts.insertIdempotencyClaim.run(
          args.streamId,
          args.idempotencyKey,
          JSON.stringify(args.claim.eventIds),
          JSON.stringify(args.claim.sequences),
          JSON.stringify(args.claim.timestamps),
          args.claim.events_json,
          new Date().toISOString(),
        );
      }

      // Event INSERTs — strict so (streamId, sequence) collisions raise.
      for (const evt of args.events) {
        const data = evt.data !== undefined ? JSON.stringify(evt.data) : null;
        this.stmts.insertEventStrict.run(
          args.streamId,
          evt.sequence,
          evt.type,
          evt.timestamp,
          data,
          evt.payload,
        );
      }

      // Sequence high-water mark upsert — only the final sequence matters.
      const finalSeq = args.events[args.events.length - 1].sequence;
      this.stmts.upsertSequence.run(args.streamId, finalSeq);
    });

    // `bun:sqlite` exposes `transaction(fn).immediate(args)` to open
    // BEGIN IMMEDIATE explicitly. The shimmed `better-sqlite3` driver
    // supports the same shape (the shim wraps better-sqlite3 1:1 — see
    // src/storage/__shims__/bun-sqlite-node.ts).
    const txnUnknown = txn as unknown as {
      immediate?: (...args: unknown[]) => void;
    };
    const runOnce = (): void => {
      if (typeof txnUnknown.immediate === 'function') {
        txnUnknown.immediate();
      } else {
        // Fallback: the wrapper opens a default `BEGIN` (deferred). The
        // per-stream Promise mutex (AtomicAppender's first-tier guard)
        // still prevents intra-process write races; the deferred-vs-
        // immediate distinction matters for cross-process writers, which
        // are out of scope for the POC.
        txn();
      }
    };

    // Bounded retry loop over SQLITE_BUSY — DR-12 (#1259, T09).
    // Each attempt opens a FRESH transaction (BEGIN IMMEDIATE re-issues
    // because the wrapper's `runOnce` re-enters the helper). Non-BUSY
    // errors propagate immediately — they're transactional faults the
    // caller must surface as `idempotency-claimed` / `sequence-conflict`
    // / `io-error`, not as retry candidates.
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= SQLITE_BUSY_RETRY_POLICY.maxAttempts; attempt++) {
      try {
        runOnce();
        return;
      } catch (err) {
        if (!isSqliteBusy(err)) {
          throw err;
        }
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < SQLITE_BUSY_RETRY_POLICY.maxAttempts) {
          // Exponential backoff capped at maxDelayMs. attempt=1 → 5ms,
          // attempt=2 → 10ms, attempt=3 → 20ms, attempt=4 → 40ms.
          const delay = Math.min(
            SQLITE_BUSY_RETRY_POLICY.baseDelayMs * Math.pow(2, attempt - 1),
            SQLITE_BUSY_RETRY_POLICY.maxDelayMs,
          );
          await sleep(delay);
        }
      }
    }
    // Budget exhausted — surface a typed marker so the caller maps it
    // to `reason: 'storage_busy'` without inspecting SQLite reason codes.
    throw new SqliteBusyExhaustedError(
      SQLITE_BUSY_RETRY_POLICY.maxAttempts,
      lastErr ?? new Error('SQLITE_BUSY (no captured cause)'),
    );
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
    const nowDate = this.clock();
    const nowIso = nowDate.toISOString();
    const rows = this.stmts.selectPendingOutbox.all(streamId, 'pending', nowIso) as Array<{
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

        this.stmts.updateOutboxConfirmed.run('confirmed', nowIso, row.id);
        sent++;
      } catch (err) {
        const newAttempts = row.attempts + 1;
        // Preserve the original sender error in the `error` column so
        // operators can diagnose retry storms without correlating
        // against an external log. Truncate to keep one row's footprint
        // bounded; longer payloads are still findable in the MCP
        // server's pino log.
        const rawMessage = err instanceof Error ? err.message : String(err);
        const errorMessage = rawMessage.length > 512
          ? `${rawMessage.slice(0, 509)}...`
          : rawMessage;

        if (newAttempts >= MAX_OUTBOX_RETRIES) {
          // Dead-letter after max retries — keep the most recent error
          // so the dead-letter row carries the cause of death.
          this.stmts.updateOutboxDeadLetter.run(
            'dead-letter',
            nowIso,
            `Max retries exceeded: ${errorMessage}`,
            row.id,
          );
        } else {
          // Schedule retry with exponential backoff (computed against the
          // injected clock so tests can advance time deterministically
          // instead of sleeping through real-world delays).
          const retryDelayMs = Math.pow(2, newAttempts) * 1000;
          const nextRetry = new Date(nowDate.getTime() + retryDelayMs).toISOString();
          this.stmts.updateOutboxFailed.run(
            'pending',
            newAttempts,
            nowIso,
            nextRetry,
            errorMessage,
            row.id,
          );
        }
        failed++;
        // Stop on first failure to preserve FIFO — events carry monotonic
        // `sequence` and consumers expect ordered delivery. Letting later
        // rows succeed past a stranded earlier row would surface them out
        // of order; remaining rows stay pending for the next drain.
        break;
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
