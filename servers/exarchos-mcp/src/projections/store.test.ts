import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendSnapshot, readLatestSnapshot } from './store.js';
import { SnapshotRecord } from './snapshot-schema.js';

/**
 * DR-2 (§5.2 Snapshot storage and invalidation) — JSONL sidecar reader.
 * Sidecar path: `<stateDir>/<streamId>.projections.jsonl`
 */
describe('projection snapshot store — read', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-snapshot-store-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function writeSidecar(streamId: string, records: SnapshotRecord[]): void {
    const file = path.join(stateDir, `${streamId}.projections.jsonl`);
    const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(file, body, 'utf8');
  }

  it('SnapshotStore_LatestForProjection_ReturnsMostRecent', () => {
    const streamId = 'wf-123';
    const older: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: 'v1',
      sequence: 10,
      state: { phase: 'red' },
      timestamp: '2026-04-24T10:00:00.000Z',
    };
    const newer: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: 'v1',
      sequence: 42,
      state: { phase: 'green' },
      timestamp: '2026-04-24T12:00:00.000Z',
    };
    writeSidecar(streamId, [older, newer]);

    const got = readLatestSnapshot(stateDir, streamId, 'rehydration', 'v1');

    expect(got).toBeDefined();
    expect(got?.sequence).toBe(42);
    expect(got?.state).toEqual({ phase: 'green' });
  });

  it('SnapshotStore_VersionMismatch_Ignored', () => {
    const streamId = 'wf-456';
    const wrongVersion: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: 'v0',
      sequence: 99,
      state: { phase: 'ancient' },
      timestamp: '2026-04-24T09:00:00.000Z',
    };
    const matchingVersion: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: 'v1',
      sequence: 7,
      state: { phase: 'current' },
      timestamp: '2026-04-24T11:00:00.000Z',
    };
    writeSidecar(streamId, [wrongVersion, matchingVersion]);

    const got = readLatestSnapshot(stateDir, streamId, 'rehydration', 'v1');

    expect(got).toBeDefined();
    expect(got?.projectionVersion).toBe('v1');
    expect(got?.sequence).toBe(7);
    expect(got?.state).toEqual({ phase: 'current' });
  });

  it('SnapshotStore_NoMatchingVersion_ReturnsUndefined', () => {
    const streamId = 'wf-789';
    const onlyWrong: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: 'v0',
      sequence: 5,
      state: {},
      timestamp: '2026-04-24T08:00:00.000Z',
    };
    writeSidecar(streamId, [onlyWrong]);

    expect(readLatestSnapshot(stateDir, streamId, 'rehydration', 'v1')).toBeUndefined();
  });

  it('SnapshotStore_MissingFile_ReturnsUndefined', () => {
    expect(readLatestSnapshot(stateDir, 'nonexistent-stream', 'rehydration', 'v1')).toBeUndefined();
  });
});

/**
 * T020 (DR-2) — JSONL sidecar writer atomic-append contract:
 *   - exactly one newline-terminated line per append
 *   - no `.tmp` leftover after a successful append
 *   - concurrent appends never produce partial/interleaved lines; every
 *     resulting line parses via the T004 SnapshotRecord schema.
 */
describe('projection snapshot store — write', () => {
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

  it('SnapshotStore_Write_AtomicTempRename', () => {
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

    expect(contents.endsWith('\n')).toBe(true);
    const lines = contents.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');

    const parsed = SnapshotRecord.parse(JSON.parse(lines[0]!));
    expect(parsed).toEqual(record);

    const entries = fs.readdirSync(stateDir);
    const leftovers = entries.filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('SnapshotStore_ConcurrentWrite_NoCorruption', async () => {
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

    expect(contents.endsWith('\n')).toBe(true);

    const lines = contents.split('\n');
    expect(lines.at(-1)).toBe('');
    const dataLines = lines.slice(0, -1);

    for (const line of dataLines) {
      expect(() => SnapshotRecord.parse(JSON.parse(line))).not.toThrow();
    }

    const entries = fs.readdirSync(stateDir);
    const leftovers = entries.filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
