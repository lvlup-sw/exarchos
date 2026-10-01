/**
 * SqliteBackend: the SQLite implementation of `StorageBackend`.
 *
 * This file holds the storage behavior only. The wire types, the DDL, the
 * error family, and the driver predicates live beside it under `sqlite/`. This
 * module re-exports them, so the `./sqlite-backend.js` import path still works.
 */
import { Database, type Statement } from 'bun:sqlite';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, basename, resolve, relative, isAbsolute } from 'node:path';
import type { WorkflowEvent } from '../events/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../events/store.js';
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
import { storeLogger } from '../logger.js';

import type {
  AtomicAppendEvent,
  PublicPersistedEventLike,
  AtomicDecideOnceDecision,
  AtomicDecideOnceOutcome,
} from './sqlite/wire-types.js';
import { SCHEMA_VERSION, SCHEMA_DDL } from './sqlite/schema.js';
import type { Statements } from './sqlite/statements.js';
import {
  MAX_OUTBOX_RETRIES,
  WORKFLOW_TYPE_EXPR,
  SQLITE_BUSY_RETRY_POLICY,
  DECIDE_ONCE_CLAIM_STREAM,
} from './sqlite/constants.js';
import {
  SqliteBusyExhaustedError,
  SequenceGateConflictError,
  OperationDigestConflictError,
  SqliteImmediateUnsupportedError,
  SqliteCorruptError,
  SchemaVersionTooNewError,
} from './sqlite/errors.js';
import type { SequenceRepair, SequenceRepairReport } from './sqlite/repair-types.js';
import { SEQUENCE_REPAIR_LOG_CAP } from './sqlite/repair-types.js';
import {
  hasImmediateTransaction,
  isSqliteBusy,
  isSqliteCorrupt,
  sleep,
} from './sqlite/driver-predicates.js';

export type {
  AtomicAppendEvent,
  PublicPersistedEventLike,
  AtomicDecideOnceDecision,
  AtomicDecideOnceOutcome,
  SequenceRepair,
  SequenceRepairReport,
};
export {
  SCHEMA_VERSION,
  SqliteBusyExhaustedError,
  SequenceGateConflictError,
  OperationDigestConflictError,
  SqliteImmediateUnsupportedError,
  SqliteCorruptError,
  SchemaVersionTooNewError,
};

/**
 * Tells whether a prepared statement has a `finalize()` method. A bun:sqlite
 * statement has it, and a better-sqlite3 statement does not, so the shared
 * `Statement` type cannot describe both.
 */
function hasFinalize(value: unknown): value is { finalize: () => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'finalize' in value &&
    typeof value.finalize === 'function'
  );
}

/**
 * Returns the path in the form that the filesystem uses, to compare two paths
 * that can name one file differently.
 *
 * `resolve()` keeps aliases, such as an 8.3 short name and its long form, or a
 * symlink and its target. `closeOpenUnder` tests containment by prefix, so an
 * alias makes a contained handle look outside. That handle stays open, and
 * NTFS then refuses the unlink with `EBUSY`. For an absent file, the function
 * resolves the parent, because the alias is there. It never throws.
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return join(realpathSync.native(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

/** The SQLite implementation of `StorageBackend`, on bun:sqlite in WAL mode. */
export class SqliteBackend implements StorageBackend {
  private db!: Database;
  private stmts!: Statements;
  private outboxIdCounter = 0;

  /**
   * Whether {@link close} succeeded. A second `db.close()` throws on the
   * driver, so this flag makes `close()` idempotent.
   */
  private closed = false;

  /**
   * The backends with an open handle. A backend adds itself in
   * {@link initialize} and removes itself in {@link close}.
   * {@link closeOpenUnder} uses it to close a handle that a test never named,
   * because NTFS cannot delete a file with an open handle.
   */
  private static readonly openInstances = new Set<SqliteBackend>();

  /**
   * Closes every open backend whose database file is under `dir`. The `rmrf()`
   * test helper calls it before it removes a temp dir.
   */
  static closeOpenUnder(dir: string): void {
    const root = canonicalPath(dir);
    for (const backend of [...SqliteBackend.openInstances]) {
      const rel = relative(root, canonicalPath(backend.dbPath));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        backend.close();
      }
    }
  }

  /** The number of open backends, for leak checks. */
  static openHandleCount(): number {
    return SqliteBackend.openInstances.size;
  }

  /** The prepared statements of `queryEvents` and `queryEventsByType`, keyed by SQL text. */
  private queryStmtCache: Map<string, Statement> = new Map();

  /**
   * Counts the queries that filter on `operation_id`, `correlation_id`, or
   * `causation_id`, once for each query. A lost index still returns correct
   * rows through a full scan, so {@link getStats} exposes this counter to make
   * that regression visible.
   */
  private correlationFilteredQueries = 0;

  /**
   * Counts the {@link listWorkflowSummaries} calls that put the
   * `workflow_type` filter in the SQL WHERE and not in a JavaScript scan.
   * {@link getStats} exposes it, because both paths return the same rows.
   */
  private workflowTypePushdownQueries = 0;

  /**
   * The clock for outbox retry times. Tests inject it to skip the backoff
   * waits. Defaults to the wall clock.
   */
  private readonly clock: () => Date;

  /**
   * The `PRAGMA synchronous` value. `'normal'`, the default, survives a
   * process crash, but an OS crash or a power loss can lose the last commits.
   * The crash-recovery design accepts that tail loss. `'full'` syncs each
   * commit to disk and survives a power loss, with lower throughput.
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

  /**
   * Opens and prepares the database. The backend registers itself right after
   * the open, so a failed init still leaves a handle that {@link close} can
   * release. The correlation indexes come after `migrateSchema()`, because a
   * legacy `events` table gets those columns only from the migration.
   *
   * If the file is corrupt, init closes the handle and throws
   * {@link SqliteCorruptError}. Init never rebuilds the file, because a rebuild
   * destroys the evidence of the fault.
   */
  initialize(): void {
    this.assertOpen();
    try {
      this.db = new Database(this.dbPath);
      SqliteBackend.openInstances.add(this);
      this.applyConnectionPragmas();
      this.assertImmediateSupported();
      this.db.exec(SCHEMA_DDL);
      this.assertSchemaNotNewerThanBinary();
      this.migrateSchema();

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id);
        CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id);
      `);

      const existing = this.db
        .prepare('SELECT version FROM schema_version WHERE version = ?')
        .get(SCHEMA_VERSION) as { version: number } | undefined;

      if (!existing) {
        this.db
          .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
          .run(SCHEMA_VERSION, new Date().toISOString());
      }

      this.stmts = this.prepareStatements();

      this.repairSequenceHighWaterMarks();
    } catch (err) {
      if (isSqliteCorrupt(err)) {
        this.close();
        throw new SqliteCorruptError(
          this.dbPath,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      throw err;
    }
  }

  /** Refuse to open a handle on a backend whose {@link close} has run (#2026). */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`SqliteBackend for ${this.dbPath} is closed; it does not open the file again`);
    }
  }

  /**
   * Finalizes every prepared statement and then closes the connection,
   * because bun:sqlite can refuse to close with live statements. The method
   * ignores a finalize error. `stmts` and `db` can be undefined after a
   * partial init.
   *
   * If `db.close()` fails, the OS handle stays open. The backend then stays
   * registered, so a later {@link closeOpenUnder} sweep tries again.
   */
  close(): void {
    if (this.closed) return;
    const prepared = this.stmts === undefined ? [] : Object.values(this.stmts);
    for (const statement of [...prepared, ...this.queryStmtCache.values()]) {
      if (hasFinalize(statement)) {
        try {
          statement.finalize();
        } catch {
        }
      }
    }
    this.queryStmtCache.clear();
    try {
      this.db?.close();
    } catch {
      return;
    }
    this.closed = true;
    SqliteBackend.openInstances.delete(this);
  }

  /**
   * Throws {@link SqliteImmediateUnsupportedError} when the driver has no
   * `transaction(fn).immediate()`. The sequence gate needs `BEGIN IMMEDIATE`,
   * and a deferred `BEGIN` is not a safe fallback.
   */
  private assertImmediateSupported(): void {
    if (!hasImmediateTransaction(this.db.transaction(() => {}))) {
      throw new SqliteImmediateUnsupportedError();
    }
  }

  /**
   * Refuses a store whose schema version is newer than this binary. It runs
   * after `SCHEMA_DDL` creates `schema_version` and before `migrateSchema()`.
   * A fresh or older store passes, and an older store then migrates forward.
   * For a newer store, it closes the handle, so the file stays free for
   * repair, and throws {@link SchemaVersionTooNewError}.
   */
  private assertSchemaNotNewerThanBinary(): void {
    const row = this.db
      .prepare('SELECT MAX(version) AS version FROM schema_version')
      .get() as { version: number | null } | undefined;
    const storeVersion = row?.version ?? null;
    if (storeVersion !== null && storeVersion > SCHEMA_VERSION) {
      this.close();
      throw new SchemaVersionTooNewError(this.dbPath, storeVersion, SCHEMA_VERSION);
    }
  }

  /**
   * Sets busy_timeout, WAL, synchronous, and mmap_size, in that order.
   * `busy_timeout` comes first, because without a busy handler the WAL switch
   * fails at once with SQLITE_BUSY against a concurrent opener.
   *
   * BUSY recovery has two tiers. The 5-second `busy_timeout` absorbs short
   * contention in C. `SQLITE_BUSY_RETRY_POLICY` then retries in JavaScript,
   * where each retry is visible. Without the timeout, noise exhausts the
   * retries. Without the retries, a 5-second stall looks like a healthy write.
   */
  private applyConnectionPragmas(): void {
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(
      `PRAGMA synchronous = ${this.synchronous === 'full' ? 'FULL' : 'NORMAL'}`,
    );
    this.db.exec('PRAGMA mmap_size = 268435456');
  }

  /**
   * Runs the schema migrations for an existing database. Each step after V2
   * runs only when `schema_version` lacks its target version, so a second run
   * does nothing. The V1 to V2 step checks for the `payload` column instead,
   * because it is older than that ledger. Each step helper states its change.
   */
  private migrateSchema(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;

    const hasPayload = columns.some((col) => col.name === 'payload');

    if (!hasPayload) {
      this.db.exec('ALTER TABLE events ADD COLUMN payload TEXT');
    }

    const v3Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(3) as { version: number } | undefined;

    if (!v3Existing) {
      this.migrateV2ToV3();
    }

    const v4Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(4) as { version: number } | undefined;

    if (!v4Existing) {
      this.migrateV3ToV4();
    }

    const v5Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(5) as { version: number } | undefined;

    if (!v5Existing) {
      this.migrateV4ToV5();
    }

    const v6Existing = this.db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(6) as { version: number } | undefined;

    if (!v6Existing) {
      this.migrateV5ToV6();
    }
  }

  /**
   * V2 to V3: no schema change. The step only stamps version 3, because each
   * step stamps its own target version. Without the stamp, `migrateSchema`
   * runs this step again on every open.
   */
  private migrateV2ToV3(): void {
    this.db
      .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
      .run(3, new Date().toISOString());
  }

  /**
   * V3 to V4: creates the `streams` registry, adds a `__legacy` row for each
   * stream in `sequences`, and recovers the real types where it can. The
   * `status` column is reserved and not written yet.
   *
   * The whole step and its version stamp run in one transaction. Without it, a
   * crash before the stamp makes the next start duplicate the
   * `migration.workflow_type_unknown` events. The nested transaction in
   * `emitWorkflowTypeUnknownEvents` becomes a SAVEPOINT.
   */
  private migrateV3ToV4(): void {
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

      this.db
        .prepare(
          `INSERT OR IGNORE INTO streams (streamId, workflow_type, createdAt)
           SELECT streamId, '__legacy', ? FROM sequences`,
        )
        .run(now);

      this.backfillWorkflowTypeFromStateFiles();

      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
        .run(4, now);
    });
    runMigration();
  }

  /**
   * V4 to V5: creates `projection_snapshots` and its latest-row index for a
   * database stamped at V4. `SCHEMA_DDL` creates them on a fresh database, and
   * `IF NOT EXISTS` makes the step idempotent. The step does not backfill the
   * old JSONL sidecar files.
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
   * V5 to V6: adds the `operation_id`, `correlation_id`, and `causation_id`
   * columns to `events`, with indexes, so queries filter on them without a
   * JSON scan. Each ALTER runs only when its column is absent, because
   * `SCHEMA_DDL` creates them on a fresh database. The step then backfills the
   * columns from the payload JSON and stamps version 6. The whole step runs in
   * one transaction.
   *
   * A payload that is not valid JSON, or that lacks the fields, keeps NULL
   * columns. NULL marks an event that is older than correlation stamping.
   */
  private migrateV5ToV6(): void {
    const now = new Date().toISOString();
    const runMigration = this.db.transaction((): void => {
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

      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence)',
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id)',
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id)',
      );

      this.backfillCorrelationColumnsChunked(now);

      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)')
        .run(6, now);
    });
    runMigration();
  }

  /**
   * Backfills the correlation columns in chunks of 1,000 rows, with one
   * progress event for each chunk on the `__migration__` stream. The scan
   * skips that stream, because its progress events also have NULL columns.
   *
   * A row without the fields stays NULL, so a rowid cursor, not the NULL test,
   * moves the loop forward. bun:sqlite has no `UPDATE ... LIMIT`, so the loop
   * selects the rowids first. `json_valid` stops one malformed payload from
   * aborting the migration. `rowsBackfilled` is the chunk size, because
   * `changes()` skips NULL-to-NULL updates. At `MAX_ITERATIONS`, the call
   * throws, so the outer transaction rolls back.
   */
  private backfillCorrelationColumnsChunked(timestamp: string): void {
    const CHUNK_SIZE = 1000;
    const MIGRATION_STREAM = '__migration__';

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
    const insertEvent = this.db.prepare(
      `INSERT INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

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

      const placeholders = rowids.map(() => '?').join(',');
      const updateSql = `
        UPDATE events
           SET operation_id   = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.operationId')   ELSE NULL END,
               correlation_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.correlationId') ELSE NULL END,
               causation_id   = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.causationId')   ELSE NULL END
         WHERE rowid IN (${placeholders})
      `;
      this.db.prepare(updateSql).run(...rowids);
      const rowsBackfilled = rowids.length;

      cursor = rowids[rowids.length - 1]!;

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
      throw new Error(
        `migrateV5ToV6: correlation backfill exceeded MAX_ITERATIONS=${MAX_ITERATIONS} ` +
          `(cursor=${cursor}); aborting so migrateV5ToV6 does not record schema_version=6 ` +
          'with incomplete backfill. Inspect the events table and the chunked cursor logic.',
      );
    }
  }

  /**
   * Recovers `workflow_type` for each `__legacy` stream row. The type comes
   * from the `workflow.started` event of the stream, or else from
   * `<featureId>.state.json` in the state dir. Each row still at `__legacy`
   * then gets one `migration.workflow_type_unknown` event.
   *
   * Only this method updates `streams.workflow_type`, and a grep-gate test
   * forbids that UPDATE elsewhere. The `__legacy` condition keeps the rows
   * that a concurrent init wrote.
   */
  private backfillWorkflowTypeFromStateFiles(): void {
    const updateStmt = this.db.prepare(
      `UPDATE streams SET workflow_type = ?
       WHERE streamId = ? AND workflow_type = '__legacy'`,
    );

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
   * Appends one `migration.workflow_type_unknown` event to each stream still
   * at `__legacy`. It runs before the appender exists, so it reads and
   * upserts the `sequences` row itself. The INSERT is strict, so a collision
   * fails and never advances the counter without its event.
   *
   * The INSERT binds six columns, because the V3 to V4 step runs before V6
   * adds the correlation columns. Each INSERT and its sequence upsert share
   * one transaction, so a crash between them cannot block the next start.
   */
  private emitWorkflowTypeUnknownEvents(): void {
    const legacyRows = this.db
      .prepare(
        `SELECT streamId FROM streams WHERE workflow_type = '__legacy' ORDER BY streamId`,
      )
      .all() as Array<{ streamId: string }>;

    if (legacyRows.length === 0) return;

    const now = new Date().toISOString();
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

  /**
   * Prepares the fixed statements. `insertEvent` ignores a duplicate.
   * `insertEventStrict` and `insertIdempotencyClaim` raise on a collision, so
   * the transaction rolls back. `upsertSequenceMonotonic` serves the startup
   * repair only, and it can raise a gate but never lower it.
   * `selectPendingOutbox` skips a row before its `nextRetryAt`, so a drain
   * obeys the backoff.
   */
  private prepareStatements(): Statements {
    return {
      insertEvent: this.db.prepare(
        'INSERT OR IGNORE INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      upsertSequence: this.db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
      ),
      upsertSequenceMonotonic: this.db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)',
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
      selectIdempotencyClaim: this.db.prepare(
        'SELECT eventIds, sequences, timestamps, events_json FROM idempotency_claims WHERE streamId = ? AND idempotencyKey = ?',
      ),
      insertIdempotencyClaim: this.db.prepare(
        'INSERT INTO idempotency_claims (streamId, idempotencyKey, eventIds, sequences, timestamps, events_json, claimedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      insertEventStrict: this.db.prepare(
        'INSERT INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
    };
  }

  /**
   * Inserts the event and sets the stream sequence in one transaction. The
   * payload JSON is the record, and the correlation columns only index it.
   */
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
        event.operationId ?? null,
        event.correlationId ?? null,
        event.causationId ?? null,
      );
      this.stmts.upsertSequence.run(streamId, event.sequence);
    });

    insertFn();
  }

  /**
   * Reads the events of a stream with optional filters. A correlation filter
   * uses its indexed column and counts once in `correlationFilteredQueries`.
   * Statements are cached by SQL text, so each filter shape gets its own entry.
   */
  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[] {
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

  /**
   * Returns `PRAGMA data_version`, the change token of the poll floor (see
   * {@link StorageBackend.dataVersion}). The value changes only when another
   * connection commits, and the caller compares two reads.
   *
   * The pragma runs inline and not as a kept statement. A kept statement can
   * pin a read snapshot that hides the foreign commit.
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
   * Returns the backend counters. The plain-number shape matches
   * `ViewMaterializer.getStats()`, so callers can combine the snapshots.
   */
  getStats(): { correlationFilteredQueries: number; workflowTypePushdownQueries: number } {
    return {
      correlationFilteredQueries: this.correlationFilteredQueries,
      workflowTypePushdownQueries: this.workflowTypePushdownQueries,
    };
  }

  /**
   * Reads the events of one type on the `streamPrefix` stream and on its
   * `<streamPrefix>/<segment>` descendants. The LIKE pattern needs a literal
   * `/` after the prefix, so a lookalike such as `<streamPrefix>-extra` never
   * matches. The other filters work as in `queryEvents`.
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

  /**
   * Returns the events stored under a `(streamId, idempotencyKey)` claim, or
   * `undefined`. The appender calls it before `BEGIN IMMEDIATE`, so a
   * cache-hit never takes the write lock.
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
   * Read a completed decideOnce claim by its globally unique operation ID.
   * The canonical result is deserialized at the storage boundary so callers
   * see the same value on the committing call and every later retry.
   */
  lookupOperationClaim<TResult = unknown>(
    operationId: string,
  ):
    | {
        streamId: string;
        requestDigest: string;
        result: TResult;
        eventIds: string[];
        sequences: number[];
        timestamps: string[];
      }
    | undefined {
    const row = this.stmts.selectIdempotencyClaim.get(
      DECIDE_ONCE_CLAIM_STREAM,
      operationId,
    ) as
      | {
          eventIds: string;
          sequences: string;
          timestamps: string;
          events_json: string;
        }
      | undefined;
    if (!row) return undefined;
    const envelope = JSON.parse(row.events_json) as {
      streamId: string;
      requestDigest: string;
      result: TResult;
    };
    return {
      streamId: envelope.streamId,
      requestDigest: envelope.requestDigest,
      result: envelope.result,
      eventIds: JSON.parse(row.eventIds) as string[],
      sequences: JSON.parse(row.sequences) as number[],
      timestamps: JSON.parse(row.timestamps) as string[],
    };
  }

  /**
   * Returns the sequence high-water mark of a stream, or 0 when the stream has
   * no `sequences` row. `allocateSequence` calls it inside the write
   * transaction. The appender also calls it outside a transaction, to find a
   * concurrent append after an empty decision.
   */
  readSequenceHighWaterMark(streamId: string): number {
    const row = this.stmts.selectSequence.get(streamId) as { sequence: number } | undefined;
    return row ? row.sequence : 0;
  }

  /**
   * Repairs the gate of each stream, its `sequences` row, against its durable
   * event tail. A gate below the tail makes the next append reuse a stored
   * sequence, so the repair raises it to the tail. A gate above the tail is a gap from a rolled-back or
   * pruned append. It stays, because sequences must stay monotonic.
   *
   * The SELECT and the upserts share one `BEGIN IMMEDIATE` transaction, so a
   * concurrent process cannot move the tail between them. The upsert is also
   * monotonic. Both cases log a warning, because a silent fix looks healthy.
   */
  private repairSequenceHighWaterMarks(): SequenceRepairReport {
    const divergenceQuery = this.db.prepare(
      `SELECT e.streamId AS streamId,
              MAX(e.sequence) AS tail,
              COALESCE(s.sequence, 0) AS gate
         FROM events e
         LEFT JOIN sequences s ON s.streamId = e.streamId
        GROUP BY e.streamId
       HAVING MAX(e.sequence) <> COALESCE(s.sequence, 0)`,
    );

    const repaired: SequenceRepair[] = [];
    const gaps: SequenceRepair[] = [];
    const repair = this.db.transaction(() => {
      const rows = divergenceQuery.all() as {
        streamId: string;
        tail: number;
        gate: number;
      }[];
      for (const row of rows) {
        (row.gate < row.tail ? repaired : gaps).push({
          streamId: row.streamId,
          gate: row.gate,
          tail: row.tail,
        });
      }
      for (const entry of repaired) {
        this.stmts.upsertSequenceMonotonic.run(entry.streamId, entry.tail);
      }
    });
    if (!hasImmediateTransaction(repair)) {
      throw new SqliteImmediateUnsupportedError();
    }
    repair.immediate();

    if (repaired.length > 0) {
      storeLogger.warn(
        {
          repaired: repaired.length,
          streams: repaired.slice(0, SEQUENCE_REPAIR_LOG_CAP),
          dbPath: this.dbPath,
        },
        'stream-version gate trailed the durable event tail; raised to the tail before serving traffic (EFF-001)',
      );
    }

    if (gaps.length > 0) {
      storeLogger.warn(
        {
          gaps: gaps.length,
          streams: gaps.slice(0, SEQUENCE_REPAIR_LOG_CAP),
          dbPath: this.dbPath,
        },
        'stream-version gate leads the durable event tail (rolled-back or pruned append); left monotonic, not lowered (EFF-001)',
      );
    }

    return { repaired, gaps };
  }

  /**
   * The sequence gate. Inside the `BEGIN IMMEDIATE` transaction of the caller,
   * it reads the high-water mark, compares it with `expected`, and advances it
   * by `n`. It returns the base, and the events take `base + 1` to `base + n`.
   *
   * The write lock makes the read and the advance race-free. A mismatch throws
   * {@link SequenceGateConflictError}, so the whole append rolls back. This
   * upsert is the only sequence update, because a second update counts twice.
   */
  private allocateSequence(
    streamId: string,
    n: number,
    expected?: number,
  ): number {
    const current = this.readSequenceHighWaterMark(streamId);
    if (expected !== undefined && current !== expected) {
      throw new SequenceGateConflictError(expected, current);
    }
    this.stmts.upsertSequence.run(streamId, current + n);
    return current;
  }

  /**
   * Runs the sequence gate, the idempotency claim, and the event INSERTs in
   * one `BEGIN IMMEDIATE` transaction. `finalize(base)` builds the rows inside
   * it. It must be fast and free of I/O, because it runs under the write lock
   * and a busy retry runs it again.
   *
   * A gate mismatch throws {@link SequenceGateConflictError}, and a strict
   * INSERT throws on a claim race or an `events` collision. SQLITE_BUSY
   * retries with backoff, then throws {@link SqliteBusyExhaustedError}. A
   * deferred `BEGIN` is never used, because it reopens the lock-upgrade
   * deadlock.
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
      const base = this.allocateSequence(
        args.streamId,
        args.n,
        args.expectedSequence,
      );
      const { events, claim } = args.finalize(base);

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

    if (!hasImmediateTransaction(txn)) {
      throw new SqliteImmediateUnsupportedError();
    }
    const runOnce = (): void => {
      txn.immediate();
    };

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
          const delay = Math.min(
            SQLITE_BUSY_RETRY_POLICY.baseDelayMs * Math.pow(2, attempt - 1),
            SQLITE_BUSY_RETRY_POLICY.maxDelayMs,
          );
          await sleep(delay);
        }
      }
    }
    throw new SqliteBusyExhaustedError(
      SQLITE_BUSY_RETRY_POLICY.maxAttempts,
      lastErr ?? new Error('SQLITE_BUSY (no captured cause)'),
    );
  }

  /**
   * Claims an operation, runs its synchronous decision closure, allocates the
   * sequences, and appends the events in one `BEGIN IMMEDIATE` transaction.
   * The claim lookup comes first, so a racing retry returns before the closure
   * runs. The closure runs under the write lock, so its reads share one
   * snapshot. The committing call also parses the stored result JSON, so
   * every caller gets the same shape.
   */
  async atomicDecideOnce<TResult>(args: {
    operationId: string;
    requestDigest: string;
    decide: () => AtomicDecideOnceDecision<TResult>;
  }): Promise<AtomicDecideOnceOutcome<TResult>> {
    let outcome: AtomicDecideOnceOutcome<TResult> | undefined;

    const txn = this.db.transaction((): void => {
      const existing = this.lookupOperationClaim<TResult>(args.operationId);
      if (existing) {
        if (existing.requestDigest !== args.requestDigest) {
          throw new OperationDigestConflictError(
            args.operationId,
            existing.requestDigest,
            args.requestDigest,
          );
        }
        outcome = {
          kind: 'cache-hit',
          streamId: existing.streamId,
          result: existing.result,
          sequences: existing.sequences,
          eventIds: existing.eventIds,
          timestamps: existing.timestamps,
        };
        return;
      }

      const decision = args.decide();
      if (!decision.streamId) {
        throw new Error('decideOnce decision requires streamId');
      }
      if (decision.n <= 0) {
        throw new Error('decideOnce decision requires at least one event');
      }

      const base = this.allocateSequence(
        decision.streamId,
        decision.n,
        decision.expectedSequence,
      );
      const finalized = decision.finalize(base);
      if (finalized.events.length !== decision.n) {
        throw new Error(
          `decideOnce finalized ${finalized.events.length} events; expected ${decision.n}`,
        );
      }

      const sequences = finalized.events.map((event) => event.sequence);
      const resultJson = JSON.stringify(decision.result);
      if (resultJson === undefined) {
        throw new Error('decideOnce result must be JSON-serializable');
      }

      this.stmts.insertIdempotencyClaim.run(
        DECIDE_ONCE_CLAIM_STREAM,
        args.operationId,
        JSON.stringify(finalized.eventIds),
        JSON.stringify(sequences),
        JSON.stringify(finalized.timestamps),
        JSON.stringify({
          version: 1,
          streamId: decision.streamId,
          requestDigest: args.requestDigest,
          result: JSON.parse(resultJson) as TResult,
          events: JSON.parse(finalized.events_json) as PublicPersistedEventLike[],
        }),
        new Date().toISOString(),
      );

      for (const event of finalized.events) {
        const data = event.data !== undefined ? JSON.stringify(event.data) : null;
        this.stmts.insertEventStrict.run(
          decision.streamId,
          event.sequence,
          event.type,
          event.timestamp,
          data,
          event.payload,
          event.operationId ?? null,
          event.correlationId ?? null,
          event.causationId ?? null,
        );
      }

      outcome = {
        kind: 'committed',
        streamId: decision.streamId,
        result: JSON.parse(resultJson) as TResult,
        sequences,
        eventIds: finalized.eventIds,
        timestamps: finalized.timestamps,
      };
    });

    if (!hasImmediateTransaction(txn)) {
      throw new SqliteImmediateUnsupportedError();
    }
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= SQLITE_BUSY_RETRY_POLICY.maxAttempts; attempt++) {
      try {
        txn.immediate();
        if (!outcome) {
          throw new Error('decideOnce transaction completed without an outcome');
        }
        return outcome;
      } catch (err) {
        if (!isSqliteBusy(err)) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < SQLITE_BUSY_RETRY_POLICY.maxAttempts) {
          const delay = Math.min(
            SQLITE_BUSY_RETRY_POLICY.baseDelayMs * Math.pow(2, attempt - 1),
            SQLITE_BUSY_RETRY_POLICY.maxDelayMs,
          );
          await sleep(delay);
        }
      }
    }
    throw new SqliteBusyExhaustedError(
      SQLITE_BUSY_RETRY_POLICY.maxAttempts,
      lastErr ?? new Error('SQLITE_BUSY (no captured cause)'),
    );
  }

  /**
   * Adds a stream to the registry. `INSERT OR IGNORE` keeps the first
   * `workflow_type`, because that column never changes after the insert. The
   * workflow init handler calls it once for each new stream.
   */
  registerStream(streamId: string, workflowType: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO streams (streamId, workflow_type, createdAt)
         VALUES (?, ?, ?)`,
      )
      .run(streamId, workflowType, new Date().toISOString());
  }

  /**
   * Returns the snapshot with the highest sequence for the
   * `(streamId, projectionId, projectionVersion)` coordinate, or `undefined`.
   * The `idx_projection_snapshots_latest` index serves the LIMIT 1 read.
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
   * Appends a snapshot and deletes the oldest rows of its coordinate until
   * `opts.maxRecords` rows remain. The limit defaults to `resolveMaxRecords()`.
   * A snapshot at a stored sequence is ignored, because the fold is
   * deterministic and the first row stays.
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

      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM projection_snapshots
           WHERE stream_id = ? AND projection_id = ? AND projection_version = ?`,
        )
        .get(streamId, record.projectionId, record.projectionVersion) as { cnt: number };

      const excess = countRow.cnt - max;
      if (excess > 0) {
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

  getState(featureId: string): WorkflowState | null {
    const row = this.stmts.getState.get(featureId) as { state: string; version: number } | undefined;
    if (!row) return null;
    return JSON.parse(row.state) as WorkflowState;
  }

  /**
   * Writes the state and increments its version. A mismatch with
   * `expectedVersion` throws {@link VersionConflictError}. A first write
   * without `expectedVersion` takes `state._version`, so the version matches
   * the persisted counter.
   */
  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void {
    const setFn = this.db.transaction(() => {
      const existing = this.stmts.getStateVersion.get(featureId) as { version: number } | undefined;
      const currentVersion = existing ? existing.version : 0;

      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new VersionConflictError(featureId, expectedVersion, currentVersion);
      }

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
   * Lists workflow summaries with the `workflowType` filter in the SQL WHERE.
   * The filter uses the `WORKFLOW_TYPE_EXPR` of the SELECT, so it also matches
   * a row with no `streams` entry by the type in its state JSON. The
   * LEFT JOIN keeps those rows, because init ignores `registerStream` errors
   * and the in-memory backend lists the same rows.
   *
   * The lifecycle filters run in {@link matchesWorkflowSummaryFilter}, as in
   * the in-memory backend. `createdAt` is the earliest event timestamp.
   */
  listWorkflowSummaries(filter: WorkflowSummaryFilter = {}): WorkflowSummary[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.workflowType !== undefined) {
      conditions.push(`${WORKFLOW_TYPE_EXPR} = ?`);
      params.push(filter.workflowType);
      this.workflowTypePushdownQueries++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
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

    const lifecycleFilter: WorkflowSummaryFilter = { ...filter, workflowType: undefined };
    return summaries.filter((summary) => matchesWorkflowSummaryFilter(summary, lifecycleFilter));
  }

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

  /**
   * Sends the due outbox rows in order, and awaits each send before it marks
   * the row confirmed. The first failure stops the drain, so later events
   * never arrive out of order. A failed row keeps its error, cut to 512
   * characters, and gets an exponential backoff from the injected clock.
   * After `MAX_OUTBOX_RETRIES` attempts, the row becomes a dead letter.
   */
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
        const rawMessage = err instanceof Error ? err.message : String(err);
        const errorMessage = rawMessage.length > 512
          ? `${rawMessage.slice(0, 509)}...`
          : rawMessage;

        if (newAttempts >= MAX_OUTBOX_RETRIES) {
          this.stmts.updateOutboxDeadLetter.run(
            'dead-letter',
            nowIso,
            `Max retries exceeded: ${errorMessage}`,
            row.id,
          );
        } else {
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
        break;
      }
    }

    return { sent, failed };
  }

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

  /**
   * Deletes a stream from every per-stream table in one transaction, so a
   * recreated stream sees no stale claims, snapshots, outbox rows, or view
   * cache. The `streams` row goes too, because `registerStream` never
   * replaces an existing `workflow_type`.
   */
  deleteStream(streamId: string): void {
    const deleteFn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM sequences WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM idempotency_claims WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM outbox WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM view_cache WHERE streamId = ?').run(streamId);
      this.db.prepare('DELETE FROM projection_snapshots WHERE stream_id = ?').run(streamId);
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

  /**
   * Runs `PRAGMA integrity_check` and returns the verdict of the first row.
   * The Promise lets `EventStore.runIntegrityCheck` apply a timeout. A
   * pre-aborted `signal` rejects before the pragma runs. An abort during the
   * pragma rejects after it ends, because SQLite cannot cancel synchronous
   * work.
   *
   * bun:sqlite returns the verdict column with an empty-string key, and
   * better-sqlite3 uses the key `integrity_check`. The code reads both keys.
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
          firstRow?.integrity_check ??
          firstRow?.[''] ??
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

  /**
   * Parses the payload JSON, which holds every field. A row from before the
   * payload column has no payload, so the event comes from the columns.
   */
  private rowToEvent(row: {
    streamId: string;
    sequence: number;
    type: string;
    timestamp: string;
    data: string | null;
    payload: string | null;
  }): WorkflowEvent {
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
