/**
 * Merges hook-event sidecar files (`{streamId}.hook-events.jsonl`) into the main
 * EventStore at startup. CLI hook subprocesses write these files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';

export interface MergeResult {
  readonly merged: number;
  readonly skipped: number;
  readonly errors: number;
}

const SIDECAR_SUFFIX = '.hook-events.jsonl';

/**
 * Scan stateDir for `*.hook-events.jsonl` files and merge each into the
 * EventStore. Events with idempotency keys are deduplicated automatically
 * by the EventStore. Corrupt JSON lines are skipped with an error count.
 *
 * Sidecar files are deleted after successful processing (even if some
 * lines were corrupt — the valid ones are merged and corrupt ones are
 * counted in `errors`).
 */
export async function mergeSidecarEvents(
  stateDir: string,
  eventStore: EventStore,
): Promise<MergeResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return { merged: 0, skipped: 0, errors: 0 };
  }

  const sidecarFiles = entries.filter((f) => f.endsWith(SIDECAR_SUFFIX));
  if (sidecarFiles.length === 0) {
    return { merged: 0, skipped: 0, errors: 0 };
  }

  let totalMerged = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const file of sidecarFiles) {
    const streamId = file.slice(0, -SIDECAR_SUFFIX.length);
    const filePath = path.join(stateDir, file);

    const { merged, skipped, errors } = await mergeOneSidecar(
      filePath,
      streamId,
      eventStore,
    );

    totalMerged += merged;
    totalSkipped += skipped;
    totalErrors += errors;

    await fs.unlink(filePath).catch(() => {});
  }

  return { merged: totalMerged, skipped: totalSkipped, errors: totalErrors };
}

/**
 * Append each line of one sidecar file to the EventStore. A line counts as merged
 * when the stream grows, and as skipped when idempotency drops it.
 */
async function mergeOneSidecar(
  filePath: string,
  streamId: string,
  eventStore: EventStore,
): Promise<MergeResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { merged: 0, skipped: 0, errors: 0 };
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { merged: 0, skipped: 0, errors: 0 };
  }

  let merged = 0;
  let skipped = 0;
  let errors = 0;

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      errors++;
      continue;
    }

    const type = parsed.type as string;
    const data = (parsed.data as Record<string, unknown>) ?? {};
    const timestamp = parsed.timestamp as string | undefined;
    const idempotencyKey = parsed.idempotencyKey as string | undefined;

    if (!type) {
      errors++;
      continue;
    }

    try {
      const beforeSeq = await getStreamSequence(eventStore, streamId);
      await eventStore.append(
        streamId,
        { type: type as WorkflowEvent['type'], data, ...(timestamp !== undefined ? { timestamp } : {}) },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      const afterSeq = await getStreamSequence(eventStore, streamId);

      if (afterSeq > beforeSeq) {
        merged++;
      } else {
        skipped++;
      }
    } catch {
      errors++;
    }
  }

  return { merged, skipped, errors };
}

async function getStreamSequence(
  eventStore: EventStore,
  streamId: string,
): Promise<number> {
  const events = await eventStore.query(streamId);
  return events.length;
}
