/**
 * Projection snapshot store — backend-delegated reader + writer (DR-2, §5.2).
 *
 * Snapshots are persisted to the active {@link StorageBackend}'s
 * `projection_snapshots` table (SQLite in production, in-memory for tests).
 * The legacy `<stateDir>/<streamId>.projections.jsonl` sidecar substrate was
 * removed in #1343 (Wave A); the backend's `(stream_id, projection_id,
 * projection_version, sequence)` PRIMARY KEY now provides the same per-stream
 * ordering and size-cap pruning that the JSONL sidecar provided previously.
 *
 * Read semantics ({@link readLatestSnapshot}): delegates to
 * `backend.readLatestProjectionSnapshot`, which returns the highest-sequence
 * row matching `(streamId, projectionId, projectionVersion)`, or `undefined`.
 *
 * Write semantics ({@link appendSnapshot}): delegates to
 * `backend.appendProjectionSnapshot`. Cap enforcement (oldest-row eviction
 * to retain exactly `maxRecords`) lives in the backend implementation; the
 * WARN-on-prune log emission stays at this wrapper boundary so consumers see
 * a stable structured-log surface regardless of substrate.
 *
 * Concurrency: serialization is the substrate's responsibility (SQLite WAL +
 * `BEGIN IMMEDIATE`); this layer is a thin wrapper.
 */

import { storeLogger } from '../logger.js';
import { SnapshotRecord } from './snapshot-schema.js';
import type { StorageBackend } from '../storage/backend.js';
import { defaultRegistry, type ProjectionRegistry } from './registry.js';
import type { ProjectionReducer } from './types.js';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { UnknownProjectionIdError } from './rebuild.js';

/** Default sidecar size cap when `SNAPSHOT_MAX_RECORDS` is unset or invalid. */
export const DEFAULT_SNAPSHOT_MAX_RECORDS = 500;

/**
 * Resolve the per-stream sidecar size cap from environment configuration.
 *
 * Reads `SNAPSHOT_MAX_RECORDS` and parses it as a positive integer. Any
 * missing, non-numeric, zero, or negative value falls back to
 * {@link DEFAULT_SNAPSHOT_MAX_RECORDS} (500) so misconfiguration never
 * disables the cap or produces a pathological value. Mirrors the defensive
 * pattern of {@link ../projections/cadence.ts.resolveCadence}.
 *
 * @param env - Environment object to read from. Defaults to `process.env`
 *   so callers usually invoke with no args; explicit passthrough enables
 *   pure testing without mutating process state.
 */
export function resolveMaxRecords(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SNAPSHOT_MAX_RECORDS;
  if (raw === undefined || raw === '') {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  return parsed;
}

/**
 * Reject stream identifiers that could traverse out of the substrate's
 * coordinate space. Pre-Wave-A this guard prevented JSONL filename
 * traversal; post-substrate-cut it still applies because the streamId
 * is a primary-key column on `projection_snapshots` and must be a
 * stable, opaque token (no path separators, no embedded NULs, no
 * relative-path escape sequences).
 *
 * Workflow streams use feature ids that are already constrained upstream
 * (slugified `feature/<id>` form), but this helper enforces the invariant
 * locally so a future caller can't trip it inadvertently.
 */
function assertStreamIdSafe(streamId: string): void {
  if (
    streamId.length === 0 ||
    streamId.includes('..') ||
    streamId.includes('/') ||
    streamId.includes('\\') ||
    streamId.includes('\0')
  ) {
    throw new Error(
      `Invalid streamId for projection snapshot: ${JSON.stringify(streamId)}`,
    );
  }
}

/** Optional per-call overrides for {@link appendSnapshot}. */
export interface AppendSnapshotOptions {
  /**
   * Maximum retained records after append. When the post-append count for
   * this `(streamId, projectionId, projectionVersion)` coordinate would
   * exceed this value, the backend evicts the oldest rows in one
   * transaction so the coordinate retains exactly `maxRecords` rows, and
   * one WARN is emitted via the structured logger with the count pruned.
   * Defaults to the value from {@link resolveMaxRecords} (i.e., the
   * `SNAPSHOT_MAX_RECORDS` env var or {@link DEFAULT_SNAPSHOT_MAX_RECORDS}).
   */
  maxRecords?: number;
}

/**
 * Read the highest-sequence snapshot for `(streamId, projectionId,
 * projectionVersion)` from the backend, or `undefined` when no row matches.
 *
 * Defensive parse: if the backend's row payload fails {@link SnapshotRecord}
 * schema validation, returns `undefined` rather than throwing — the caller
 * treats schema-invalid snapshots the same as a missing snapshot and
 * proceeds to a cold rebuild from the event log.
 */
export function readLatestSnapshot(
  backend: StorageBackend,
  streamId: string,
  projectionId: string,
  projectionVersion: string,
): SnapshotRecord | undefined {
  assertStreamIdSafe(streamId);
  const raw = backend.readLatestProjectionSnapshot(
    streamId,
    projectionId,
    projectionVersion,
  );
  if (raw === undefined) return undefined;
  const result = SnapshotRecord.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Append a {@link SnapshotRecord} for the given stream via the backend.
 *
 * Enforces a per-coordinate size cap (DR-18 resilience): once the row count
 * for `(streamId, record.projectionId, record.projectionVersion)` would
 * exceed `options.maxRecords`, the backend deletes the oldest rows in one
 * transaction so the coordinate retains exactly `maxRecords` rows. The
 * cap defaults to the value resolved by {@link resolveMaxRecords} at call
 * time.
 *
 * Emits one WARN per prune event via {@link storeLogger} (forwarded from
 * the backend's atomic count). The wrapper queries the backend's row
 * count for the coordinate before and after the append to compute the
 * prune count exactly.
 */
export function appendSnapshot(
  backend: StorageBackend,
  streamId: string,
  record: SnapshotRecord,
  options: AppendSnapshotOptions = {},
): void {
  assertStreamIdSafe(streamId);

  const maxRecords =
    options.maxRecords !== undefined &&
    Number.isInteger(options.maxRecords) &&
    options.maxRecords > 0
      ? options.maxRecords
      : resolveMaxRecords();

  backend.appendProjectionSnapshot(streamId, record, {
    maxRecords,
    onPrune: (prunedCount) => {
      storeLogger.warn(
        {
          streamId,
          prunedCount,
          maxRecords,
        },
        'Snapshot store exceeded size cap — pruned oldest records',
      );
    },
  });
}

// ─── Wave 2A.6 — readProjection<T>(reducerId) global-scope primitive ────────

/**
 * Error raised when a primitive (`readProjection` etc.) is invoked against
 * a reducer whose `scope` does not match the primitive's contract.
 *
 * The message starts with the literal token `INVALID_REDUCER_SCOPE` so
 * downstream consumers can pattern-match the error reliably (#1284 / INV-5b).
 * `expectedShape` carries the scope the primitive requires; `actualScope`
 * carries the reducer's declared scope.
 */
export class InvalidReducerScopeError extends Error {
  constructor(
    public readonly reducerId: string,
    public readonly actualScope: 'stream' | 'global',
    public readonly expectedShape: { scope: 'stream' | 'global' },
  ) {
    super(
      `INVALID_REDUCER_SCOPE: reducer ${JSON.stringify(reducerId)} has scope ${JSON.stringify(actualScope)}, but primitive requires scope ${JSON.stringify(expectedShape.scope)}`,
    );
    this.name = 'InvalidReducerScopeError';
  }
}

/**
 * Optional overrides for {@link readProjection}.
 *
 * `registry` selects the lookup source for the reducer id. Defaults to the
 * process-wide {@link defaultRegistry} so production call sites need not
 * thread it through. Tests needing isolation pass a freshly-created registry
 * (matching the convention from `rebuildProjection`'s `RebuildProjectionOptions`).
 */
export interface ReadProjectionOptions {
  readonly registry?: ProjectionRegistry;
}

/**
 * Fold a registered **global** projection's state from snapshot (if fresh)
 * plus the unfolded tail of events across every stream. The read primitive
 * for `scope: 'global'` reducers (Wave 2A.6, #1284).
 *
 * ## Storage convention for global snapshots
 *
 * The existing snapshot machinery (`appendSnapshot` / `readLatestSnapshot`)
 * is keyed on `streamId`. For a global projection there is no per-stream
 * sidecar — we use the **reducer id** as the snapshot key (e.g.
 * `task-store@v1`). The reducer id is a non-empty string with no path
 * separators, so it satisfies the path-traversal guard in
 * `getSnapshotSidecarPath`. This decouples global-snapshot storage from any
 * one stream and lets the per-stream sidecars stay reserved for stream-scoped
 * projections (rehydration, merge-orchestrator, ...).
 *
 * ## Algorithm
 *
 *   1. Resolve `reducerId` against `options.registry` (or the process-wide
 *      default). Throw {@link UnknownProjectionIdError} on miss.
 *   2. Reject reducers with `scope !== 'global'` via
 *      {@link InvalidReducerScopeError}.
 *   3. Read the latest snapshot for `(reducerId, reducerId, "<version>")`.
 *      If present, seed state from `snapshot.state` and use `snapshot.sequence`
 *      as the high-water-mark; otherwise seed from `reducer.initial` with
 *      HWM = 0.
 *   4. Enumerate every stream via `EventStore.listStreams()`, query each,
 *      filter to events strictly after the HWM, sort the merged result by
 *      `(timestamp, sequence)` for a deterministic global order, and fold
 *      via `reducer.apply`.
 *
 * Sort key rationale: within a stream `sequence` is monotonic, but
 * `sequence` is **not** comparable across streams. `timestamp` is
 * monotonically advancing across the whole event store; `sequence` is the
 * secondary tiebreaker for events at the same timestamp (rare but
 * possible — sub-millisecond bursts on a fast appender). This matches the
 * ordering `EventStore.queryByType` produces across stream boundaries.
 *
 * @typeParam T - The projected state type. The caller asserts this matches
 *   the resolved reducer's state type; this is a structural-typing contract,
 *   not enforced by the registry (which stores reducers as
 *   `ProjectionReducer<unknown, unknown>`).
 *
 * @param reducerId - The registered reducer id (e.g. `'task-store@v1'`).
 * @param eventStore - Initialised event store to read from. The snapshot
 *   read flows through `eventStore.getReadBackend()` (the same SQLite
 *   substrate the appender owns post-#1343 / Wave A).
 * @param options - Optional overrides. See {@link ReadProjectionOptions}.
 *
 * @throws {UnknownProjectionIdError} when no reducer is registered under `reducerId`.
 * @throws {InvalidReducerScopeError} when the reducer's scope is not `'global'`.
 */
export async function readProjection<T>(
  reducerId: string,
  eventStore: EventStore,
  options: ReadProjectionOptions = {},
): Promise<T> {
  const registry = options.registry ?? defaultRegistry;
  const reducer = registry.get(reducerId);
  if (!reducer) {
    throw new UnknownProjectionIdError(reducerId);
  }
  if (reducer.scope !== 'global') {
    throw new InvalidReducerScopeError(reducerId, reducer.scope, {
      scope: 'global',
    });
  }

  // Snapshot lookup: keyed on the reducer id (the global-snapshot convention).
  const projectionVersion = String(reducer.version);
  const snapshot = readLatestSnapshot(
    eventStore.getReadBackend(),
    reducerId,
    reducerId,
    projectionVersion,
  );

  let state: unknown =
    snapshot !== undefined ? (snapshot.state as unknown) : reducer.initial;
  const highWaterMark = snapshot?.sequence ?? 0;

  // Cold/tail fold: enumerate every stream and merge unfolded events.
  // listStreams() returns the canonical stream list from the backend;
  // duplicates are unlikely but de-duped here for defence in depth.
  const seen = new Set<string>();
  const streams: string[] = [];
  for (const sid of eventStore.listStreams()) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    streams.push(sid);
  }

  // Collect every relevant event (sinceSequence is per-stream; the
  // cross-stream HWM is timestamp-based, applied at merge time below).
  const merged: WorkflowEvent[] = [];
  for (const streamId of streams) {
    // Cheap optimisation: if there's a snapshot, the per-stream `sequence`
    // is at least the snapshot's HWM ONLY when the snapshot was produced
    // by folding events on that stream — which we cannot assume for a
    // global projection. We therefore query each stream in full and
    // apply the HWM filter below by `timestamp`, matching the ordering
    // discipline documented above.
    const events = await eventStore.query(streamId);
    for (const ev of events) merged.push(ev);
  }

  // Deterministic global ordering: (timestamp ASC, sequence ASC).
  merged.sort((a, b) => {
    const byTs = a.timestamp.localeCompare(b.timestamp);
    return byTs !== 0 ? byTs : a.sequence - b.sequence;
  });

  // When folding from a fresh snapshot, every event up-to-and-including
  // the snapshot's HWM has already been baked into `state`. Skip them.
  //
  // Caveat: this HWM is the snapshot's `sequence` field, which our snapshot
  // convention treats as the **count of events folded** rather than any
  // single stream's sequence. The cold-fold + fresh-snapshot tests in
  // store.test.ts both rely on this count semantics — change with care.
  const tail = highWaterMark > 0 ? merged.slice(highWaterMark) : merged;

  for (const event of tail) {
    state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, event);
  }

  return state as T;
}
