/**
 * Projection snapshot store — JSONL sidecar writer (T020, DR-2).
 *
 * Writes are append-only to `<stateDir>/<streamId>.projections.jsonl`.
 * Each record is serialized as a single newline-terminated JSON line.
 *
 * Durability contract:
 *   - Read the existing sidecar (if any), append the new JSONL line,
 *     and stage the complete payload to `<target>.<pid>.<random>.tmp`.
 *   - `fsync` the tmp file before renaming over the target so a crash
 *     cannot leave a torn tail.
 *   - `rename` is atomic on POSIX and provides "all-or-nothing" semantics
 *     at the file level, giving us atomic append as observed by readers.
 *
 * Concurrency caveat: this module is intended for a single-writer process.
 * Cross-process concurrency is out of scope for T020; intra-process
 * concurrent callers remain safe because each `appendSnapshot` call
 * performs a self-contained read-modify-write under a rename barrier.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SnapshotRecord } from './snapshot-schema.js';

/**
 * Append a {@link SnapshotRecord} to the per-stream projections sidecar.
 *
 * @param stateDir  Directory containing per-stream sidecars; created if absent.
 * @param streamId  Workflow stream identifier — forms the sidecar basename.
 * @param record    Snapshot record to append (T004 schema).
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
  const payload = existing + line;

  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err: unknown) {
    // Best-effort cleanup — don't mask the original error.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
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
