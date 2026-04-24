import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLatestSnapshot } from './store.js';
import type { SnapshotRecord } from './snapshot-schema.js';

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
    // Write in "older, newer" order; reader must pick by sequence, not file order.
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
      sequence: 99, // higher sequence, but wrong version — must be skipped
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
