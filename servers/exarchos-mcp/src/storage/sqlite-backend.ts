import { Database, type Statement } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename, resolve, relative, isAbsolute } from 'node:path';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type {
  StorageBackend,
  EventSender,
  ViewCacheEntry,
  DrainResult,
  WorkflowSummary,
  WorkflowSummaryFilter,
} from './backend.js';
import { deriveWorkflowStatus, matchesWorkflowSummaryFilter } from './backend.js';
import { VersionConflictError } from './memory-backend.js';
import type { SnapshotRecord } from '../projections/snapshot-schema.js';
import { resolveMaxRecords } from './snapshot-retention.js';

// ─── AtomicAppender wire types (#1259, T06/T07) ─────────────────────────────
//
// These are the shape passed in by `AtomicAppender`'s SQLite-backed body.
// They are intentionally NOT the canonical `WorkflowEvent` because the
// appender owns sequence allocation and timestamp generation — the
// backend just persists the pre-computed row. Keeping the wire shape
// minimal means the substrate boundary stays narrow and testable.

/** A single pre-allocated event row ready for INSERT. */
export interface AtomicAppendEvent {
  /** Assigned by the appender's `finalize(base)` as `base + i + 1`, where
   *  `base` is the stream-version gate's return value (allocated INSIDE the
   *  write transaction — not a pre-transaction read). */
  sequence: number;
  type: string;
  timestamp: string;
  data?: Record<string, unknown> | undefined;
  /**
   * The full PublicPersistedEvent serialized as JSON. Persisted into
   * `events.payload` so `rowToEvent` can rehydrate the canonical shape on
   * read — preserving idempotencyKey, eventId, correlationId, etc.
   */
  payload: string;
  /**
   * #1437 — three V6 indexed correlation columns. Stamped onto the
   * PublicPersistedEvent by `stampWithDispatchContext` (store.ts) when an
   * active `DispatchContext` is present. Surfaced on the wire shape so
   * the SQLite `insertEventStrict` bind can populate the indexed
   * `operation_id` / `correlation_id` / `causation_id` columns alongside
   * the JSON payload. Optional because pre-context callers (raw test
   * fixtures, migration paths) emit unstamped events.
   *
   * Source of truth for the data remains `payload`; these fields exist
   * purely as the indexed filter handle for telemetry views (INV-1).
   */
  operationId?: string;
  correlationId?: string;
  causationId?: string;
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

const SCHEMA_VERSION = 6;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS events (
  streamId       TEXT NOT NULL,
  sequence       INTEGER NOT NULL,
  type           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  data           TEXT,
  payload        TEXT,
  operation_id   TEXT,
  correlation_id TEXT,
  causation_id   TEXT,
  PRIMARY KEY (streamId, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(streamId, type);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(streamId, timestamp);
-- V6 indexes on the correlation columns (#1437) live in migrateV5ToV6 rather
-- than here: when SCHEMA_DDL runs against a legacy V<6 events table the
-- CREATE TABLE IF NOT EXISTS is a no-op, so the correlation columns are
-- still absent, and a CREATE INDEX on those columns would error. The
-- migration creates them after the ALTERs (or no-ops on a fresh DB where
-- the columns are already in place via the CREATE TABLE above).

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

-- Projection snapshots (V4 -> V5, #1343 Wave A). Replaces the per-stream
-- JSONL sidecar at <stateDir>/<streamId>.projections.jsonl with a relational
-- table. Composite PK (stream_id, projection_id, projection_version, sequence)
-- so multiple snapshots for the same projection coexist; the latest-by-sequence
-- index supports the readLatestProjectionSnapshot LIMIT 1 fast path. The
-- payload column holds the JSON-encoded SnapshotRecord (projectionId,
-- projectionVersion, sequence, state, timestamp).
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
 * `workflowType` for a summary row: the registry's column when the `streams`
 * row exists, else the workflow_state row's own copy, else `''`. Used by BOTH
 * the SELECT projection and the WHERE pushdown in
 * {@link SqliteBackend.listWorkflowSummaries} so the filtered and projected
 * values can never disagree. The `''` tail mirrors the in-memory backend's
 * `typeof state.workflowType === 'string' ? state.workflowType : ''`, keeping
 * the two backends row-for-row equivalent (INV-2).
 */
const WORKFLOW_TYPE_EXPR = `COALESCE(s.workflow_type, json_extract(ws.state, '$.workflowType'), '')`;

/**
 * Bounded retry policy for SQLITE_BUSY surfaced by the substrate
 * `atomicAppend` write path (#1259, T09, DR-12, refined by audit §F2.2).
 *
 * Two-tier BUSY recovery — see `applyConnectionPragmas` for the full
 * model. The C-level `busy_timeout = 5000` pragma is the silent
 * absorption tier; this constant configures the JS-level observability
 * tier. The two layers are NOT redundant: the C layer catches
 * microsecond-scale contention without surfacing errors; the JS layer
 * counts the cases where the C-layer's 5-second window expires, making
 * the retry observable to the appender for structured failure
 * reporting (`storage_busy`).
 *
 * Originally DR-12 set busy_timeout=0 and made this layer the sole
 * BUSY handler. The audit (§F2.2) flagged that approach as exposing
 * every microsecond-level contention as a JS-layer retry, exhausting
 * the budget on noise. The C layer is now the absorption tier; this
 * layer is the escalation tier.
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
 * Thrown by the in-transaction stream-version gate (`allocateSequence`)
 * when the caller's `expectedSequence` does not match the stream's durable
 * tail. This is the convergent event-store OCC primitive (Marten `mt_streams`,
 * SQLStreamStore `Streams`, EventStoreDB stream metadata, EventFabric
 * `stream_versions`): the version is assigned **and** checked atomically
 * inside `BEGIN IMMEDIATE`, so the conflict signal carries the real
 * `expected`/`actual` directly — no post-hoc PRIMARY KEY violation, no
 * regex translation of a constraint-error string.
 *
 * Thrown inside the transaction body so the wrapping `db.transaction`
 * rolls the whole append back (the gate bump, the events, the claim) as a
 * unit. `atomicAppend` lets it propagate past the SQLITE_BUSY retry loop
 * (it is not a busy error) and the caller (`AtomicAppender`) maps it to the
 * typed `sequence-conflict` AppendResult.
 */
export class SequenceGateConflictError extends Error {
  override readonly name = 'SequenceGateConflictError';
  readonly code = 'SEQUENCE_GATE_CONFLICT';
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`stream-version gate: expected ${expected}, actual ${actual}`);
  }
}

/**
 * Thrown by `initialize()` when the SQLite driver does not expose the
 * `transaction(fn).immediate()` variant. Cross-process write correctness
 * depends on `BEGIN IMMEDIATE` acquiring the write lock up-front: a deferred
 * `BEGIN` that reads then upgrades to a write is the classic SQLite
 * lock-upgrade deadlock that `busy_timeout` cannot resolve, and it reopens
 * the very TOCTOU window the stream-version gate closes. Rather than
 * silently degrade to that path, the substrate refuses to start — fail-fast,
 * operator-visible (DR-3). Both supported drivers (`bun:sqlite` in
 * production, `better-sqlite3` via the test shim) expose `.immediate`.
 */
export class SqliteImmediateUnsupportedError extends Error {
  override readonly name = 'SqliteImmediateUnsupportedError';
  readonly code = 'SQLITE_IMMEDIATE_UNSUPPORTED';
  constructor() {
    super(
      'SQLite driver does not expose transaction(fn).immediate(): BEGIN ' +
        'IMMEDIATE is required for cross-process write correctness (the ' +
        'stream-version gate and lock-upgrade-deadlock avoidance both depend ' +
        'on it). Refusing to start rather than silently using a deferred ' +
        'BEGIN. Use bun:sqlite (production) or better-sqlite3 (tests).',
    );
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

  /**
   * Whether {@link close} has run. Guards against a double `db.close()`,
   * which throws ("database is not open") on the underlying driver — so
   * `close()` is safely idempotent for repeated test-teardown calls.
   */
  private closed = false;

  /**
   * Process-wide registry of currently-open backends, keyed by identity.
   * A backend adds itself once its handle is open (see {@link initialize})
   * and removes itself in {@link close}. Two uses:
   *   1. Graceful shutdown — release every live SQLite handle in one call.
   *   2. Windows-safe test teardown — {@link closeOpenUnder} lets `rmrf()`
   *      release a handle that was opened deep inside a production call the
   *      test never named, so the temp dir can be removed (NTFS forbids
   *      unlinking a file with an open handle).
   * Bounded: entries are removed on close, so size tracks live handles only.
   */
  private static readonly openInstances = new Set<SqliteBackend>();

  /**
   * Close every currently-open backend whose database file lives under `dir`
   * (path-prefix match, resolved cross-platform). Idempotent and
   * best-effort. Used by the `rmrf()` test helper before removing a temp dir.
   */
  static closeOpenUnder(dir: string): void {
    const root = resolve(dir);
    for (const backend of [...SqliteBackend.openInstances]) {
      const rel = relative(root, resolve(backend.dbPath));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        backend.close();
      }
    }
  }

  /** Count of currently-open backends — leak diagnostics / shutdown checks. */
  static openHandleCount(): number {
    return SqliteBackend.openInstances.size;
  }

  /** Cache for dynamically built prepared statements (queryEvents). Key = SQL string. */
  private queryStmtCache: Map<string, Statement> = new Map();

  /**
   * Counter for queries that exercised the indexed-WHERE fast path on the
   * V6 correlation columns (operation_id, correlation_id, causation_id).
   *
   * Incremented ONCE per query when any of the three correlation filter
   * fields is supplied — NOT once per clause appended, so a caller passing
   * all three filters still counts as 1.
   *
   * Exposed via {@link getStats}. Closes the DIM-2 LOW finding from PR
   * #1447's axiom audit (#1448 item 5): without this counter a silent
   * index regression would produce correct answers via full-scan and stay
   * invisible until users notice the latency.
   */
  private correlationFilteredQueries = 0;

  /**
   * Counter for {@link listWorkflowSummaries} calls that pushed a
   * `workflow_type` predicate down to the indexed SQL WHERE (the
   * `idx_streams_workflow_type` fast path). Incremented ONCE per filtered
   * query. Exposed via {@link getStats} so the
   * `WorkflowFold_TypeFilter_PushedDownToIndexedColumn` gate can assert the
   * type filter took the index path rather than a post-fetch JS scan — a
   * silent regression to a full workflow_state × streams scan would still
   * return correct rows and otherwise stay invisible until users notice the
   * latency.
   */
  private workflowTypePushdownQueries = 0;

  /**
   * Clock used for outbox retry-eligibility checks. Injectable so tests can
   * advance time without sleeping for real-world backoff windows
   * (`Math.pow(2, attempts) * 1000` ms — up to 32 s before dead-lettering).
   * Defaults to wall-clock time.
   */
  private readonly clock: () => Date;

  /**
   * Durability posture for `PRAGMA synchronous` (DR-4). `'normal'` (the
   * default) is durable across process crash but may lose the last
   * committed transaction(s) on OS crash / power loss — consistent with the
   * INV-13 intent/result crash-recovery design, which tolerates tail loss.
   * `'full'` fsyncs on every commit (power-loss durable, lower throughput).
   * Resolved from `.exarchos.yml` `storage.synchronous` by the caller.
   */
  private readonly synchronous: 'normal' | 'full';

  constructor(
    private readonly dbPath: string,
    opts: { clock?: () => Date; synchronous?: 'normal' | 'full' } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    if (
      opts.synchronous !== undefined &&
      opts.synchronous !== 'normal' &&
      opts.synchronous !== 'full'
    ) {
      throw new Error(
        `invalid storage.synchronous: ${String(opts.synchronous)} (expected 'normal' | 'full')`,
      );
    }
    this.synchronous = opts.synchronous ?? 'normal';
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  initialize(): void {
    try {
      this.db = new Database(this.dbPath);
      // Track the live handle from the moment it opens, so a partial-init
      // failure below still leaves a closeable, registered handle (rather
      // than a leak that locks the file on Windows).
      SqliteBackend.openInstances.add(this);

      // Tune the connection for concurrent read/write (WAL, NORMAL sync) and
      // read-heavy access patterns (256 MB memory-mapped I/O).
      // Note: `bun:sqlite` has no `.pragma()` helper — write-pragmas go through
      // `db.exec()` and read-pragmas through `db.query().all()`.
      this.applyConnectionPragmas();

      // Fail fast if the driver cannot open BEGIN IMMEDIATE (DR-3). The
      // stream-version gate and lock-upgrade-deadlock avoidance both require
      // it; a deferred-BEGIN fallback is not a safe degradation.
      this.assertImmediateSupported();

      // Execute schema DDL
      this.db.exec(SCHEMA_DDL);

      // Run migrations for existing databases
      this.migrateSchema();

      // V6 indexes on correlation columns (#1437). Deferred to here rather
      // than living inside SCHEMA_DDL because on a legacy V<6 events table
      // the SCHEMA_DDL `CREATE TABLE IF NOT EXISTS` is a no-op (table
      // already exists) so the correlation columns are still absent and a
      // CREATE INDEX against them would error. migrateSchema() above is
      // what guarantees the columns are in place; once it returns, the
      // indexes can be (re-)applied idempotently against either a fresh
      // V6 table or a just-migrated legacy table.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id);
        CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id);
      `);

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
    } catch (err) {
      // SQLITE_CORRUPT / SQLITE_NOTADB at startup: refuse to proceed.
      // The substrate intentionally does NOT auto-rebuild — silent rebuild
      // would destroy the byte evidence operators need to root-cause the
      // corruption and could mask a data-loss surface that should escalate
      // to operator intervention. (#1259, T10, DR-12.)
      //
      // Best-effort close of any partially-opened handle so the malformed
      // file isn't left locked against an operator's recovery tooling.
      if (isSqliteCorrupt(err)) {
        // close() deregisters + closes idempotently (swallows driver errors),
        // so the malformed file isn't left locked against recovery tooling.
        this.close();
        throw new SqliteCorruptError(
          this.dbPath,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    SqliteBackend.openInstances.delete(this);
    // `db` is definite-assignment (`db!`); the try/catch also makes a double
    // close (or a never-opened handle) a no-op rather than a driver throw.
    try {
      this.db?.close();
    } catch {
      // already closed / never opened — close is best-effort and idempotent
    }
    // Prepared statements are invalid once the connection is closed; drop the
    // cache so a stale handle can't be reused after close.
    this.queryStmtCache.clear();
  }

  /**
   * Apply the fixed set of connection-level pragmas (WAL, synchronous=NORMAL,
   * mmap_size=256MB, busy_timeout=5000ms). Kept in a single helper so the
   * values and order are easy to audit — pragma order matters for some
   * SQLite configurations.
   *
   * Two-tier BUSY recovery (audit §F2.2 + DR-12).
   *
   * busy_timeout=5000ms is the C-layer silent-absorption tier. SQLite's C
   * runtime spins on a contended write lock for up to 5 seconds, retrying
   * internally on the order of microseconds, before surfacing
   * SQLITE_BUSY. This catches the overwhelming majority of cross-process
   * lock contention without ever propagating an error into the JS layer.
   *
   * SQLITE_BUSY_RETRY_POLICY (declared above, near line 168) is the
   * JS-layer observability tier. When the C-layer's window expires and
   * SQLITE_BUSY surfaces, the JS retry budget kicks in: up to 5 attempts
   * with exponential backoff (~75ms total wall time). The JS layer is
   * where retry counts become visible — it's the right place for
   * observability because every retry there is a real escalation past
   * the silent C-layer absorption.
   *
   * DO NOT collapse these two layers into one. Removing busy_timeout
   * makes every microsecond-scale contention surface as SQLITE_BUSY,
   * exhausting the JS retry budget on noise. Removing the JS retry
   * layer eliminates the observability surface — a 5-second silent
   * stall is indistinguishable from a healthy write.
   */
  /**
   * Assert the driver exposes `transaction(fn).immediate()` (DR-3). Probes a
   * no-op transaction wrapper for the `.immediate` method. Throws
   * {@link SqliteImmediateUnsupportedError} when absent so `atomicAppend`
   * never falls back to a deferred `BEGIN`.
   */
  private assertImmediateSupported(): void {
    const probe = this.db.transaction(() => {}) as unknown as {
      immediate?: (...args: unknown[]) => void;
    };
    if (typeof probe.immediate !== 'function') {
      throw new SqliteImmediateUnsupportedError();
    }
  }

  private applyConnectionPragmas(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    // Durability posture (DR-4). NORMAL (default): the WAL is fsync'd at
    // checkpoint, not at every commit — durable across a PROCESS crash, but
    // the last committed transaction(s) can be lost on OS crash / power loss.
    // This is the SQLite-recommended WAL setting and is consistent with the
    // INV-13 intent/result recovery model (a lost tail is re-derived, not
    // trusted). FULL fsyncs on every commit (power-loss durable, slower).
    // Configurable via `.exarchos.yml` `storage.synchronous`.
    this.db.exec(
      `PRAGMA synchronous = ${this.synchronous === 'full' ? 'FULL' : 'NORMAL'}`,
    );
    this.db.exec('PRAGMA mmap_size = 268435456');
    // C-layer BUSY safety net (audit §F2.2). See JSDoc above for the
    // two-tier model that this pragma anchors.
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  /**
   * Run incremental schema migrations for existing databases.
   * V1 -> V2: Add payload column to events table for full event preservation.
   * V2 -> V3: Scaffolding step (no DDL change). Reserves SCHEMA_VERSION=3 so
   *           later tasks (T02-T04, T12) can register new event types and
   *           tolerant deserialization under a versioned DB shape.
   * V3 -> V4: R-1 Marten primitive (#1313). Materialize the `streams`
   *           registry table with a mandatory `workflow_type` column and
   *           backfill `__legacy` for every pre-existing stream row in
   *           `sequences`. Indexes + state-file backfill + the
   *           `migration.workflow_type_unknown` observability event live in
   *           sibling subtasks (1.2, 1.5, 1.6).
   * V4 -> V5: #1343 Wave A. Add `projection_snapshots` table and the
   *           `idx_projection_snapshots_latest` index that replace the
   *           JSONL sidecar at <stateDir>/<streamId>.projections.jsonl.
   *           Idempotent via CREATE TABLE IF NOT EXISTS; SCHEMA_DDL above
   *           creates the table on fresh DBs, and this step covers legacy
   *           DBs that were stamped at V4 before #1343 landed.
   * V5 -> V6: #1437 correlation-indexed columns. Add three top-level
   *           materialized columns on `events` (`operation_id`,
   *           `correlation_id`, `causation_id`) plus three indexes
   *           (`idx_events_correlation`, `idx_events_causation`,
   *           `idx_events_operation`) so the dispatch-correlation tuple
   *           (#1291) is filterable in O(log n) on `EventStore.queryEvents`
   *           — including operation_id-only filters used by cross-stream
   *           queries via `EventStore.queryByType`. Backfills legacy rows
   *           from their `payload` JSON inside the same transaction;
   *           chunked progress events land on the internal `__migration__`
   *           stream.
   *
   * Each step short-circuits if its target version is already present in the
   * `schema_version` table, so running migrateSchema() twice on a V6 DB is a
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

    // V3 -> V4: gated by the schema_version ledger. Creates the `streams`
    // registry (V3 had none — stream existence was implicit in `sequences`)
    // and backfills the `__legacy` sentinel for each pre-existing stream.
    const v4Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(4) as { version: number } | undefined;

    if (!v4Existing) {
      this.migrateV3ToV4();
    }

    // V4 -> V5: gated by the schema_version ledger. Adds the
    // `projection_snapshots` table + `idx_projection_snapshots_latest` index
    // for #1343 Wave A. Fresh DBs already have the table via SCHEMA_DDL; this
    // path covers DBs created under SCHEMA_VERSION === 4.
    const v5Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(5) as { version: number } | undefined;

    if (!v5Existing) {
      this.migrateV4ToV5();
    }

    // V5 -> V6: gated by the schema_version ledger. Adds the three
    // correlation columns (operation_id, correlation_id, causation_id) on
    // `events` for #1437 indexed-filter substrate. Backfills legacy rows
    // from their `payload` JSON inside the same transaction; chunked
    // progress events land on the internal `__migration__` stream. On a
    // fresh DB the ALTER TABLE statements are skipped via PRAGMA gating
    // because SCHEMA_DDL already created the columns; on a legacy V5 DB
    // the ALTERs add the columns and the backfill populates them.
    const v6Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(6) as { version: number } | undefined;

    if (!v6Existing) {
      this.migrateV5ToV6();
    }
  }

  /**
   * V2 -> V3 migration step. Currently a no-op pass-through — registered as a
   * named helper so downstream foundation tasks (T02-T04 register new event
   * types, T12 wires tolerant deserialization) have a single seam to extend
   * without rewriting the runner.
   *
   * Records version=3 in the schema_version ledger explicitly. Before V4
   * existed, the SCHEMA_VERSION=3 sentinel was inserted by initialize()
   * itself; that insert now records version=4, so each migrate helper is
   * responsible for stamping its own target version. Without this stamp,
   * the gating check in migrateSchema (`SELECT WHERE version = 3`) would
   * re-run migrateV2ToV3 on every open of a V4-current DB.
   */
  private migrateV2ToV3(): void {
    this.db
      .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
      .run(3, new Date().toISOString());
  }

  /**
   * V3 -> V4 migration step. Marten R-1 primitive (#1313).
   *
   * Creates the `streams` registry table with a mandatory `workflow_type`
   * column, then backfills one row per existing stream from the V3
   * `sequences` table with the `__legacy` sentinel. The sentinel marks
   * streams whose workflow type cannot be derived structurally; later
   * subtasks (1.5) walk state files to replace it with a recovered type
   * where possible.
   *
   * The design (`R-1: Mandatory workflow_type Column`) calls for
   *   ALTER TABLE streams ADD COLUMN workflow_type TEXT NOT NULL DEFAULT '__legacy'
   * but V3 has no `streams` table to ALTER. We CREATE it instead, which
   * yields the same observable shape: a NOT NULL column with `__legacy`
   * default. The DEFAULT serves only as belt-and-suspenders for any code
   * path that later inserts without a workflow_type — `workflow.init` is
   * the sole writer (task 1.3) and always passes one explicitly.
   *
   * `status TEXT` is reserved here so the composite index `(workflow_type,
   * status)` (task 1.2) has both columns available; the read-side wiring
   * is deferred to v2.12 (#1090) and `status` is not yet populated.
   */
  private migrateV3ToV4(): void {
    // Atomicity guard (Sentry #14059742 / #14059864): the entire step —
    // table+index DDL, registry backfill, state-file recovery, observability
    // event emission, AND the schema_version stamp — runs inside ONE
    // transaction. Without it, a crash between the inner `emitAll`
    // transaction commit and the schema_version insert leaves V4 data on
    // disk with the ledger still at V3. The next startup re-runs the step,
    // re-emits `migration.workflow_type_unknown` events at fresh sequence
    // numbers, and silently duplicates the operator-visibility events
    // (violating the "one observability event per unresolved stream"
    // contract). Wrapping in one transaction guarantees either the whole
    // migration is durable + ledgered, or none of it is.
    //
    // Nested-transaction note: `emitWorkflowTypeUnknownEvents` already wraps
    // its per-stream INSERT/UPSERT in a `db.transaction(...)`. better-sqlite3
    // flattens nested transaction-function calls (the inner one uses a
    // SAVEPOINT and rejoins the outer boundary), so this composition is safe.
    const now = new Date().toISOString();
    const runMigration = this.db.transaction((): void => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS streams (
          streamId      TEXT PRIMARY KEY,
          workflow_type TEXT NOT NULL DEFAULT '__legacy',
          status        TEXT,
          createdAt     TEXT NOT NULL
        );
        -- Indexes for v2.12 filtered ps/pipeline/view queries (#1090). The
        -- read side is deferred to v2.12, but Wave 1 lands the indexes so the
        -- moment those queries ship, every plan is O(log n) without a separate
        -- migration window. Single-column index serves bare workflowType
        -- equality filters; composite serves the more common workflowType +
        -- status filters once status starts being populated by the merge
        -- orchestrator (Wave 4).
        CREATE INDEX IF NOT EXISTS idx_streams_workflow_type
          ON streams(workflow_type);
        CREATE INDEX IF NOT EXISTS idx_streams_workflow_type_status
          ON streams(workflow_type, status);
      `);

      // Backfill the registry from the V3 implicit stream set (sequences).
      // INSERT OR IGNORE so re-running the migration does not duplicate rows;
      // a stream already inserted by a later code path (task 1.3) keeps its
      // row untouched. Uses OR IGNORE rather than ON CONFLICT DO NOTHING for
      // compatibility with the older SQLite the test-time better-sqlite3 shim
      // ships with.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO streams (streamId, workflow_type, createdAt)
           SELECT streamId, '__legacy', ? FROM sequences`,
        )
        .run(now);

      // Recover workflowType from co-located state files where available.
      // The migration walks <stateDir>/*.state.json (the SQLite db lives at
      // <stateDir>/exarchos.db by convention; see AtomicAppender.dbPath) and
      // for each file with a parseable `workflowType` issues
      //   UPDATE streams SET workflow_type = ? WHERE streamId = ? AND workflow_type = '__legacy'
      // Constraining to '__legacy' protects rows already carrying a typed
      // value (e.g. inserted by a concurrent handleInit during the migration
      // window — unlikely under the in-transaction serialization, but the guard makes the update
      // safe regardless). This is the ONLY UPDATE of workflow_type in the
      // codebase — task 1.7 enforces immutability everywhere else via a CI
      // grep gate.
      this.backfillWorkflowTypeFromStateFiles();

      // Stamp version=4 in the ledger so migrateSchema short-circuits on the
      // next open. initialize() also INSERT OR IGNORE's the current
      // SCHEMA_VERSION; this insert is the belt to that suspenders.
      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
        .run(4, now);
    });
    runMigration();
  }

  /**
   * V4 -> V5 migration step. #1343 Wave A.
   *
   * Creates the `projection_snapshots` table + `idx_projection_snapshots_latest`
   * index that replace the per-stream JSONL sidecar
   * (`<stateDir>/<streamId>.projections.jsonl`). The same DDL lives in
   * SCHEMA_DDL above so fresh DBs get the table during the initial
   * `db.exec(SCHEMA_DDL)` pass; this helper exists only to cover legacy DBs
   * that were stamped at V4 before #1343 landed.
   *
   * `CREATE TABLE IF NOT EXISTS` makes the step idempotent — if a parallel
   * caller (or the SCHEMA_DDL pass above) has already created the table,
   * this is a no-op. The ledger stamp at the bottom is what actually closes
   * the V4 -> V5 gate so the runner short-circuits on subsequent opens.
   *
   * Per plan-review decision (`Stacked-PR plan.JSONL sidecar backfill`):
   * skip backfill. v2.10.0-preview.2 is pre-release; no production users
   * have accumulated sidecar data, so migration code would be dead weight.
   */
  private migrateV4ToV5(): void {
    this.db.exec(`
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
    `);

    this.db
      .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
      .run(5, new Date().toISOString());
  }

  /**
   * V5 -> V6 migration step. #1437 correlation-indexed columns.
   *
   * Materializes the dispatch-correlation tuple from #1291
   * (`operationId`, `correlationId`, `causationId`) as three top-level
   * columns on `events` so `EventStore.queryEvents` can filter on them
   * in O(log n) instead of scanning every row's `payload` JSON.
   *
   * Inside ONE `db.transaction(...)` (Sentry-pattern atomicity guard, see
   * the V3->V4 helper for the rationale around mixed DDL + observability
   * emission):
   *   1. ALTER TABLE events ADD COLUMN operation_id/correlation_id/causation_id
   *      — PRAGMA-gated per column. On a fresh DB the columns are already
   *      present from SCHEMA_DDL and the ALTER is skipped; on a legacy V5
   *      DB this step adds them.
   *   2. CREATE INDEX IF NOT EXISTS idx_events_correlation
   *      (correlation_id, sequence), idx_events_causation (causation_id),
   *      and idx_events_operation (operation_id).
   *   3. Backfill correlation columns from each row's `payload` JSON via
   *      `json_extract($.operationId / $.correlationId / $.causationId)`.
   *      Scoped to `WHERE correlation_id IS NULL` so re-runs are no-ops
   *      and rows already populated by the writer path (Wave 3) are
   *      preserved. Task 6 chunks the UPDATE and adds per-chunk progress
   *      events on the internal `__migration__` stream.
   *   4. INSERT OR IGNORE schema_version (6, now).
   *
   * Backfill semantics — NULL fallback (design §"Backfill semantics"):
   *   Rows whose payload is unparseable as JSON, lacks the three fields,
   *   or has them set to JSON null keep NULL columns. NULL is the correct
   *   marker for "this row predates correlation threading" (every
   *   pre-#1428 event is unstamped) and matches the natural column state.
   *   No tolerate-and-warn surface is needed because the data is
   *   genuinely absent, not malformed.
   *
   * Idempotent: re-running on a V6 DB short-circuits at the ledger gate
   * in migrateSchema(); even if invoked directly, every step is a no-op
   * (column-presence PRAGMA, index IF NOT EXISTS, scoped UPDATE WHERE
   * correlation_id IS NULL, ledger INSERT OR IGNORE).
   */
  private migrateV5ToV6(): void {
    const now = new Date().toISOString();
    const runMigration = this.db.transaction((): void => {
      // PRAGMA-gated ALTERs: on a fresh DB SCHEMA_DDL already added the
      // columns; on a legacy V5 DB they're absent. The check makes the
      // helper safe to call against either shape.
      const columns = this.db
        .prepare('PRAGMA table_info(events)')
        .all() as Array<{ name: string }>;
      const have = new Set(columns.map((c) => c.name));

      if (!have.has('operation_id')) {
        this.db.exec('ALTER TABLE events ADD COLUMN operation_id TEXT');
      }
      if (!have.has('correlation_id')) {
        this.db.exec('ALTER TABLE events ADD COLUMN correlation_id TEXT');
      }
      if (!have.has('causation_id')) {
        this.db.exec('ALTER TABLE events ADD COLUMN causation_id TEXT');
      }

      // Indexes — IF NOT EXISTS makes this safe against the post-migrate
      // index DDL block in initialize() that also creates them for the
      // fresh-DB path.
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence)',
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id)',
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id)',
      );

      // Chunked backfill from payload JSON. WHERE correlation_id IS NULL
      // keeps this idempotent — a re-run only touches still-NULL rows, so
      // the post-#1428 writer path (Wave 3) and previous migration passes
      // are preserved. Payloads that lack the fields produce JSON-NULL
      // from json_extract, which is converted to SQL NULL — same shape
      // the writer path produces for unstamped events, so the column
      // stays the right kind of empty.
      //
      // Chunked rather than single-shot so multi-thousand-row DBs (the
      // EventSourcedTaskStore generates dense `task.polled` traffic) get
      // observable progress events instead of a multi-second silent
      // stall. SQLite doesn't ship the SQLITE_ENABLE_UPDATE_DELETE_LIMIT
      // compile flag in bun:sqlite, so the LIMIT-via-subquery pattern is
      // the portable equivalent of `UPDATE … LIMIT 1000`.
      this.backfillCorrelationColumnsChunked(now);

      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
        .run(6, now);
    });
    runMigration();
  }

  /**
   * Chunked backfill body for `migrateV5ToV6`. Walks the `events` table
   * by rowid in 1,000-row chunks; for each chunk, runs an UPDATE that
   * lifts correlation IDs out of the row's `payload` JSON via
   * json_extract. Each non-empty chunk emits one
   * `migration.correlation_backfill_progress` event on the internal
   * `__migration__` stream so operators can observe progress on long
   * migrations.
   *
   * Why a rowid cursor rather than `WHERE correlation_id IS NULL …
   * LIMIT N` on its own: rows whose payload lacks the correlation
   * fields stay correlation_id IS NULL after the UPDATE (writing NULL
   * to a column already NULL is a "change" semantically per SQLite, but
   * the row STILL matches `correlation_id IS NULL`). A WHERE-only loop
   * would revisit the same rows forever. The cursor advances
   * monotonically over rowid, so each row is processed at most once
   * regardless of whether its final column value is NULL or a string.
   *
   * Why a rowid subquery rather than `UPDATE … LIMIT N`: SQLite needs
   * the `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` compile flag for the LIMIT
   * form and bun:sqlite doesn't ship it. The subquery is the portable
   * equivalent.
   *
   * Termination: the loop exits when SELECT-of-next-chunk returns zero
   * rowids — that means the cursor has moved past every event row. No
   * terminal "completed" event is emitted (absence of further progress
   * events is the completion signal); the durable marker is the ledger
   * stamp at `schema_version.version = 6`.
   *
   * Caller (migrateV5ToV6) already wraps this in `db.transaction(...)`;
   * the per-chunk UPDATE + per-chunk progress emission both ride the
   * outer transaction so a crash mid-migration leaves the ledger at V5
   * and re-running picks up cleanly (the cursor restarts at rowid=0,
   * but `WHERE correlation_id IS NULL` in the per-chunk filter skips
   * rows that were successfully populated in the previous attempt).
   */
  private backfillCorrelationColumnsChunked(timestamp: string): void {
    const CHUNK_SIZE = 1000;
    const MIGRATION_STREAM = '__migration__';

    // Exclude the `__migration__` stream from the backfill scan: progress
    // events are emitted INTO the events table on every iteration with
    // `correlation_id IS NULL` (they have no dispatch context). Without
    // this exclusion they re-enter the cursor in subsequent iterations,
    // each producing yet another empty-data progress event and burning
    // MAX_ITERATIONS for a phantom workload.
    const selectNextChunkRowids = this.db.prepare(
      `SELECT rowid FROM events
        WHERE rowid > ?
          AND correlation_id IS NULL
          AND streamId != '${MIGRATION_STREAM}'
        ORDER BY rowid
        LIMIT ${CHUNK_SIZE}`,
    );
    const selectSeq = this.db.prepare(
      'SELECT sequence FROM sequences WHERE streamId = ?',
    );
    const upsertSeq = this.db.prepare(
      `INSERT INTO sequences (streamId, sequence) VALUES (?, ?)
       ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence`,
    );
    // Strict INSERT (no OR IGNORE) — a silent drop would advance the
    // `sequences` counter below without persisting the corresponding
    // event, breaking the "one progress event per chunk" contract.
    // Mirrors the rationale in `emitWorkflowTypeUnknownEvents`.
    //
    // #1437 — bind shape matches the V6 9-column INSERT used by
    // `insertEvent`/`insertEventStrict`; migration progress events are
    // emitted outside any dispatch context, so the three correlation
    // columns are explicitly NULL.
    const insertEvent = this.db.prepare(
      `INSERT INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Bounded loop: at CHUNK_SIZE=1000 the worst case is total_rows/1000
    // iterations. The hard ceiling defends against a programmer-error
    // regression that breaks cursor advancement.
    const MAX_ITERATIONS = 10_000;

    let cursor = 0;
    let completed = false;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const rowids = (
        selectNextChunkRowids.all(cursor) as Array<{ rowid: number }>
      ).map((r) => r.rowid);
      if (rowids.length === 0) {
        completed = true;
        break;
      }

      // Build the IN list inline — `rowid IN (?,?,?…)` lets sqlite use
      // the rowid PK lookup directly. Per-chunk recompilation is cheap
      // for a once-per-migration call site.
      const placeholders = rowids.map(() => '?').join(',');
      // Guard each json_extract with json_valid: a single legacy or
      // hand-edited row with malformed JSON would otherwise raise
      // SQLITE_ERROR "malformed JSON" and abort the entire migration
      // transaction. With the guard, a malformed payload row simply stays
      // with NULL correlation columns (same shape as a payload that lacks
      // the fields), and the migration completes.
      const updateSql = `
        UPDATE events
           SET operation_id   = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.operationId')   ELSE NULL END,
               correlation_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.correlationId') ELSE NULL END,
               causation_id   = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.causationId')   ELSE NULL END
         WHERE rowid IN (${placeholders})
      `;
      this.db.prepare(updateSql).run(...rowids);
      // Use the chunk size (number of rowids targeted) rather than
      // `result.changes`. SQLite's `changes()` does not count rows where
      // a column update is NULL→NULL, so legacy events without correlation
      // fields would be excluded from the metric. Reporting the targeted
      // chunk size matches the operator's mental model: "rows processed in
      // this iteration", not "rows whose values actually mutated".
      const rowsBackfilled = rowids.length;

      // Advance the cursor past this chunk regardless of whether every
      // row picked up correlation data — rows whose payload lacked the
      // fields stay correlation_id IS NULL but won't be revisited.
      cursor = rowids[rowids.length - 1]!;

      // Remaining work = rows still matching the cursor's forward
      // window. Use the same WHERE shape so the count is consistent
      // with what the next iteration would process.
      // Mirror the chunk-select WHERE shape so the count reflects what the
      // next iteration would actually process — excluding the migration
      // stream avoids inflating `totalRowsRemaining` with the very rows
      // that this loop is about to insert.
      const totalRowsRemaining = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM events WHERE rowid > ? AND correlation_id IS NULL AND streamId != '${MIGRATION_STREAM}'`,
          )
          .get(cursor) as { n: number }
      ).n;

      const seqRow = selectSeq.get(MIGRATION_STREAM) as
        | { sequence: number }
        | undefined;
      const nextSeq = (seqRow?.sequence ?? 0) + 1;
      const data = { rowsBackfilled, totalRowsRemaining };
      const payload = JSON.stringify({
        streamId: MIGRATION_STREAM,
        sequence: nextSeq,
        type: 'migration.correlation_backfill_progress',
        timestamp,
        schemaVersion: '1.0',
        source: 'migration',
        data,
      });
      insertEvent.run(
        MIGRATION_STREAM,
        nextSeq,
        'migration.correlation_backfill_progress',
        timestamp,
        JSON.stringify(data),
        payload,
        null,
        null,
        null,
      );
      upsertSeq.run(MIGRATION_STREAM, nextSeq);

      if (totalRowsRemaining === 0) {
        completed = true;
        break;
      }
    }

    if (!completed) {
      // Reaching the iteration ceiling means cursor advancement is broken
      // (or there's genuinely more than 10M un-backfilled rows). Throwing
      // from inside the outer `db.transaction(...)` wrapper rolls back the
      // DDL + every partial UPDATE and prevents migrateV5ToV6 from
      // stamping schema_version = 6, forcing operator intervention. A
      // silent break here would record an incomplete schema as complete.
      throw new Error(
        `migrateV5ToV6: correlation backfill exceeded MAX_ITERATIONS=${MAX_ITERATIONS} ` +
          `(cursor=${cursor}); aborting so migrateV5ToV6 does not record schema_version=6 ` +
          'with incomplete backfill. Inspect the events table and the chunked cursor logic.',
      );
    }
  }

  /**
   * Recover `workflow_type` for legacy stream rows from two complementary
   * sources, in priority order:
   *   1. The stream's own `workflow.started` event in the events table —
   *      its `data.workflowType` is the canonical record of the type the
   *      caller passed to handleInit. Reading from the event stream means
   *      the migration succeeds regardless of state-file presence.
   *   2. The sibling `<featureId>.state.json` file under the same state
   *      dir — fallback when the events table doesn't carry the event
   *      (e.g. workflows that pre-date the event-first init path).
   *
   * Scoped to rows still bearing the `__legacy` sentinel so concurrent
   * inserts on the new-stream path (handleInit) survive untouched. After
   * both recovery paths, every row still at '__legacy' receives one
   * `migration.workflow_type_unknown` event for operator visibility
   * (task 1.6).
   *
   * NOTE: this method is the only place in the codebase allowed to issue
   * an UPDATE against `streams.workflow_type`. The CI grep gate (task 1.7)
   * skips this file alongside event-migration.ts; the gate forbids the
   * same UPDATE everywhere else.
   */
  private backfillWorkflowTypeFromStateFiles(): void {
    const updateStmt = this.db.prepare(
      `UPDATE streams SET workflow_type = ?
       WHERE streamId = ? AND workflow_type = '__legacy'`,
    );

    // Source 1: recover from each stream's workflow.started event data.
    // Using the events table is more reliable than the state file — events
    // are the substrate's source of truth, state files are a derived
    // projection that may be absent or stale.
    const startedRows = this.db
      .prepare(
        `SELECT events.streamId AS streamId, events.data AS data
         FROM events
         INNER JOIN streams ON streams.streamId = events.streamId
         WHERE events.type = 'workflow.started'
           AND streams.workflow_type = '__legacy'`,
      )
      .all() as Array<{ streamId: string; data: string | null }>;

    for (const row of startedRows) {
      if (!row.data) continue;
      let parsed: { workflowType?: unknown };
      try {
        parsed = JSON.parse(row.data) as { workflowType?: unknown };
      } catch {
        continue;
      }
      const wt = parsed.workflowType;
      if (typeof wt !== 'string' || wt.length === 0) continue;
      updateStmt.run(wt, row.streamId);
    }

    // Source 2: state-file fallback for streams the events table didn't
    // resolve. Walks <stateDir>/*.state.json and applies workflowType
    // where present. Errors are silently swallowed per-file: a
    // missing/unparseable file is non-fatal and leaves the row at
    // '__legacy' for the observability-event step below.
    const stateDir = dirname(this.dbPath);
    let entries: string[];
    try {
      entries = readdirSync(stateDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.endsWith('.state.json')) continue;
      const featureId = basename(entry, '.state.json');
      let parsed: { workflowType?: unknown };
      try {
        const raw = readFileSync(join(stateDir, entry), 'utf-8');
        parsed = JSON.parse(raw) as { workflowType?: unknown };
      } catch {
        continue;
      }
      const wt = parsed.workflowType;
      if (typeof wt !== 'string' || wt.length === 0) continue;
      updateStmt.run(wt, featureId);
    }

    this.emitWorkflowTypeUnknownEvents();
  }

  /**
   * For every stream still at the `__legacy` sentinel after the state-file
   * backfill, append one `migration.workflow_type_unknown` event to that
   * stream's event log. The event lands on the affected stream so it is
   * visible alongside the workflow's other events in a normal
   * `event.query`.
   *
   * Sequence allocation: this runs at the C/SQL layer during migration,
   * before the AtomicAppender/EventStore are wired. We allocate the next
   * sequence inline by reading the current `sequences` row (defaulting to
   * 0 for streams the migration just registered) and writing back via
   * upsert. The `events` table's PK (streamId, sequence) makes the
   * INSERT a hard error on collision — that's the right failure mode if
   * a sibling appender slipped in during the migration window (the
   * stream-version gate makes this impossible in practice; the PK is the
   * integrity backstop).
   *
   * Schema: per the registered EVENT_DATA_SCHEMAS entry for
   * `migration.workflow_type_unknown`, the data carries `streamId` only.
   * Emission source is 'auto' (registered in EVENT_EMISSION_REGISTRY).
   */
  private emitWorkflowTypeUnknownEvents(): void {
    const legacyRows = this.db
      .prepare(
        `SELECT streamId FROM streams WHERE workflow_type = '__legacy' ORDER BY streamId`,
      )
      .all() as Array<{ streamId: string }>;

    if (legacyRows.length === 0) return;

    const now = new Date().toISOString();
    // Strict INSERT (no OR IGNORE) — a silent drop would advance the
    // `sequences` counter below without persisting the corresponding
    // event, breaking the "one observability event per unresolved stream"
    // contract this migration upholds. Conflicts here are programmer
    // errors, not concurrency races, so propagate.
    //
    // #1437 deliberately preserves the 6-column INSERT shape here.
    // `emitWorkflowTypeUnknownEvents` is called from the V3 -> V4
    // migration (sqlite-backend.ts:510) which runs BEFORE
    // `migrateV5ToV6` adds the three correlation columns. A 9-column
    // bind would fail with "table events has no column named
    // operation_id" against any V<5 database being upgraded. The
    // event-store substrate's payload-vs-column source-of-truth
    // contract (INV-1) is preserved: the JSON payload remains the
    // canonical record; the three indexed columns are populated only
    // on appends that happen AFTER V6 is in place.
    const insertEvent = this.db.prepare(
      `INSERT INTO events (streamId, sequence, type, timestamp, data, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const selectSeq = this.db.prepare(
      'SELECT sequence FROM sequences WHERE streamId = ?',
    );
    const upsertSeq = this.db.prepare(
      `INSERT INTO sequences (streamId, sequence) VALUES (?, ?)
       ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence`,
    );

    // Wrap the per-stream INSERT + sequence UPSERT in a single
    // transaction (Sentry #14058246). Without it, a process crash
    // between an INSERT and the matching UPSERT would persist the
    // event without advancing the sequence counter. The next startup
    // would re-run the migration (the schema version stays at v3) and
    // re-INSERT the same (streamId, sequence) pair, which the strict
    // INSERT correctly rejects as a PK violation — but that error
    // would now abort startup instead of allowing the migration to
    // resume cleanly. With the transaction, either both rows commit
    // or neither does, and the per-stream loop is safe to retry.
    const emitAll = this.db.transaction((rows: ReadonlyArray<{ streamId: string }>): void => {
      for (const { streamId } of rows) {
        const seqRow = selectSeq.get(streamId) as { sequence: number } | undefined;
        const nextSeq = (seqRow?.sequence ?? 0) + 1;
        const data = JSON.stringify({ streamId });
        const payload = JSON.stringify({
          streamId,
          sequence: nextSeq,
          type: 'migration.workflow_type_unknown',
          timestamp: now,
          schemaVersion: '1.0',
          source: 'migration',
          data: { streamId },
        });
        insertEvent.run(
          streamId,
          nextSeq,
          'migration.workflow_type_unknown',
          now,
          data,
          payload,
        );
        upsertSeq.run(streamId, nextSeq);
      }
    });
    emitAll(legacyRows);
  }

  private prepareStatements(): Statements {
    return {
      insertEvent: this.db.prepare(
        'INSERT OR IGNORE INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        'INSERT INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
    };
  }

  // ─── Event Operations ───────────────────────────────────────────────────

  appendEvent(streamId: string, event: WorkflowEvent): void {
    const data = event.data ? JSON.stringify(event.data) : null;
    const payload = JSON.stringify(event);

    const insertFn = this.db.transaction(() => {
      // #1437 — bind the V6 indexed correlation columns alongside the
      // existing six. The values come straight off the event's stamped
      // fields; payload remains source of truth per INV-1 while these
      // columns serve as the indexed filter handle for telemetry views.
      // `?? null` covers pre-dispatch-context callers (tests, migration
      // events) so the bind shape stays uniform.
      this.stmts.insertEvent.run(
        streamId,
        event.sequence,
        event.type,
        event.timestamp,
        data,
        payload,
        event.operationId ?? null,
        event.correlationId ?? null,
        event.causationId ?? null,
      );
      this.stmts.upsertSequence.run(streamId, event.sequence);
    });

    insertFn();
  }

  /**
   * Shared WHERE builder for the per-stream event queries (DR-11, #1685).
   * Used by BOTH {@link queryEvents} and {@link countEvents} so the row
   * query and the COUNT can never disagree about which events match — the
   * invariant `queryPage`'s `total`/`hasMore` metadata rests on. Handles the
   * window filters only; ORDER BY and LIMIT/OFFSET are appended by
   * `queryEvents`, and `countEvents` ignores them by construction.
   *
   * Returns `null` when the filter can match nothing (`types: []`) so
   * callers short-circuit without issuing SQL — SQLite has no valid empty
   * `IN ()` list, and the in-memory backend mirrors the same "empty matches
   * nothing" semantics (INV-2).
   */
  private buildEventWhere(
    streamId: string,
    filters?: QueryFilters,
  ): { conditions: string[]; params: unknown[] } | null {
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

    // DR-11 multi-type filter (#1685 — the DR-12 enabler): `type IN (...)`
    // against the (streamId, type) index. Composes with `type` as AND when
    // both are supplied. Placeholder count varies with the list length, so
    // the SQL-string statement cache naturally keys distinct arities.
    if (filters?.types !== undefined) {
      if (filters.types.length === 0) return null;
      conditions.push(`type IN (${filters.types.map(() => '?').join(', ')})`);
      params.push(...filters.types);
    }

    if (filters?.since) {
      conditions.push('timestamp >= ?');
      params.push(filters.since);
    }

    if (filters?.until) {
      conditions.push('timestamp <= ?');
      params.push(filters.until);
    }

    // #1437 (Wave 4) — indexed-WHERE fast path for the V6 correlation
    // columns. The column is the filter handle (INV-1); the canonical
    // value still travels with `payload` JSON and is rehydrated by
    // `rowToEvent` on read. The dynamic SQL+cache pattern uses the
    // SQL string as the cache key, so adding/omitting these clauses
    // produces distinct cache entries automatically — no manual cache
    // bookkeeping required.
    if (filters?.operationId !== undefined) {
      conditions.push('operation_id = ?');
      params.push(filters.operationId);
    }
    if (filters?.correlationId !== undefined) {
      conditions.push('correlation_id = ?');
      params.push(filters.correlationId);
    }
    if (filters?.causationId !== undefined) {
      conditions.push('causation_id = ?');
      params.push(filters.causationId);
    }

    return { conditions, params };
  }

  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[] {
    // #1448 item 5 — bump the correlationFilteredQueries counter once per
    // query (not once per clause) so silent index regressions surface via
    // `getStats()` rather than via user-visible latency.
    if (
      filters?.operationId !== undefined ||
      filters?.correlationId !== undefined ||
      filters?.causationId !== undefined
    ) {
      this.correlationFilteredQueries++;
    }

    const where = this.buildEventWhere(streamId, filters);
    if (where === null) return [];
    const { conditions, params } = where;

    // DR-11 (#1685): `order: 'desc'` flips to newest-first so LIMIT/OFFSET
    // carve the newest window directly in SQL. Ascending keeps the bare
    // `ORDER BY sequence` string so pre-existing cached statements match.
    const direction = filters?.order === 'desc' ? ' DESC' : '';
    let sql = `SELECT streamId, sequence, type, timestamp, data, payload FROM events WHERE ${conditions.join(' AND ')} ORDER BY sequence${direction}`;

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

  /**
   * Filtered event count (DR-11, #1685). `SELECT COUNT(*)` over the SAME
   * WHERE clause {@link queryEvents} builds ({@link buildEventWhere}), so the
   * count and the row query can never disagree about which events match. No
   * rows are materialized — SQLite folds the count over the (streamId,
   * type)/(streamId, timestamp) indexes. Pagination fields (`limit`/`offset`)
   * and `order` in `filters` are ignored by construction: only window
   * filters reach the WHERE.
   */
  countEvents(streamId: string, filters?: QueryFilters): number {
    const where = this.buildEventWhere(streamId, filters);
    if (where === null) return 0;

    const sql = `SELECT COUNT(*) AS n FROM events WHERE ${where.conditions.join(' AND ')}`;
    let stmt = this.queryStmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.queryStmtCache.set(sql, stmt);
    }

    const row = stmt.get(...where.params) as { n: number };
    return row.n;
  }

  getSequence(streamId: string): number {
    const row = this.stmts.selectSequence.get(streamId) as { sequence: number } | undefined;
    return row ? row.sequence : 0;
  }

  /**
   * Tier-2 poll-floor change token (see {@link StorageBackend.dataVersion}).
   *
   * `PRAGMA data_version` is unchanged for commits made on THIS connection
   * and differs only when another connection (a foreign process) committed
   * since the pragma last ran. That is precisely the cross-process wake
   * signal the subscription floor loop needs — the Tier-1 in-process hook
   * already covers this connection's own commits, so the floor must fire
   * only on foreign ones. The absolute value is connection-specific and
   * meaningless; the caller compares successive reads for a change.
   *
   * Deliberately NOT a retained prepared statement: the floor loop must
   * "hold no open SQLite statement across ticks" so it never pins a read
   * snapshot that would hide the very foreign commit it is polling for. An
   * inline `query(...).get()` fully reads and finalizes the pragma each call.
   *
   * bun:sqlite keys the single pragma column by `data_version`; the
   * better-sqlite3 test shim does the same. A defensive fallback tolerates
   * an unnamed column just in case.
   */
  dataVersion(): number {
    const row = this.db.query('PRAGMA data_version').get() as
      | Record<string, number | string>
      | undefined;
    if (!row) return 0;
    const raw = row.data_version ?? row[''];
    const value = typeof raw === 'number' ? raw : Number(raw ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  listStreams(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT streamId FROM sequences ORDER BY streamId')
      .all() as Array<{ streamId: string }>;
    return rows.map((row) => row.streamId);
  }

  /**
   * Backend observability counters. Currently exposes
   * `correlationFilteredQueries` — the number of {@link queryEvents} /
   * {@link queryEventsByType} invocations that supplied at least one of the
   * three correlation filter fields and therefore exercised the V6 indexed
   * fast path. Counted once per query, regardless of how many of the three
   * filter fields were supplied.
   *
   * Shape mirrors `ViewMaterializer.getStats()` (a plain numeric counter
   * object) so callers can compose per-subsystem stat snapshots without a
   * shared metrics interface.
   */
  getStats(): { correlationFilteredQueries: number; workflowTypePushdownQueries: number } {
    return {
      correlationFilteredQueries: this.correlationFilteredQueries,
      workflowTypePushdownQueries: this.workflowTypePushdownQueries,
    };
  }

  /**
   * Cross-stream query reducer (DR-3). Reduces over the events table for a
   * single event type whose streamId is `streamPrefix` (parent stream) OR a
   * namespaced descendant `<streamPrefix>/<segment>`. SQL clause matches the
   * design verbatim:
   *
   *   WHERE type = ? AND (streamId LIKE ? || '/%' OR streamId = ?)
   *
   * Substring lookalikes (`<streamPrefix>-extra`) are excluded structurally
   * because the LIKE pattern requires a literal `/` between prefix and
   * descendant. The trailing optional filters (sinceSequence, since, until,
   * limit, offset) parallel `queryEvents` so the cross-stream caller has the
   * same shape available.
   */
  queryEventsByType(
    eventType: string,
    streamPrefix: string,
    filters?: QueryFilters,
  ): WorkflowEvent[] {
    const conditions: string[] = ['type = ?', "(streamId LIKE ? || '/%' OR streamId = ?)"];
    const params: unknown[] = [eventType, streamPrefix, streamPrefix];

    if (filters?.sinceSequence !== undefined) {
      conditions.push('sequence > ?');
      params.push(filters.sinceSequence);
    }
    if (filters?.since) {
      conditions.push('timestamp >= ?');
      params.push(filters.since);
    }
    if (filters?.until) {
      conditions.push('timestamp <= ?');
      params.push(filters.until);
    }
    // Correlation tuple filters (parity with queryEvents). Honoured as indexed
    // WHERE clauses against the V6 columns; the (correlation_id, sequence)
    // index makes the common cross-stream telemetry lookup ("all events in
    // workflow X of type Y") O(log n + matches).
    //
    // #1448 item 5 — same once-per-query counter as queryEvents.
    if (
      filters?.operationId !== undefined ||
      filters?.correlationId !== undefined ||
      filters?.causationId !== undefined
    ) {
      this.correlationFilteredQueries++;
    }
    if (filters?.operationId !== undefined) {
      conditions.push('operation_id = ?');
      params.push(filters.operationId);
    }
    if (filters?.correlationId !== undefined) {
      conditions.push('correlation_id = ?');
      params.push(filters.correlationId);
    }
    if (filters?.causationId !== undefined) {
      conditions.push('causation_id = ?');
      params.push(filters.causationId);
    }

    let sql = `SELECT streamId, sequence, type, timestamp, data, payload FROM events WHERE ${conditions.join(' AND ')} ORDER BY timestamp, streamId, sequence`;

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
   * Stream-version gate (allocate + OCC) — runs INSIDE the caller's
   * `BEGIN IMMEDIATE` transaction. Reads the durable tail, optionally
   * checks it against `expected`, and advances it by `n` in one step,
   * returning the `base` from which the caller assigns the N event
   * sequences (`base + 1 .. base + n`).
   *
   * Correctness rests on the write lock: `atomicAppend` opens the txn with
   * `BEGIN IMMEDIATE`, so by the time this runs the connection holds the
   * single SQLite write lock. No other connection can commit until we do,
   * which makes the read-then-advance race-free WITHOUT a TOCTOU window —
   * the convergent event-store primitive (assign-and-check the version
   * atomically in the write txn) in its SQLite-native form. The previous
   * design read the high-water mark OUTSIDE the txn and leaned on the
   * `events` PRIMARY KEY to reject the stale insert after the fact; the
   * gate eliminates that race instead of catching it.
   *
   * On OCC mismatch throws {@link SequenceGateConflictError} so the whole
   * append (gate bump + events + claim) rolls back as a unit; the error
   * carries the real `expected`/`actual` directly.
   */
  private allocateSequence(
    streamId: string,
    n: number,
    expected?: number,
  ): number {
    // Race-free under the held write lock (BEGIN IMMEDIATE). 0 when the
    // stream has no `sequences` row yet (empty stream; sequences start at 1).
    const current = this.readSequenceHighWaterMark(streamId);
    if (expected !== undefined && current !== expected) {
      throw new SequenceGateConflictError(expected, current);
    }
    // The gate IS the sequence update — upsert the advanced tail. No
    // separate post-insert `upsertSequence` is needed (or correct): a
    // second write would double-count.
    this.stmts.upsertSequence.run(streamId, current + n);
    return current;
  }

  /**
   * Atomic append: a single `BEGIN IMMEDIATE` transaction wrapping the
   * stream-version gate (allocate + OCC), the idempotency-key claim, and
   * the event INSERTs. Commits as a unit; rolls back on any error.
   *
   * The caller passes `n` (event count), an optional `expectedSequence`
   * (OCC), and a pure `finalize(base)` callback that builds the wire events
   * (with `sequence = base + i + 1`) and the optional claim from the
   * gate-assigned base. `finalize` runs INSIDE the txn so the persisted
   * rows and the claim's `events_json` derive from the authoritative
   * numbers; it must be cheap and side-effect-free (UUID/timestamp/JSON
   * only — no I/O) so the write lock is held for microseconds.
   *
   * Throws on:
   *   - {@link SequenceGateConflictError} (OCC mismatch — `expected`/`actual`)
   *   - SQLITE_CONSTRAINT on `idempotency_claims` (double-claim race)
   *   - SQLITE_CONSTRAINT on `events` (genuine integrity anomaly — must not
   *     happen under the gate; the caller surfaces it as `io-error`)
   *   - Any underlying SQLite error (BUSY, IO, etc.)
   *
   * `bun:sqlite`'s `db.transaction(fn)` wrapper opens a `BEGIN` (deferred)
   * by default; we invoke the `'immediate'` variant so the write lock is
   * acquired up-front — the precondition the gate relies on.
   */
  async atomicAppend(args: {
    streamId: string;
    idempotencyKey: string | null;
    n: number;
    expectedSequence?: number;
    finalize: (base: number) => {
      events: AtomicAppendEvent[];
      claim?: {
        eventIds: string[];
        sequences: number[];
        timestamps: string[];
        events_json: string;
      };
    };
  }): Promise<{ base: number; sequences: number[] }> {
    if (args.n <= 0) {
      throw new Error('atomicAppend requires n >= 1');
    }

    let assignedBase = 0;
    let assignedSequences: number[] = [];

    const txn = this.db.transaction(() => {
      // ─── Stream-version gate: allocate + OCC, inside the write lock ───
      const base = this.allocateSequence(
        args.streamId,
        args.n,
        args.expectedSequence,
      );
      // Build the authoritative rows + claim from the gate-assigned base.
      const { events, claim } = args.finalize(base);

      // Idempotency claim (single row per (streamId, key)) — strict INSERT
      // so a double-claim race aborts the txn; ROLLBACK is automatic via
      // the wrapper, undoing the gate bump and any inserted events.
      if (args.idempotencyKey !== null && claim) {
        this.stmts.insertIdempotencyClaim.run(
          args.streamId,
          args.idempotencyKey,
          JSON.stringify(claim.eventIds),
          JSON.stringify(claim.sequences),
          JSON.stringify(claim.timestamps),
          claim.events_json,
          new Date().toISOString(),
        );
      }

      // Event INSERTs — strict so a (streamId, sequence) collision raises.
      // Under the gate such a collision is a genuine integrity anomaly
      // (the gate guarantees a free slot), surfaced as `io-error` by the
      // caller rather than re-mapped to a conflict. #1437 — bind the V6
      // indexed correlation columns; `?? null` covers pre-dispatch-context
      // callers (raw fixtures, migration paths).
      const seqs: number[] = [];
      for (const evt of events) {
        const data = evt.data !== undefined ? JSON.stringify(evt.data) : null;
        this.stmts.insertEventStrict.run(
          args.streamId,
          evt.sequence,
          evt.type,
          evt.timestamp,
          data,
          evt.payload,
          evt.operationId ?? null,
          evt.correlationId ?? null,
          evt.causationId ?? null,
        );
        seqs.push(evt.sequence);
      }

      assignedBase = base;
      assignedSequences = seqs;
    });

    // `bun:sqlite` exposes `transaction(fn).immediate(args)` to open
    // BEGIN IMMEDIATE explicitly. The shimmed `better-sqlite3` driver
    // supports the same shape (the shim wraps better-sqlite3 1:1 — see
    // src/storage/__shims__/bun-sqlite-node.ts). `initialize()` asserts
    // `.immediate` exists (DR-3), so there is NO deferred fallback here: a
    // deferred BEGIN would reopen the lock-upgrade deadlock and the TOCTOU
    // window the gate closes.
    const txnUnknown = txn as unknown as {
      immediate: (...args: unknown[]) => void;
    };
    const runOnce = (): void => {
      txnUnknown.immediate();
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
        return { base: assignedBase, sequences: assignedSequences };
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

  // ─── Stream Registry (Marten R-1, #1313) ────────────────────────────────

  /**
   * Insert a row into the typed-stream registry. Idempotent via
   * INSERT OR IGNORE — re-calling for an already-registered stream is a
   * no-op so the registry row's `workflow_type` cannot be overwritten by
   * a subsequent init call. (The column is immutable post-insert; task 1.7
   * adds a CI grep gate forbidding `UPDATE streams SET workflow_type`.)
   *
   * Called by `handleInit` (workflow/tools.ts) once per stream creation.
   * The migration's V3 → V4 backfill leaves a `__legacy` sentinel for
   * pre-existing streams; this method writes the explicit value passed by
   * the caller on the new-stream path.
   */
  registerStream(streamId: string, workflowType: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO streams (streamId, workflow_type, createdAt)
         VALUES (?, ?, ?)`,
      )
      .run(streamId, workflowType, new Date().toISOString());
  }

  // ─── Projection Snapshot Accessors (Wave A, #1343) ──────────────────────

  /**
   * Return the snapshot record with the highest sequence for the given
   * (streamId, projectionId, projectionVersion) coordinate, or `undefined`
   * when no row exists.
   *
   * Uses the `idx_projection_snapshots_latest` index
   * (stream_id, projection_id, projection_version, sequence DESC) so the
   * LIMIT 1 fast path never triggers a full table scan.
   */
  readLatestProjectionSnapshot(
    streamId: string,
    projectionId: string,
    projectionVersion: string,
  ): SnapshotRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT payload FROM projection_snapshots
         WHERE stream_id = ? AND projection_id = ? AND projection_version = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(streamId, projectionId, projectionVersion) as { payload: string } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.payload) as SnapshotRecord;
  }

  /**
   * Append a snapshot record for the given stream. When the total row count
   * for the (streamId, projectionId, projectionVersion) coordinate exceeds
   * `opts.maxRecords` (defaulting to `resolveMaxRecords()`), the oldest rows
   * by sequence are deleted so exactly `maxRecords` rows remain.
   *
   * DELETE uses a subquery that selects the N oldest `rowid`s, where N is the
   * excess count. This is a single SQL round-trip and avoids a separate
   * SELECT + loop.
   */
  appendProjectionSnapshot(
    streamId: string,
    record: SnapshotRecord,
    opts?: {
      maxRecords?: number;
      onPrune?: (prunedCount: number) => void;
    },
  ): void {
    const payload = JSON.stringify(record);
    const createdAt = new Date().toISOString();

    const max =
      opts?.maxRecords !== undefined && Number.isInteger(opts.maxRecords) && opts.maxRecords > 0
        ? opts.maxRecords
        : resolveMaxRecords();

    let prunedCount = 0;

    const txn = this.db.transaction(() => {
      // INSERT OR IGNORE — snapshot writes are idempotent by definition:
      // the SnapshotRecord at sequence N for a given projection version is
      // a deterministic fold of the same events, so a retry of an
      // already-committed write at the same coordinate is a no-op rather
      // than an error. The PRIMARY KEY (stream_id, projection_id,
      // projection_version, sequence) handles dedup; OR IGNORE preserves
      // the original row over any post-hoc re-write.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO projection_snapshots
             (stream_id, projection_id, projection_version, sequence, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          streamId,
          record.projectionId,
          record.projectionVersion,
          record.sequence,
          payload,
          createdAt,
        );

      // Count the total rows for this coordinate.
      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM projection_snapshots
           WHERE stream_id = ? AND projection_id = ? AND projection_version = ?`,
        )
        .get(streamId, record.projectionId, record.projectionVersion) as { cnt: number };

      const excess = countRow.cnt - max;
      if (excess > 0) {
        // Delete the `excess` oldest rows (lowest sequence) for this coordinate.
        this.db
          .prepare(
            `DELETE FROM projection_snapshots
             WHERE rowid IN (
               SELECT rowid FROM projection_snapshots
               WHERE stream_id = ? AND projection_id = ? AND projection_version = ?
               ORDER BY sequence ASC
               LIMIT ?
             )`,
          )
          .run(streamId, record.projectionId, record.projectionVersion, excess);
        prunedCount = excess;
      }
    });

    txn();

    if (prunedCount > 0) {
      opts?.onPrune?.(prunedCount);
    }
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

  /**
   * Cross-workflow summary read (DR-3). Real pushdown: the `workflow_type`
   * predicate is compiled into the SQL WHERE against the
   * `idx_streams_workflow_type` index — the INNER JOIN of `workflow_state ×
   * streams` keys the type filter to the indexed registry column rather than
   * scanning every row's state JSON.
   *
   * Per-row fields:
   *  - `workflowType` from `streams.workflow_type` (the indexed, authoritative
   *    registry value; equal to the state's own `workflowType` because
   *    `registerStream` is written with the same value on the init path).
   *  - `phase` from `json_extract(state, '$.phase')` on the persisted blob.
   *  - `status` derived from `phase` via the shared {@link deriveWorkflowStatus}.
   *  - `createdAt` from `MIN(events.timestamp)` per stream — the earliest
   *    event envelope, i.e. the workflow's creation instant (indexed via
   *    `idx_events_time (streamId, timestamp)`).
   *
   * The lifecycle axes (`status`/`phase`/`includeTerminal`) are applied by the
   * shared {@link matchesWorkflowSummaryFilter} so this path and the in-memory
   * path stay row-for-row equivalent. `workflowType` is intentionally NOT
   * re-checked in JS — the SQL WHERE owns it, keeping the pushdown load-bearing.
   */
  listWorkflowSummaries(filter: WorkflowSummaryFilter = {}): WorkflowSummary[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.workflowType !== undefined) {
      // Pushdown on the SAME coalesced expression the SELECT projects — NOT on
      // the bare `s.workflow_type`, which would be NULL for a registry-less row
      // and re-drop exactly the rows the LEFT JOIN below exists to keep.
      conditions.push(`${WORKFLOW_TYPE_EXPR} = ?`);
      params.push(filter.workflowType);
      this.workflowTypePushdownQueries++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // LEFT JOIN, not INNER: `registerStream()` is attempted on init but its
    // write errors are swallowed, so a `workflow_state` row can outlive a
    // missing `streams` row. An INNER JOIN silently OMITS those workflows,
    // which diverges from the in-memory backend (it reads workflowType off the
    // state object and never consults a registry) — an INV-2 facade-equivalence
    // break that makes the same workflow visible via one backend and invisible
    // via the other. Fall back to the state row's own workflowType.
    const sql = `
      SELECT ws.featureId AS featureId,
             ${WORKFLOW_TYPE_EXPR} AS workflowType,
             json_extract(ws.state, '$.phase') AS phase,
             (SELECT MIN(e.timestamp) FROM events e WHERE e.streamId = ws.featureId) AS createdAt
        FROM workflow_state ws
        LEFT JOIN streams s ON s.streamId = ws.featureId
        ${where}
        ORDER BY ws.featureId ASC`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      featureId: string;
      workflowType: string;
      phase: string | null;
      createdAt: string | null;
    }>;

    const summaries: WorkflowSummary[] = rows.map((row) => {
      const phase = row.phase ?? '';
      return {
        featureId: row.featureId,
        workflowType: row.workflowType,
        phase,
        status: deriveWorkflowStatus(phase),
        createdAt: row.createdAt ?? null,
      };
    });

    // Apply the lifecycle axes only — workflow_type is already SQL-filtered.
    const lifecycleFilter: WorkflowSummaryFilter = { ...filter, workflowType: undefined };
    return summaries.filter((summary) => matchesWorkflowSummaryFilter(summary, lifecycleFilter));
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
      // Purge the rest of the per-stream tables in the same transaction.
      // Earlier revisions left these populated; a delete/recreate of the
      // same streamId would then observe stale idempotency claims (replay
      // mis-detected as duplicate), stale projection snapshots (hydrate
      // wrong state), stale outbox rows (re-emit old side-effect intents),
      // and stale view cache (read-back surfaces deleted history).
      // (CodeRabbit review #4278133032 on PR #1344.)
      this.db.prepare('DELETE FROM idempotency_claims WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM outbox WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM view_cache WHERE streamId = ?').run(streamId);
      // projection_snapshots uses snake_case column names (matches the
      // V4→V5 migration spec); the row PK is composite over
      // (stream_id, projection_id, projection_version, sequence).
      this.db.prepare('DELETE FROM projection_snapshots WHERE stream_id = ?').run(streamId);
      // Drop the `streams` registry row too. `registerStream` is
      // `INSERT OR IGNORE`, so a delete/recreate cycle that left the
      // registry row alive would permanently pin the old `workflow_type`
      // — the recreate would observe the immutable row and silently
      // adopt the prior type instead of the newly-supplied one.
      this.db.prepare('DELETE FROM streams WHERE streamId = ?').run(streamId);
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
