// ─── Hook Event Sidecar Writer ──────────────────────────────────────────────
//
// Writes events to sidecar files (`{streamId}.hook-events.jsonl`) for later
// merging into the main EventStore. Used by CLI hook subprocesses (e.g.,
// teammate-gate) that cannot import the full EventStore due to PID lock
// constraints.
//
// Sidecar files are merged on next EventStore startup via the sidecar merger.

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

/** Returns the sidecar file path for a given stream. */
export function getSidecarPath(stateDir: string, streamId: string): string {
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
 * This function is safe to call from hook subprocesses — it does not require
 * the EventStore PID lock.
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
