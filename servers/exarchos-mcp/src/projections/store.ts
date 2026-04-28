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
