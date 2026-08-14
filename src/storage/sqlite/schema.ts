// ─── Schema DDL ─────────────────────────────────────────────────────────────

// Exported (additively) for the install-freshness gate (P05-04, ART-009): the
// install-identity record captures the schema version this binary understands
// so a freshness check can compare it against a store's persisted identity. The
// value remains the single source of truth for the store's own DDL/migration
// ledger below.
export const SCHEMA_VERSION = 6;

export const SCHEMA_DDL = `
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
