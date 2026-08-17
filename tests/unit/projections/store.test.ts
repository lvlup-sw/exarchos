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
 * Pre-#1343 these read/write/prune describe blocks tested the JSONL-sidecar
 * substrate that lived under `<stateDir>/<streamId>.projections.jsonl`.
 * Wave A's substrate cut deletes that file format outright; the equivalent
 * coverage now lives in the StorageBackend-delegation tests below
 * (`StorageBackend delegation (A3.1)`, `appendSnapshot backend delegation
 * (A3.2)`) and in `storage/__tests__/backend-contract.test.ts`. The
 * legacy describe blocks were removed in A3.3 as part of the dead-JSONL
 * cleanup.
 */
describe('projection snapshot store — streamId path-traversal guard', () => {
  // The streamId guard remains load-bearing post-substrate-cut: it's a
  // primary-key column on `projection_snapshots` that must be a stable,
  // opaque token (no path separators, no NULs, no relative-path escape
  // sequences). The check now lives in `assertStreamIdSafe` inside store.ts
  // rather than `getSnapshotSidecarPath` which was deleted with the JSONL
  // machinery.
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

// ─── A3.1 — readLatestSnapshot delegates to StorageBackend, no fs.readFileSync ──

/**
 * ProjectionsStore_ReadLatestSnapshot_ReturnsHighestSequenceMatching
 *
 * Verifies that readLatestSnapshot reads through the injected StorageBackend.
 * The "no filesystem read" assertion is a structural property of the new
 * impl: the wrapper only knows about the backend handle — it has no
 * filesystem code path to take. Coverage of the sidecar absence end-to-end
 * lives in the A3.2 size-cap test below, which scans the temp stateDir for
 * any `.projections.jsonl` artefact post-write.
 */
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

    // Seed directly into the backend (not the filesystem).
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

// ─── A3.2 — appendSnapshot delegates to StorageBackend, no .projections.jsonl file ──

/**
 * ProjectionsStore_AppendSnapshot_AppendsRecordAndEnforcesSizeCap
 *
 * Verifies that appendSnapshot writes through the injected StorageBackend
 * rather than creating .projections.jsonl files on disk.
 */
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

      // The backend should have the record with the highest sequence.
      const latest = backend.readLatestProjectionSnapshot(streamId, 'rehydration', 'v1');
      expect(latest).toBeDefined();
      expect(latest?.sequence).toBe(cap + 2);

      // Assert: no .projections.jsonl file created in stateDir.
      const files = fs.readdirSync(stateDir);
      const sidecarFiles = files.filter((f) => f.endsWith('.projections.jsonl'));
      expect(sidecarFiles).toHaveLength(0);

      // WARN on prune must have been emitted at least once.
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

// ─── Retirement boundary: what survived the `readProjection` removal ────────

/**
 * `readProjection` + `ReadProjectionOptions` + `InvalidReducerScopeError` were
 * removed from this module when `ProjectionScope` collapsed to `'stream'`. The
 * snapshot primitives are a SEPARATE, live surface — `appendSnapshot` has a
 * production caller at `workflow/tools.ts` (the per-stream rehydration
 * checkpoint), read back by `workflow/rehydrate.ts` and `projections/rebuild.ts`.
 *
 * This pins the boundary in both directions: the snapshot pair must still be
 * exported AND still round-trip, and the retired symbols must be gone. A
 * removal that over-reached (taking the snapshot pair with it) fails here
 * rather than in a distant rehydration test.
 */
describe('projection snapshot store — surface after readProjection removal', () => {
  it('ProjectionsStore_AfterRemoval_StillExposesSnapshotPrimitives', () => {
    // The surviving primitives are exported...
    expect(typeof projectionsStore.appendSnapshot).toBe('function');
    expect(typeof projectionsStore.readLatestSnapshot).toBe('function');
    // ...along with the retention re-exports consumers resolve from here.
    expect(typeof projectionsStore.resolveMaxRecords).toBe('function');
    expect(projectionsStore.DEFAULT_SNAPSHOT_MAX_RECORDS).toBeGreaterThan(0);

    // ...and they still round-trip a record through a backend.
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

    // The retired cross-stream surface is gone.
    expect('readProjection' in projectionsStore).toBe(false);
    expect('InvalidReducerScopeError' in projectionsStore).toBe(false);
  });
});
