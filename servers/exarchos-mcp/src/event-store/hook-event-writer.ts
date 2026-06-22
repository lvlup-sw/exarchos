// ─── Hook Event Sidecar Writer ──────────────────────────────────────────────
//
// Writes events to hook-event sidecar files (`{streamId}.hook-events.jsonl`)
// for later merging into the main EventStore. Used by CLI hook subprocesses
// (e.g., the observer hooks) that cannot share the EventStore in-process.
//
// Hook-event sidecar files are picked up by the periodic merger
// (`storage/sidecar-merger.ts`) and replayed into the EventStore. This is
// distinct from — and survives — the v2.11 deletion of EventStore's
// PID-lock sidecar fallback (#1082): hook subprocess writers operate
// outside the lock by construction (they live in a separate process), so
// the side-channel is structural, not a degradation of the primary
// write-path.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HookEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly timestamp?: string;
  readonly idempotencyKey?: string;
}

// ─── Sidecar File Naming ────────────────────────────────────────────────────

/**
 * Returns the hook-event sidecar file path for a given stream. Internal —
 * the only public surface here is `writeHookEvent`. Was previously exported
 * for the EventStore PID-lock sidecar merge path; that path was deleted in
 * v2.11 (#1082).
 */
function getSidecarPath(stateDir: string, streamId: string): string {
  return path.join(stateDir, `${streamId}.hook-events.jsonl`);
}

// ─── Writer ─────────────────────────────────────────────────────────────────

/**
 * Append a single hook event to the sidecar file for the given stream.
 *
 * The sidecar file is created if it does not exist. Events are written as
 * newline-delimited JSON (JSONL). A timestamp defaults to `new Date().toISOString()`
 * if not provided.
 *
 * This function is safe to call from hook subprocesses — it appends through
 * the same WAL-serialized substrate and needs no exclusive EventStore lock
 * (there is none; cross-process writes serialize on the SQLite write lock).
 */
export async function writeHookEvent(
  stateDir: string,
  streamId: string,
  event: HookEvent,
): Promise<void> {
  const line: Record<string, unknown> = {
    type: event.type,
    data: event.data,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };

  if (event.idempotencyKey) {
    line.idempotencyKey = event.idempotencyKey;
  }

  const filePath = getSidecarPath(stateDir, streamId);
  const jsonLine = JSON.stringify(line) + '\n';
  await fs.appendFile(filePath, jsonLine, 'utf-8');
}
