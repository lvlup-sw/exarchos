import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { storeLogger } from '../../../src/logger.js';
import { appendSnapshot, readLatestSnapshot } from '../../../src/projections/store.js';
import * as projectionsStore from '../../../src/projections/store.js';
import { SnapshotRecord } from '../../../src/projections/snapshot-schema.js';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The stream id is a primary-key column of `projection_snapshots`, so it must be an opaque token.
 * Each read and each append rejects an id that is empty or holds `..`, a slash, a backslash or a NUL character.
 */
describe('projection snapshot store — streamId path-traversal guard', () => {
  const validRecord: SnapshotRecord = {
    projectionId: 'rehydration',
    projectionVersion: 'v1',
    sequence: 1,
    state: {},
    timestamp: '2026-04-25T00:00:00.000Z',
  };

  for (const unsafe of [
    '..',
    '../escape',
    'subdir/leak',
    'win\\style\\path',
    '',
    'with\0null',
  ]) {
    it(`SnapshotStore_RejectsUnsafeStreamId_${JSON.stringify(unsafe)}_OnRead`, () => {
      const backend = new InMemoryBackend();
      expect(() =>
        readLatestSnapshot(backend, unsafe, 'rehydration', 'v1'),
      ).toThrow(/Invalid streamId/);
    });

    it(`SnapshotStore_RejectsUnsafeStreamId_${JSON.stringify(unsafe)}_OnWrite`, () => {
      const backend = new InMemoryBackend();
      expect(() => appendSnapshot(backend, unsafe, validRecord)).toThrow(
        /Invalid streamId/,
      );
    });
  }
});

/** `readLatestSnapshot` reads through the injected `StorageBackend`, not from the filesystem. */
describe('projection snapshot store — StorageBackend delegation (A3.1)', () => {
  it('ProjectionsStore_ReadLatestSnapshot_ReturnsHighestSequenceMatching', () => {
    const backend = new InMemoryBackend();
    const streamId = 'wf-backend-read';
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

    backend.appendProjectionSnapshot(streamId, older);
    backend.appendProjectionSnapshot(streamId, newer);

    const got = readLatestSnapshot(backend, streamId, 'rehydration', 'v1');

    expect(got).toBeDefined();
    expect(got?.sequence).toBe(42);
    expect(got?.state).toEqual({ phase: 'green' });
  });

  it('ProjectionsStore_ReadLatestSnapshot_ReturnsUndefined_WhenNoRecords', () => {
    const backend = new InMemoryBackend();
    const got = readLatestSnapshot(backend, 'no-such-stream', 'rehydration', 'v1');
    expect(got).toBeUndefined();
  });

  it('ProjectionsStore_ReadLatestSnapshot_SkipsVersionMismatch', () => {
    const backend = new InMemoryBackend();
    const streamId = 'wf-version-mismatch';
    backend.appendProjectionSnapshot(streamId, {
      projectionId: 'rehydration',
      projectionVersion: 'v0',
      sequence: 99,
      state: { phase: 'ancient' },
      timestamp: '2026-04-24T09:00:00.000Z',
    });
    backend.appendProjectionSnapshot(streamId, {
      projectionId: 'rehydration',
      projectionVersion: 'v1',
      sequence: 7,
      state: { phase: 'current' },
      timestamp: '2026-04-24T11:00:00.000Z',
    });
    const got = readLatestSnapshot(backend, streamId, 'rehydration', 'v1');
    expect(got?.projectionVersion).toBe('v1');
    expect(got?.sequence).toBe(7);
  });

  it('ProjectionsStore_ReadLatestSnapshot_StillRejectsUnsafeStreamId', () => {
    const backend = new InMemoryBackend();
    expect(() =>
      readLatestSnapshot(backend, '../escape', 'rehydration', 'v1'),
    ).toThrow(/Invalid streamId/);
  });
});

/** `appendSnapshot` writes through the injected `StorageBackend`, and logs a warning when the backend prunes. */
describe('projection snapshot store — appendSnapshot backend delegation (A3.2)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-a32-'));
  });

  afterEach(() => {
    rmrf(stateDir);
  });

  it('ProjectionsStore_AppendSnapshot_AppendsRecordAndEnforcesSizeCap', () => {
    const backend = new InMemoryBackend();
    const streamId = 'wf-backend-write';
    const warnSpy = vi.spyOn(storeLogger, 'warn').mockImplementation(() => undefined as never);

    try {
      const cap = 3;
      for (let i = 1; i <= cap + 2; i++) {
        appendSnapshot(backend, streamId, {
          projectionId: 'rehydration',
          projectionVersion: 'v1',
          sequence: i,
          state: { seq: i },
          timestamp: '2026-04-24T00:00:00.000Z',
        }, { maxRecords: cap });
      }

      const latest = backend.readLatestProjectionSnapshot(streamId, 'rehydration', 'v1');
      expect(latest).toBeDefined();
      expect(latest?.sequence).toBe(cap + 2);

      const files = fs.readdirSync(stateDir);
      const sidecarFiles = files.filter((f) => f.endsWith('.projections.jsonl'));
      expect(sidecarFiles).toHaveLength(0);

      const pruneCalls = warnSpy.mock.calls.filter((call) => {
        const first = call[0];
        return (
          typeof first === 'object' &&
          first !== null &&
          'prunedCount' in (first as Record<string, unknown>)
        );
      });
      expect(pruneCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ProjectionsStore_AppendSnapshot_StillRejectsUnsafeStreamId', () => {
    const backend = new InMemoryBackend();
    const record: SnapshotRecord = {
      projectionId: 'rehydration',
      projectionVersion: 'v1',
      sequence: 1,
      state: {},
      timestamp: '2026-04-25T00:00:00.000Z',
    };
    expect(() => appendSnapshot(backend, '../escape', record)).toThrow(/Invalid streamId/);
  });
});

/**
 * Pins the module surface in both directions. `appendSnapshot` and `readLatestSnapshot` have
 * production callers, so the module must export them and they must round-trip a record. The
 * module must not export `readProjection` or `InvalidReducerScopeError`.
 */
describe('projection snapshot store — surface after readProjection removal', () => {
  it('ProjectionsStore_AfterRemoval_StillExposesSnapshotPrimitives', () => {
    expect(typeof projectionsStore.appendSnapshot).toBe('function');
    expect(typeof projectionsStore.readLatestSnapshot).toBe('function');
    expect(typeof projectionsStore.resolveMaxRecords).toBe('function');
    expect(projectionsStore.DEFAULT_SNAPSHOT_MAX_RECORDS).toBeGreaterThan(0);

    const backend = new InMemoryBackend();
    const streamId = 'wf-surface-check';
    const record: SnapshotRecord = {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 7,
      state: { hello: 'world' },
      timestamp: '2026-07-15T00:00:00.000Z',
    };
    appendSnapshot(backend, streamId, record);
    const read = readLatestSnapshot(backend, streamId, 'rehydration@v1', '1');
    expect(read).toBeDefined();
    expect(read?.sequence).toBe(7);
    expect(read?.state).toEqual({ hello: 'world' });

    expect('readProjection' in projectionsStore).toBe(false);
    expect('InvalidReducerScopeError' in projectionsStore).toBe(false);
  });
});
