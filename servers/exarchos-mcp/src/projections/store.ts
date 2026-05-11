/**
 * Projection snapshot store — JSONL sidecar reader + writer (DR-2, §5.2).
 *
 * Sidecar file: `<stateDir>/<streamId>.projections.jsonl`.
 * Each line is a JSON-encoded {@link SnapshotRecord}.
 *
 * Read semantics ({@link readLatestSnapshot}): lines that fail JSON parsing,
 * fail schema validation, or whose `projectionId` / `projectionVersion` do not
 * match the request are skipped. The record with the highest `sequence` among
 * matching lines is returned. If the file is missing or no line matches,
 * returns `undefined`.
 *
 * Write semantics ({@link appendSnapshot}): read the existing sidecar (if any),
 * append the new JSONL line, stage the complete payload to
 * `<target>.<pid>.<random>.tmp`, `fsync` the tmp file, then `rename` over the
 * target. `rename` is atomic on POSIX, giving atomic append at the file level.
 * On rename failure the tmp file is best-effort unlinked.
 *
 * Concurrency caveat: intended for a single-writer process. Cross-process
 * concurrency is out of scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { storeLogger } from '../logger.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { SnapshotRecord } from './snapshot-schema.js';
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
 * Resolve the JSONL sidecar path for a given workflow stream, rejecting
 * stream identifiers that could escape `stateDir`. Both the read and write
 * code paths interpolate `streamId` directly into a filename, so any value
 * containing `..` or path separators would let a caller materialise paths
 * outside the projection root and read or overwrite arbitrary files.
 *
 * Workflow streams use feature ids that are already constrained upstream
 * (slugified `feature/<id>` form), but this helper enforces the invariant
 * locally so a future caller can't trip it inadvertently.
 */
function getSnapshotSidecarPath(stateDir: string, streamId: string): string {
  if (
    streamId.length === 0 ||
    streamId.includes('..') ||
    streamId.includes('/') ||
    streamId.includes('\\') ||
    streamId.includes('\0')
  ) {
    throw new Error(
      `Invalid streamId for projection sidecar: ${JSON.stringify(streamId)}`,
    );
  }
  return path.join(stateDir, `${streamId}.projections.jsonl`);
}

/** Optional per-call overrides for {@link appendSnapshot}. */
export interface AppendSnapshotOptions {
  /**
   * Maximum retained records after append. When the post-append line count
   * would exceed this value, the oldest lines are pruned in one shot so the
   * sidecar retains exactly `maxRecords` lines, and one WARN is emitted via
   * the structured logger with the count pruned. Defaults to the value from
   * {@link resolveMaxRecords} (i.e., the `SNAPSHOT_MAX_RECORDS` env var or
   * {@link DEFAULT_SNAPSHOT_MAX_RECORDS}).
   */
  maxRecords?: number;
}

export function readLatestSnapshot(
  stateDir: string,
  streamId: string,
  projectionId: string,
  projectionVersion: string,
): SnapshotRecord | undefined {
  const sidecar = getSnapshotSidecarPath(stateDir, streamId);

  let raw: string;
  try {
    raw = fs.readFileSync(sidecar, 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return undefined;
    }
    throw err;
  }

  let latest: SnapshotRecord | undefined;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      continue;
    }

    const result = SnapshotRecord.safeParse(parsedJson);
    if (!result.success) continue;

    const record = result.data;
    if (record.projectionId !== projectionId) continue;
    if (record.projectionVersion !== projectionVersion) continue;

    if (latest === undefined || record.sequence > latest.sequence) {
      latest = record;
    }
  }

  return latest;
}

/**
 * Append a {@link SnapshotRecord} to the per-stream projections sidecar.
 *
 * Enforces a size cap (DR-18 resilience): once the sidecar would exceed
 * `options.maxRecords` lines post-append, the oldest lines are dropped in
 * one shot so the sidecar retains exactly `maxRecords` lines. Emits a
 * single WARN per prune event via {@link storeLogger}, including the count
 * pruned, the stream, and the resolved cap. The cap defaults to the value
 * resolved by {@link resolveMaxRecords} at call time.
 *
 * @param stateDir  Directory containing per-stream sidecars; created if absent.
 * @param streamId  Workflow stream identifier — forms the sidecar basename.
 * @param record    Snapshot record to append.
 * @param options   Optional overrides; see {@link AppendSnapshotOptions}.
 */
export function appendSnapshot(
  stateDir: string,
  streamId: string,
  record: SnapshotRecord,
  options: AppendSnapshotOptions = {},
): void {
  fs.mkdirSync(stateDir, { recursive: true });

  const maxRecords =
    options.maxRecords !== undefined &&
    Number.isInteger(options.maxRecords) &&
    options.maxRecords > 0
      ? options.maxRecords
      : resolveMaxRecords();

  const target = getSnapshotSidecarPath(stateDir, streamId);
  const existing = readIfExists(target);
  const line = `${JSON.stringify(record)}\n`;

  const combined = existing + line;
  const pruned = applySizeCap(combined, maxRecords);
  if (pruned.prunedCount > 0) {
    storeLogger.warn(
      {
        streamId,
        prunedCount: pruned.prunedCount,
        maxRecords,
      },
      'Snapshot sidecar exceeded size cap — pruned oldest records',
    );
  }

  atomicWriteFile(target, pruned.content);
}

/**
 * Enforce the JSONL sidecar size cap.
 *
 * Splits `content` on `\n`, drops the trailing empty segment produced by
 * the final newline, and if the line count exceeds `maxRecords`, retains
 * only the most-recent `maxRecords` lines (dropping the oldest). Returns
 * the rebuilt JSONL content and the count of pruned lines.
 */
function applySizeCap(
  content: string,
  maxRecords: number,
): { content: string; prunedCount: number } {
  if (content.length === 0) {
    return { content, prunedCount: 0 };
  }
  const segments = content.split('\n');
  // Every well-formed JSONL ends in '\n', so the last segment is ''.
  const trailer = segments.at(-1) === '' ? '' : segments.pop() ?? '';
  const dataLines = trailer === '' ? segments.slice(0, -1) : segments;

  if (dataLines.length <= maxRecords) {
    return { content, prunedCount: 0 };
  }

  const prunedCount = dataLines.length - maxRecords;
  const retained = dataLines.slice(prunedCount);
  return { content: retained.join('\n') + '\n', prunedCount };
}

function readIfExists(target: string): string {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return '';
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
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
 * @param eventStore - Initialised event store to read from.
 * @param stateDir - State directory containing the snapshot sidecar.
 * @param options - Optional overrides. See {@link ReadProjectionOptions}.
 *
 * @throws {UnknownProjectionIdError} when no reducer is registered under `reducerId`.
 * @throws {InvalidReducerScopeError} when the reducer's scope is not `'global'`.
 */
export async function readProjection<T>(
  reducerId: string,
  eventStore: EventStore,
  stateDir: string,
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
    stateDir,
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
