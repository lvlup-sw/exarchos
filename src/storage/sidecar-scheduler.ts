/**
 * Drains sidecar files (`{streamId}.hook-events.jsonl`) into the main EventStore on an
 * interval, so a long-running primary process keeps no sidecar backlog.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';

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

/**
 * Starts a periodic drain of sidecar files into the EventStore.
 *
 * When `opts.immediate` is true, one best-effort drain runs before the function
 * returns. A tick does nothing while a drain runs. The timer is `unref`ed, so it does
 * not keep the process alive.
 *
 * @param stateDir   Directory that holds the sidecar files
 * @param eventStore EventStore that receives the events
 * @param intervalMs Drain interval in milliseconds. The default is `EXARCHOS_SIDECAR_DRAIN_INTERVAL_MS`, else 5000.
 * @returns A handle with a `stop()` method that cancels the periodic drain
 */
export async function startPeriodicMerge(
  stateDir: string,
  eventStore: EventStore,
  intervalMs?: number,
  opts?: PeriodicMergeOptions,
): Promise<PeriodicMergeHandle> {
  const interval = intervalMs ?? parseEnvInt('EXARCHOS_SIDECAR_DRAIN_INTERVAL_MS', DEFAULT_INTERVAL_MS);

  let activeDrain: Promise<void> | undefined;
  let stopped = false;

  const runDrain = async (): Promise<void> => {
    if (stopped) return;
    const result = await drainOnce(stateDir, eventStore);
    if (opts?.onDrain) {
      opts.onDrain(result);
    }
  };

  if (opts?.immediate) {
    await runDrain().catch(() => {});
  }

  const timer = setInterval(() => {
    if (stopped || activeDrain) return;
    activeDrain = runDrain().finally(() => { activeDrain = undefined; });
  }, interval);

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

/**
 * Runs one drain cycle. For each sidecar file, it renames the file to a drain file,
 * appends the events to the EventStore, and unlinks the drain file.
 *
 * The rename is a claim, not a publish, so it does not use `publishTempFile`. Each
 * drain path is unique per process and time. A failed rename means that another
 * drainer claimed the file. If the read fails, the drain file goes back to the
 * sidecar path. An append counts as merged when the stream grows, else as skipped.
 */
async function drainOnce(
  stateDir: string,
  eventStore: EventStore,
): Promise<DrainResult> {
  const start = Date.now();
  let totalMerged = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { merged: 0, skipped: 0, errors: 0, durationMs: Date.now() - start };
    }
    return { merged: 0, skipped: 0, errors: 1, durationMs: Date.now() - start };
  }

  const sidecarFiles = entries.filter((f) => f.endsWith(SIDECAR_SUFFIX));
  if (sidecarFiles.length === 0) {
    return { merged: 0, skipped: 0, errors: 0, durationMs: Date.now() - start };
  }

  for (const file of sidecarFiles) {
    const streamId = file.slice(0, -SIDECAR_SUFFIX.length);
    const sidecarPath = path.join(stateDir, file);

    const drainFile = file.replace(
      SIDECAR_SUFFIX,
      `.hook-events.drain-${process.pid}-${Date.now()}.jsonl`,
    );
    const drainPath = path.join(stateDir, drainFile);

    try {
      await fs.rename(sidecarPath, drainPath);
    } catch {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(drainPath, 'utf-8');
    } catch {
      await fs.rename(drainPath, sidecarPath).catch(() => {});
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

      try {
        const beforeEvents = await eventStore.query(streamId);
        const beforeSeq = beforeEvents.length;

        await eventStore.append(
          streamId,
          { type: type as WorkflowEvent['type'], data, ...(timestamp !== undefined ? { timestamp } : {}) },
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

    await fs.unlink(drainPath).catch(() => {});
  }

  return {
    merged: totalMerged,
    skipped: totalSkipped,
    errors: totalErrors,
    durationMs: Date.now() - start,
  };
}
