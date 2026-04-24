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

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SnapshotRecord } from './snapshot-schema.js';

export function readLatestSnapshot(
  stateDir: string,
  streamId: string,
  projectionId: string,
  projectionVersion: string,
): SnapshotRecord | undefined {
  const sidecar = path.join(stateDir, `${streamId}.projections.jsonl`);

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
 * @param stateDir  Directory containing per-stream sidecars; created if absent.
 * @param streamId  Workflow stream identifier — forms the sidecar basename.
 * @param record    Snapshot record to append.
 */
export function appendSnapshot(
  stateDir: string,
  streamId: string,
  record: SnapshotRecord,
): void {
  fs.mkdirSync(stateDir, { recursive: true });

  const target = path.join(stateDir, `${streamId}.projections.jsonl`);
  const existing = readIfExists(target);
  const line = `${JSON.stringify(record)}\n`;
  atomicWriteFile(target, existing + line);
}

function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup — don't mask the original error */
    }
    throw err;
  }
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
