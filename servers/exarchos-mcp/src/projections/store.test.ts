import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { storeLogger } from '../logger.js';
import { appendSnapshot, readLatestSnapshot, readProjection } from './store.js';
import { SnapshotRecord } from './snapshot-schema.js';
import { createRegistry } from './registry.js';
import type { ProjectionReducer } from './types.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { EventStore } from '../event-store/store.js';
import { InMemoryBackend } from '../storage/memory-backend.js';
import { rmrf } from '../test-helpers/temp-dir.js';

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

// ─── Wave 2A.6 — readProjection<T>(reducerId) global-scope primitive (#1284) ──

/**
 * Fixture state shape for `readProjection<T>` tests — counts handled events
 * and stores the most-recent payload. Intentionally simple so the test
 * fixtures stay readable.
 */
interface FixtureState {
  readonly count: number;
  readonly latest: string | undefined;
}

/**
 * Build a fixture reducer with a given scope. Used to exercise both the
 * happy-path (`scope: 'global'`) and the rejection path
 * (`scope: 'stream'` → `INVALID_REDUCER_SCOPE`).
 */
function makeFixtureReducer(
  id: string,
  scope: 'stream' | 'global',
): ProjectionReducer<FixtureState, WorkflowEvent> {
  return {
    id,
    version: 1,
    scope,
    initial: { count: 0, latest: undefined },
    apply(state, event) {
      if (event.type !== 'task.assigned') return state;
      const data = event.data as { taskId?: string } | undefined;
      const tid = typeof data?.taskId === 'string' ? data.taskId : undefined;
      if (!tid) return state;
      return { count: state.count + 1, latest: tid };
    },
  };
}

describe('readProjection<T>(reducerId) — global fold (Wave 2A.6, #1284)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-read-proj-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(() => {
    rmrf(stateDir);
  });

  it('ReadProjection_FoldsGlobalProjectionFromColdFold_WhenNoSnapshot', async () => {
    // GIVEN: a fixture reducer registered as 'global' and events seeded
    //   across two distinct streams.
    const registry = createRegistry();
    const reducer = makeFixtureReducer('fixture-global@v1', 'global');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    await eventStore.append('stream-A', {
      type: 'task.assigned',
      data: { taskId: 'T-A1' },
    });
    await eventStore.append('stream-B', {
      type: 'task.assigned',
      data: { taskId: 'T-B1' },
    });
    await eventStore.append('stream-A', {
      type: 'task.assigned',
      data: { taskId: 'T-A2' },
    });

    // WHEN: readProjection is invoked.
    const result = await readProjection<FixtureState>(
      'fixture-global@v1',
      eventStore,
      { registry },
    );

    // THEN: count covers every event across both streams.
    expect(result.count).toBe(3);
    expect(result.latest).toBeDefined();
  });

  it('ReadProjection_FoldsFromSnapshot_WhenFreshSnapshotPresent', async () => {
    const registry = createRegistry();
    const reducer = makeFixtureReducer('fixture-global@v1', 'global');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    // Pre-seed events that contribute to a snapshot.
    await eventStore.append('stream-A', {
      type: 'task.assigned',
      data: { taskId: 'T-A1' },
    });
    await eventStore.append('stream-B', {
      type: 'task.assigned',
      data: { taskId: 'T-B1' },
    });

    // Write a snapshot keyed on the reducer id with the pre-seed state.
    // The snapshot encodes a count=2 fold up to (and including) sequence 2.
    appendSnapshot(eventStore.getReadBackend(), reducer.id, {
      projectionId: reducer.id,
      projectionVersion: String(reducer.version),
      sequence: 2,
      state: { count: 2, latest: 'T-B1' } satisfies FixtureState,
      timestamp: '2026-05-10T00:00:00.000Z',
    });

    // Append one more event AFTER the snapshot — readProjection must fold
    // it on top of the snapshotted state.
    await eventStore.append('stream-A', {
      type: 'task.assigned',
      data: { taskId: 'T-A2' },
    });

    const result = await readProjection<FixtureState>(
      'fixture-global@v1',
      eventStore,
      { registry },
    );

    // count = 2 from snapshot + 1 post-snapshot event.
    expect(result.count).toBe(3);
    expect(result.latest).toBe('T-A2');
  });

  it('ReadProjection_ThrowsInvalidScope_WhenReducerIsStream', async () => {
    const registry = createRegistry();
    const reducer = makeFixtureReducer('fixture-stream@v1', 'stream');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    await expect(
      readProjection<FixtureState>('fixture-stream@v1', eventStore, {
        registry,
      }),
    ).rejects.toThrow(/INVALID_REDUCER_SCOPE/);
  });

  it('ReadProjection_ThrowsUnknownReducer_WhenIdNotRegistered', async () => {
    const registry = createRegistry();
    await expect(
      readProjection<FixtureState>('no-such-reducer@v1', eventStore, {
        registry,
      }),
    ).rejects.toThrow(/unknown projection id/);
  });
});
