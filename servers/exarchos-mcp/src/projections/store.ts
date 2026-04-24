import * as fs from 'node:fs';
import * as path from 'node:path';
import { SnapshotRecord } from './snapshot-schema.js';
import type { SnapshotRecord as SnapshotRecordType } from './snapshot-schema.js';

/**
 * Projection snapshot store — JSONL sidecar reader (DR-2, §5.2).
 *
 * Sidecar file: `<stateDir>/<streamId>.projections.jsonl`
 * Each line is a JSON-encoded {@link SnapshotRecord}. Lines that fail schema
 * validation, fail JSON parsing, or whose `projectionId` / `projectionVersion`
 * do not match the request are skipped. The record with the highest `sequence`
 * among matching lines is returned. If the file is missing or no line matches,
 * returns `undefined`.
 */
export function readLatestSnapshot(
  stateDir: string,
  streamId: string,
  projectionId: string,
  projectionVersion: string,
): SnapshotRecordType | undefined {
  const sidecar = path.join(stateDir, `${streamId}.projections.jsonl`);

  let raw: string;
  try {
    raw = fs.readFileSync(sidecar, 'utf8');
  } catch (err: unknown) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }

  let latest: SnapshotRecordType | undefined;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      continue; // Skip malformed JSON — forward-compatible with partial writes.
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

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}
