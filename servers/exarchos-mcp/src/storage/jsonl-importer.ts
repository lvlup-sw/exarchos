import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { AtomicAppender, EventInput } from '../event-store/atomic-appender.js';
import type { SqliteBackend } from './sqlite-backend.js';
import { logger } from '../logger.js';

/**
 * JSONL → SQLite importer (#1259, T20 / T21, DR-8 / DR-9).
 *
 * Reads a legacy `<streamId>.events.jsonl` file line-by-line, parses each
 * line as a single persisted event, and routes the events through the
 * canonical `AtomicAppender.append()` path so the wire-format and
 * substrate guarantees stay consistent with runtime appends.
 *
 * Malformed-line policy (skip-and-continue, NOT strict by default):
 *   - A line that is not valid JSON is logged at warn level and skipped.
 *     It is counted toward `malformedLines`, NOT toward `eventCount`, and
 *     does NOT fail the import. Rationale: a single corrupt line in a
 *     legacy stream should not block the whole migration; operators can
 *     audit `.archive-v210/` after the run if they want to forensically
 *     reconstruct skipped lines.
 *   - A line that parses but is missing required fields is also skipped
 *     under the same policy.
 *   - Strict mode is intentionally NOT exposed yet — it can be added when
 *     a concrete operator workflow demands it.
 *
 * Archive on success (T21):
 *   - After all parseable events have been appended successfully, the
 *     source file is moved (NOT deleted) to `<dir>/.archive-v210/<basename>`.
 *     The archive directory is created on demand (one-shot at first archive).
 *
 * `migration.legacy_jsonl_imported` event emission:
 *   - One event per file, on the `__migration__` stream, with
 *     `data: { sourcePath, eventCount, durationMs }`. Routed via
 *     `appender.appendUnkeyed` so the importer does not pollute any
 *     idempotency cache for the `__migration__` stream.
 */

export interface ImportFileResult {
  ok: true;
  eventCount: number;
  malformedLines: number;
  durationMs: number;
}

export interface ImportFileError {
  ok: false;
  reason: string;
  cause?: Error;
  /** Number of events successfully imported before the failure. */
  eventCount: number;
}

const MIGRATION_STREAM_ID = '__migration__';

interface ParsedJsonlEvent {
  streamId?: string;
  type?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
  // The legacy file may carry extra fields (sequence, eventId, schemaVersion, …)
  // — they're accepted on read, but the canonical AtomicAppender.append path
  // owns sequence/eventId allocation, so most of them are intentionally
  // discarded. Carrying through `correlationId`, `causationId`, `agentId`,
  // `agentRole`, `source`, and `schemaVersion` preserves observability.
  correlationId?: string;
  causationId?: string;
  agentId?: string;
  agentRole?: string;
  source?: string;
  schemaVersion?: string;
  [k: string]: unknown;
}

/**
 * Import a single legacy JSONL file.
 *
 * The `streamId` is derived from the basename: `<streamId>.events.jsonl`.
 * If the file does not match this naming convention, the importer falls
 * back to using the basename without the `.events.jsonl` suffix, which
 * is the same scheme `AtomicAppender.getEventFilePath` uses for runtime
 * appends.
 */
export async function importJsonlFile(
  filePath: string,
  appender: AtomicAppender,
  _backend: SqliteBackend,
): Promise<ImportFileResult | ImportFileError> {
  const start = Date.now();
  const basename = path.basename(filePath);
  const streamId = basename.endsWith('.events.jsonl')
    ? basename.slice(0, -'.events.jsonl'.length)
    : basename.replace(/\.[^.]+$/, '');

  if (streamId.length === 0) {
    return {
      ok: false,
      reason: `Could not derive streamId from file path: ${filePath}`,
      eventCount: 0,
    };
  }

  // ─── Read file ────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to read JSONL file ${filePath}: ${(err as Error).message}`,
      cause: err instanceof Error ? err : new Error(String(err)),
      eventCount: 0,
    };
  }

  // ─── Parse line-by-line; tolerate malformed ──────────────────────────
  const lines = raw.split('\n');
  let eventCount = 0;
  let malformedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let parsed: ParsedJsonlEvent;
    try {
      parsed = JSON.parse(line) as ParsedJsonlEvent;
    } catch (err) {
      malformedLines++;
      logger.warn(
        {
          file: filePath,
          line: i + 1,
          err: err instanceof Error ? err.message : String(err),
        },
        'jsonl-importer: skipping malformed JSON line',
      );
      continue;
    }
    if (!parsed.type || typeof parsed.type !== 'string') {
      malformedLines++;
      logger.warn(
        { file: filePath, line: i + 1 },
        'jsonl-importer: skipping line missing required `type` field',
      );
      continue;
    }

    // Build the EventInput from the parsed line. The canonical path owns
    // sequence/eventId allocation, so we drop those — but we preserve
    // timestamp + observability fields so the imported event matches the
    // historical record as closely as possible.
    const eventInput: EventInput = {
      type: parsed.type,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed.timestamp !== undefined ? { timestamp: parsed.timestamp } : {}),
      ...(parsed.correlationId !== undefined ? { correlationId: parsed.correlationId } : {}),
      ...(parsed.causationId !== undefined ? { causationId: parsed.causationId } : {}),
      ...(parsed.agentId !== undefined ? { agentId: parsed.agentId } : {}),
      ...(parsed.agentRole !== undefined ? { agentRole: parsed.agentRole } : {}),
      ...(parsed.source !== undefined ? { source: parsed.source } : {}),
      ...(parsed.schemaVersion !== undefined ? { schemaVersion: parsed.schemaVersion } : {}),
    };

    // Append through the canonical path. We use the original idempotency
    // key when present (so re-importing the same file is naturally
    // idempotent against a partial run) and fall back to `appendUnkeyed`
    // when it is absent.
    const result = parsed.idempotencyKey
      ? await appender.append(streamId, [eventInput], parsed.idempotencyKey)
      : await appender.appendUnkeyed(streamId, [eventInput]);

    if (!result.ok) {
      return {
        ok: false,
        reason: `Append failed at line ${i + 1}: reason=${result.reason}`,
        cause: result.cause instanceof Error ? result.cause : undefined,
        eventCount,
      };
    }
    // `kind === 'cache-hit'` means a prior partial-import already recorded
    // this event; we still count it toward the file's observed eventCount
    // because the on-disk JSONL line corresponds to a persisted event in
    // the SQLite events table.
    eventCount++;
  }

  const durationMs = Date.now() - start;

  // ─── Emit migration.legacy_jsonl_imported on `__migration__` ──────────
  // Routed through `appendUnkeyed` so the migration stream is treated as
  // a legitimate event stream (substrate-INV-1: migration steps are
  // events) rather than a side-channel write.
  const emitResult = await appender.appendUnkeyed(MIGRATION_STREAM_ID, [
    {
      type: 'migration.legacy_jsonl_imported',
      data: {
        sourcePath: filePath,
        eventCount,
        durationMs,
      },
    },
  ]);
  if (!emitResult.ok) {
    return {
      ok: false,
      reason: `Failed to emit migration.legacy_jsonl_imported: reason=${emitResult.reason}`,
      cause: emitResult.cause instanceof Error ? emitResult.cause : undefined,
      eventCount,
    };
  }

  // Archive of the source file is performed by T21 in a follow-on commit.

  return { ok: true, eventCount, malformedLines, durationMs };
}
