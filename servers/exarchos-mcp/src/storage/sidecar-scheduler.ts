// ─── Sidecar Drain Scheduler ────────────────────────────────────────────────
//
// Periodically drains sidecar files (`{streamId}.hook-events.jsonl`) into the
// main EventStore. This prevents unbounded sidecar backlog in long-running
// primary processes.
//
// Drain cycle:
//   1. Rename sidecar -> drain file (atomic swap prevents concurrent writer loss)
//   2. Parse and merge events from drain file into EventStore
//   3. Unlink drain file after successful processing

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DrainResult {
  readonly merged: number;
  readonly skipped: number;
  readonly errors: number;
  readonly durationMs: number;
}

export interface PeriodicMergeHandle {
  stop(): void;
}

export interface PeriodicMergeOptions {
  /** Run one drain cycle before returning the handle. When true, the function returns a Promise. */
  readonly immediate?: boolean;
  /** Optional callback invoked after each drain cycle with observability data. */
  readonly onDrain?: (result: DrainResult) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SIDECAR_SUFFIX = '.hook-events.jsonl';
const DEFAULT_INTERVAL_MS = 5000;

/** Parse an integer from an environment variable with a fallback default. */
function parseEnvInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Start a periodic drain of sidecar files into the EventStore.
 *
 * When `opts.immediate` is true, the first drain cycle runs before the handle
 * is returned. The function is async to support this — callers should `await`
 * the result.
 *
 * @param stateDir   Directory containing sidecar files
 * @param eventStore EventStore to merge events into (must hold the PID lock)
 * @param intervalMs Drain interval in milliseconds (default: 5000, overridable via EXARCHOS_SIDECAR_DRAIN_INTERVAL_MS)
 * @param opts       Optional: `immediate` fires one drain before returning; `onDrain` receives observability data
 * @returns A handle with a `stop()` method to cancel the periodic drain
 */
export async function startPeriodicMerge(
  stateDir: string,
  eventStore: EventStore,
  intervalMs?: number,
  opts?: PeriodicMergeOptions,
): Promise<PeriodicMergeHandle> {
  const interval = intervalMs ?? parseEnvInt('EXARCHOS_SIDECAR_DRAIN_INTERVAL_MS', DEFAULT_INTERVAL_MS);

  // Track active drain promise to prevent overlapping drains
  let activeDrain: Promise<void> | undefined;
  let stopped = false;

  const runDrain = async (): Promise<void> => {
    if (stopped) return;
    const result = await drainOnce(stateDir, eventStore);
    if (opts?.onDrain) {
      opts.onDrain(result);
    }
  };

  // Immediate drain: await one cycle before returning the handle
  if (opts?.immediate) {
    await runDrain();
  }

  // Set up periodic interval
  const timer = setInterval(() => {
    // Skip if a drain is already in progress or stopped
    if (stopped || activeDrain) return;
    activeDrain = runDrain().finally(() => { activeDrain = undefined; });
  }, interval);

  // unref so the timer doesn't keep the process alive
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ─── Drain Cycle ────────────────────────────────────────────────────────────

/**
 * Execute a single drain cycle: find sidecar files, rename them to drain
 * files, parse events, merge into EventStore, and unlink drain files.
 */
async function drainOnce(
  stateDir: string,
  eventStore: EventStore,
): Promise<DrainResult> {
  const start = Date.now();
  let totalMerged = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Step 1: Find sidecar files
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return { merged: 0, skipped: 0, errors: 0, durationMs: Date.now() - start };
  }

  const sidecarFiles = entries.filter((f) => f.endsWith(SIDECAR_SUFFIX));
  if (sidecarFiles.length === 0) {
    return { merged: 0, skipped: 0, errors: 0, durationMs: Date.now() - start };
  }

  for (const file of sidecarFiles) {
    const streamId = file.slice(0, -SIDECAR_SUFFIX.length);
    const sidecarPath = path.join(stateDir, file);

    // Step 2: Rename to drain file (atomic swap -- new sidecar writes go to a fresh file)
    const drainFile = file.replace(
      SIDECAR_SUFFIX,
      `.hook-events.drain-${process.pid}-${Date.now()}.jsonl`,
    );
    const drainPath = path.join(stateDir, drainFile);

    try {
      await fs.rename(sidecarPath, drainPath);
    } catch {
      // Sidecar may have been removed concurrently; skip
      continue;
    }

    // Step 3: Read and parse drain file
    let content: string;
    try {
      content = await fs.readFile(drainPath, 'utf-8');
    } catch {
      totalErrors++;
      continue;
    }

    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        totalErrors++;
        continue;
      }

      const type = parsed.type as string;
      const data = (parsed.data as Record<string, unknown>) ?? {};
      const timestamp = parsed.timestamp as string | undefined;
      const idempotencyKey = parsed.idempotencyKey as string | undefined;

      if (!type) {
        totalErrors++;
        continue;
      }

      // Step 4: Append to EventStore with idempotency protection
      try {
        const beforeEvents = await eventStore.query(streamId);
        const beforeSeq = beforeEvents.length;

        await eventStore.append(
          streamId,
          { type: type as WorkflowEvent['type'], data, timestamp },
          idempotencyKey ? { idempotencyKey } : undefined,
        );

        const afterEvents = await eventStore.query(streamId);
        const afterSeq = afterEvents.length;

        if (afterSeq > beforeSeq) {
          totalMerged++;
        } else {
          totalSkipped++;
        }
      } catch {
        totalErrors++;
      }
    }

    // Step 5: Unlink drain file after processing
    await fs.unlink(drainPath).catch(() => {});
  }

  return {
    merged: totalMerged,
    skipped: totalSkipped,
    errors: totalErrors,
    durationMs: Date.now() - start,
  };
}
