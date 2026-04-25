import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { storeLogger } from '../logger.js';
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

/**
 * T021 (DR-2, DR-18 resilience) — JSONL sidecar size cap with oldest-first
 * bounded pruning. When an append would push the sidecar past `maxRecords`,
 * the oldest records (by file order / sequence) are dropped so the file
 * retains exactly `maxRecords` lines. A single WARN is emitted per prune
 * event via the structured logger, including the count pruned.
 */
describe('projection snapshot store — size cap pruning', () => {
  const createdDirs: string[] = [];

  function makeStateDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-store-prune-'));
    createdDirs.push(dir);
    return dir;
  }

  function makeRecord(seq: number): SnapshotRecord {
    return {
      projectionId: 'rehydration',
      projectionVersion: '1.0.0',
      sequence: seq,
      state: { marker: `seq-${seq}` },
      timestamp: '2026-04-24T00:00:00.000Z',
    };
  }

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir !== undefined) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('SnapshotStore_ExceedsSizeCap_PrunesOldestBounded', () => {
    const stateDir = makeStateDir();
    const streamId = 'wf-T021-overflow';
    const cap = 5;
    const total = cap + 3; // 8 total appends, last 5 should remain

    const warnSpy = vi
      .spyOn(storeLogger, 'warn')
      .mockImplementation(() => undefined as never);

    try {
      for (let i = 1; i <= total; i++) {
        appendSnapshot(stateDir, streamId, makeRecord(i), { maxRecords: cap });
      }

      const target = path.join(stateDir, `${streamId}.projections.jsonl`);
      const contents = fs.readFileSync(target, 'utf8');
      expect(contents.endsWith('\n')).toBe(true);

      const lines = contents.split('\n');
      expect(lines.at(-1)).toBe('');
      const dataLines = lines.slice(0, -1);
      expect(dataLines).toHaveLength(cap);

      const sequences = dataLines.map(
        (line) => (JSON.parse(line) as SnapshotRecord).sequence,
      );
      // Oldest (1..3) pruned; most-recent `cap` (4..8) retained in order.
      expect(sequences).toEqual([4, 5, 6, 7, 8]);

      // At least one WARN emitted; one such call carries a prunedCount field.
      expect(warnSpy).toHaveBeenCalled();
      const pruneCalls = warnSpy.mock.calls.filter((call) => {
        const first = call[0];
        return (
          typeof first === 'object' &&
          first !== null &&
          'prunedCount' in (first as Record<string, unknown>)
        );
      });
      expect(pruneCalls.length).toBeGreaterThanOrEqual(1);
      const totalPruned = pruneCalls.reduce((sum, call) => {
        const bindings = call[0] as { prunedCount: number };
        return sum + bindings.prunedCount;
      }, 0);
      expect(totalPruned).toBe(total - cap);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('SnapshotStore_UnderSizeCap_NoPruning', () => {
    const stateDir = makeStateDir();
    const streamId = 'wf-T021-under-cap';
    const cap = 10;

    const warnSpy = vi
      .spyOn(storeLogger, 'warn')
      .mockImplementation(() => undefined as never);

    try {
      for (let i = 1; i <= cap - 1; i++) {
        appendSnapshot(stateDir, streamId, makeRecord(i), { maxRecords: cap });
      }

      const target = path.join(stateDir, `${streamId}.projections.jsonl`);
      const contents = fs.readFileSync(target, 'utf8');
      const dataLines = contents.split('\n').slice(0, -1);
      expect(dataLines).toHaveLength(cap - 1);

      const sequences = dataLines.map(
        (line) => (JSON.parse(line) as SnapshotRecord).sequence,
      );
      expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // No prune events emitted when under the cap.
      const pruneCalls = warnSpy.mock.calls.filter((call) => {
        const first = call[0];
        return (
          typeof first === 'object' &&
          first !== null &&
          'prunedCount' in (first as Record<string, unknown>)
        );
      });
      expect(pruneCalls).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('projection snapshot store — streamId path-traversal guard', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-snapshot-traversal-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const validRecord: SnapshotRecord = {
    projectionId: 'rehydration',
    projectionVersion: 'v1',
    sequence: 1,
    state: {},
    timestamp: '2026-04-25T00:00:00.000Z',
  };

  // Both read and write call sites interpolate `streamId` into a filename;
  // a `..`/separator-bearing id must be rejected before it reaches the
  // filesystem so the projection sidecar can never escape `stateDir`.
  for (const unsafe of [
    '..',
    '../escape',
    'subdir/leak',
    'win\\style\\path',
    '',
    'with\0null',
  ]) {
    it(`SnapshotStore_RejectsUnsafeStreamId_${JSON.stringify(unsafe)}_OnRead`, () => {
      expect(() =>
        readLatestSnapshot(stateDir, unsafe, 'rehydration', 'v1'),
      ).toThrow(/Invalid streamId/);
    });

    it(`SnapshotStore_RejectsUnsafeStreamId_${JSON.stringify(unsafe)}_OnWrite`, () => {
      expect(() => appendSnapshot(stateDir, unsafe, validRecord)).toThrow(
        /Invalid streamId/,
      );
    });
  }
});
