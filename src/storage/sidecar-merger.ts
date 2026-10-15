/**
 * Merges hook-event sidecar files (`{streamId}.hook-events.jsonl`) into the main
 * EventStore at startup. CLI hook subprocesses write these files. A sidecar line
 * is a generic write, so the merge refuses each type that the generic append refuses.
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

/**
 * Tells whether the generic append refuses an event type. The caller supplies the check from the
 * reserved append registry, so the storage layer does not import the registry.
 */
export type ReservedEventTypeCheck = (eventType: string) => boolean;

const SIDECAR_SUFFIX = '.hook-events.jsonl';

/**
 * Merges each `*.hook-events.jsonl` file in `stateDir` into the EventStore, and then deletes the
 * file. The EventStore drops a repeated idempotency key. A corrupt line, or a line of a reserved
 * type, appends no row and counts in `errors`. The other lines of the file still merge.
 */
export async function mergeSidecarEvents(
  stateDir: string,
  eventStore: EventStore,
  isReservedType: ReservedEventTypeCheck,
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
      isReservedType,
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
 * when the stream grows, and as skipped when idempotency drops it. A line of a
 * reserved type counts as an error and appends no row.
 */
async function mergeOneSidecar(
  filePath: string,
  streamId: string,
  eventStore: EventStore,
  isReservedType: ReservedEventTypeCheck,
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

    if (!type || isReservedType(type)) {
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
