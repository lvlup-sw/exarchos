/**
 * Thrown by `atomicAppend` when SQLITE_BUSY persists past the retry budget. The
 * last driver error is the `cause`. `AtomicAppender` maps this error to
 * `storage_busy`, and it treats a generic `SqliteError` as an io-error.
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
 * Thrown by the stream-version gate (`allocateSequence`) when `expectedSequence`
 * does not match the durable stream tail. The gate assigns and checks the
 * version atomically inside `BEGIN IMMEDIATE`, so the error carries the real
 * `expected` and `actual` values.
 *
 * It is thrown inside the transaction, so the whole append rolls back.
 * `atomicAppend` does not retry it, and `AtomicAppender` maps it to the
 * `sequence-conflict` result.
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
 * Thrown by `initialize()` when the SQLite driver has no
 * `transaction(fn).immediate()`. Cross-process writes need `BEGIN IMMEDIATE` to
 * take the write lock first. A deferred `BEGIN` can deadlock on the lock upgrade,
 * so the substrate refuses to start. `bun:sqlite` and `better-sqlite3` both have it.
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
 * Thrown by `initialize()` when the database file is not a SQLite database
 * (`SQLITE_NOTADB`) or is corrupt (`SQLITE_CORRUPT`). The substrate never rebuilds
 * it, because a rebuild destroys the evidence for diagnosis. It stops lifecycle
 * startup, and consumers must not catch it and continue.
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
 * Thrown by `initialize()` when the persisted schema version is newer than
 * `SCHEMA_VERSION`. An older binary must not open a newer store, because it does
 * not know the newer invariants. An older store migrates forward on open. Like
 * {@link SqliteCorruptError}, this error stops lifecycle startup.
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
