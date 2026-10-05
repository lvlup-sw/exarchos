/**
 * `ViewMaterializer` skips `__`-prefixed sentinel streams.
 *
 * The event store writes progress events to sentinel streams such as `__migration__`.
 * `SnapshotStore` accepts only stream ids that match `/^[a-z0-9-]+$/`, so a sentinel id that
 * reaches it throws. The first suite checks that `materialize` and `loadFromSnapshot` pass no
 * sentinel id to the snapshot store. The second suite checks that `handleViewPipeline` succeeds
 * when a `__migration__` stream exists next to a normal stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ViewMaterializer, type ViewProjection } from '../../../../src/projections/views/materializer.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import { handleViewPipeline, resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const counterProjection: ViewProjection<number> = {
  init: () => 0,
  apply: (view: number, _event: WorkflowEvent) => view + 1,
};

function makeEvent(sequence: number, streamId: string): WorkflowEvent {
  return {
    streamId,
    sequence,
    timestamp: new Date().toISOString(),
    type: 'workflow.started',
    schemaVersion: '1.0',
    data: {},
  } as WorkflowEvent;
}

describe('ViewMaterializer_IteratesStreams_SkipsDunderPrefixedSentinels', () => {
  const VIEW_NAME = 'counter';

  /**
   * `snapshotInterval: 1` makes each event start a save, so a missing sentinel guard shows as a
   * `save` call for `__migration__`. The sentinel stream also gets no cache entry.
   */
  it('does not pass __-prefixed streamIds into SnapshotStore.save', () => {
    const snapshotStore = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const materializer = new ViewMaterializer({
      snapshotStore,
      snapshotInterval: 1,
    });
    materializer.register(VIEW_NAME, counterProjection);

    materializer.materialize('my-feature', VIEW_NAME, [
      makeEvent(1, 'my-feature'),
    ]);

    expect(() =>
      materializer.materialize('__migration__', VIEW_NAME, [
        makeEvent(1, '__migration__'),
      ]),
    ).not.toThrow();

    expect(snapshotStore.save).toHaveBeenCalledWith(
      'my-feature',
      VIEW_NAME,
      expect.anything(),
      expect.any(Number),
    );
    const sentinelCall = snapshotStore.save.mock.calls.find(
      (c) => c[0] === '__migration__',
    );
    expect(sentinelCall).toBeUndefined();

    expect(materializer.getState('__migration__', VIEW_NAME)).toBeUndefined();
    expect(materializer.getState('my-feature', VIEW_NAME)).toBeDefined();
  });

  it('loadFromSnapshot returns false for __-prefixed streams without touching the snapshot store', async () => {
    const snapshotStore = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({
        view: 1,
        highWaterMark: 1,
        savedAt: '2026-05-17T00:00:00Z',
        schemaVersion: '1.0',
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const materializer = new ViewMaterializer({ snapshotStore });
    materializer.register(VIEW_NAME, counterProjection);

    const loaded = await materializer.loadFromSnapshot('__migration__', VIEW_NAME);

    expect(loaded).toBe(false);
    expect(snapshotStore.load).not.toHaveBeenCalled();
  });
});

describe('ExarchosView_Pipeline_DoesNotCrashOnMigrationStream', () => {
  let tempDir: string;
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'view-pipeline-t2-'));
    stateDir = tempDir;
    store = new EventStore(tempDir);
    resetMaterializerCache();
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tempDir);
  });

  /** `__migration__` is the stream where the V5 to V6 backfill in `migrateV5ToV6` writes its progress events. */
  it('returns a success envelope when __migration__ exists alongside a normal stream', async () => {
    const featureId = 'my-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    await store.append('__migration__', {
      type: 'state.patched',
      data: { featureId: '__migration__', fields: [], patch: {} },
    });

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      expect(result.error?.message).not.toContain('Invalid streamId');
    }
  });
});
