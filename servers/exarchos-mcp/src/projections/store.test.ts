/**
 * Snapshot store — JSONL sidecar writer (T020, DR-2).
 *
 * These tests pin the atomic-append contract for the projection snapshot
 * sidecar located at `<stateDir>/<streamId>.projections.jsonl`:
 *   - exactly one newline-terminated line per append
 *   - no `.tmp` leftover after a successful append
 *   - concurrent appends never produce partial/interleaved lines; every
 *     resulting line parses via the T004 {@link SnapshotRecord} schema.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendSnapshot } from './store.js';
import { SnapshotRecord } from './snapshot-schema.js';

const createdDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-store-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('SnapshotStore_Write_AtomicTempRename', () => {
  it('appends one newline-terminated JSON line and leaves no .tmp file behind', () => {
    const stateDir = makeStateDir();
    const streamId = 'wf-T020-atomic';
    const record: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: '1.0.0',
      sequence: 7,
      state: { phase: 'implement', tasks: ['T020'] },
      timestamp: '2026-04-24T00:00:00.000Z',
    };

    appendSnapshot(stateDir, streamId, record);

    const target = path.join(stateDir, `${streamId}.projections.jsonl`);
    const contents = fs.readFileSync(target, 'utf8');

    // Exactly one newline-terminated line
    expect(contents.endsWith('\n')).toBe(true);
    const lines = contents.split('\n');
    // split produces a trailing empty string after the final newline
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');

    // Line round-trips through the T004 schema
    const parsed = SnapshotRecord.parse(JSON.parse(lines[0]!));
    expect(parsed).toEqual(record);

    // No leftover temp file (starts with target basename, ends with .tmp)
    const entries = fs.readdirSync(stateDir);
    const leftovers = entries.filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('SnapshotStore_ConcurrentWrite_NoCorruption', () => {
  it('concurrent appends produce valid JSONL — every line parses, no partials', async () => {
    const stateDir = makeStateDir();
    const streamId = 'wf-T020-concurrent';
    const baseRecord = (seq: number): SnapshotRecord => ({
      projectionId: 'rehydration',
      projectionVersion: '1.0.0',
      sequence: seq,
      state: { marker: `seq-${seq}`, payload: 'x'.repeat(256) },
      timestamp: '2026-04-24T00:00:00.000Z',
    });

    const writes = Array.from({ length: 12 }, (_unused, i) =>
      Promise.resolve().then(() => appendSnapshot(stateDir, streamId, baseRecord(i))),
    );
    await Promise.all(writes);

    const target = path.join(stateDir, `${streamId}.projections.jsonl`);
    const contents = fs.readFileSync(target, 'utf8');

    // File must end in a terminating newline — no dangling partial line
    expect(contents.endsWith('\n')).toBe(true);

    const lines = contents.split('\n');
    // trailing empty string after final newline
    expect(lines.at(-1)).toBe('');
    const dataLines = lines.slice(0, -1);

    // Every retained line parses via the T004 schema (no partials/interleave)
    for (const line of dataLines) {
      expect(() => SnapshotRecord.parse(JSON.parse(line))).not.toThrow();
    }

    // No leftover .tmp sidecars
    const entries = fs.readdirSync(stateDir);
    const leftovers = entries.filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
