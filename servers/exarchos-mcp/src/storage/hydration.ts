import { createReadStream } from 'node:fs';
import { readdir, access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { WorkflowEventBase, type WorkflowEvent } from '../event-store/schemas.js';
import type { StorageBackend } from './backend.js';

/** Pre-compiled regex for extracting the sequence number from a JSONL line before JSON.parse. */
const SEQUENCE_REGEX = /"sequence":(\d+)/;

/**
 * Hydrates a single event stream from a JSONL file into the storage backend.
 *
 * Reads `{stateDir}/{streamId}.events.jsonl` and inserts only events
 * with sequence > current backend sequence (delta hydration).
 * Corrupt or invalid JSON lines are skipped.
 */
export async function hydrateStream(
  backend: StorageBackend,
  stateDir: string,
  streamId: string,
): Promise<void> {
  const filePath = path.join(stateDir, `${streamId}.events.jsonl`);

  // Guard: if file doesn't exist, no-op; rethrow non-ENOENT errors
  try {
    await access(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const dbSequence = backend.getSequence(streamId);

  const input = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    // Fast skip: extract sequence via regex before JSON.parse
    if (dbSequence > 0) {
      const seqMatch = SEQUENCE_REGEX.exec(line);
      if (seqMatch) {
        const lineSequence = parseInt(seqMatch[1], 10);
        if (!isNaN(lineSequence) && lineSequence <= dbSequence) {
          continue;
        }
      }
    }

    // Parse the line — skip corrupt lines
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    // Validate against schema — skip invalid events
    const parsed = WorkflowEventBase.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    const event: WorkflowEvent = parsed.data;

    // Double-check sequence after parsing (in case regex matched wrong field)
    if (event.sequence <= dbSequence) {
      continue;
    }

    // Stream-append: insert immediately instead of buffering
    backend.appendEvent(streamId, event);
  }
}

/**
 * Discovers all `*.events.jsonl` files in stateDir and hydrates each stream.
 */
export async function hydrateAll(
  backend: StorageBackend,
  stateDir: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const jsonlFiles = files.filter((f) => f.endsWith('.events.jsonl'));

  for (const file of jsonlFiles) {
    const streamId = file.replace('.events.jsonl', '');
    await hydrateStream(backend, stateDir, streamId);
  }
}
