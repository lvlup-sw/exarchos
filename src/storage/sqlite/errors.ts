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
 * Storage-boundary conflict raised when an operation ID already has a
 * committed result under a different request digest.
 */
export class OperationDigestConflictError extends Error {
  override readonly name = 'OperationDigestConflictError';
  readonly code = 'OPERATION_DIGEST_MISMATCH';

  constructor(
    public readonly operationId: string,
    public readonly expectedDigest: string,
    public readonly actualDigest: string,
  ) {
    super(
      `operation ${JSON.stringify(operationId)} was already committed with a different request digest`,
    );
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
 * Thrown by `initialize()` when the event store's persisted schema identity is
 * NEWER than the schema version this binary understands (`SCHEMA_VERSION`). A
 * store written by a newer Exarchos release must NOT be silently opened by an
 * older one: the older binary would re-stamp its own (lower) version alongside
 * the newer marker and operate against a schema whose invariants it does not
 * know, risking silent data corruption (P05-04, ART-009).
 *
 * The directional policy is asymmetric by design and mirrors the forward-only
 * migration machinery: an OLDER store (version < SCHEMA_VERSION) is
 * forward-migrated on open; a NEWER store (version > SCHEMA_VERSION) is refused
 * because downgrade is not a supported operation. Like {@link SqliteCorruptError},
 * this terminates lifecycle startup — consumers must not catch it and continue.
 */
export class SchemaVersionTooNewError extends Error {
  override readonly name = 'SchemaVersionTooNewError';
  readonly code = 'SCHEMA_VERSION_TOO_NEW';
  constructor(
    public readonly dbPath: string,
    public readonly storeVersion: number,
    public readonly binaryVersion: number,
  ) {
    super(
      `Event store at ${dbPath} was written under schema version ${storeVersion}, ` +
        `but this binary understands schema version ${binaryVersion}. A store written by a ` +
        `newer Exarchos release must not be opened by an older one (downgrade is unsupported). ` +
        `Upgrade the exarchos binary to a release that understands schema version ` +
        `${storeVersion} (or newer), or point WORKFLOW_STATE_DIR at a store written by this ` +
        `binary.`,
    );
  }
}
