/**
 * T2 — sentinel-stream skip in `ViewMaterializer` (closes #1434).
 *
 * Today `exarchos_view {action: 'pipeline'}` crashes on a clean install when a
 * `__migration__` stream exists in the event store, because
 * `SnapshotStore.getSnapshotPath` rejects any streamId that does not match the
 * kebab-only `SAFE_ID_PATTERN = /^[a-z0-9-]+$/`. The event store legitimately
 * writes progress events to `__`-prefixed sentinel streams (e.g. the v5→v6
 * backfill in `migrateV5ToV6`), and the pipeline view's stream-iteration path
 * forwards every discovered streamId into `materialize`, which then tries to
 * persist a snapshot.
 *
 * Fix (#1434 option a): skip `__`-prefixed sentinel streams at the materializer
 * level. Narrower than relaxing `SAFE_ID_PATTERN` (option b — explicitly
 * rejected); preserves the kebab-only constraint for user-facing featureIds.
 *
 * Test A pins the unit-level guarantee: `materialize` must NOT pass a
 * `__`-prefixed streamId to `SnapshotStore.save` (the call site that
 * transitively invokes `getSnapshotPath`).
 *
 * Test B pins the end-to-end UX bug: `handleViewPipeline` must return a
 * success envelope when a `__migration__` stream is present alongside a
 * normal user-facing stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ViewMaterializer, type ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { EventStore } from '../../events/store.js';
import { handleViewPipeline, resetMaterializerCache } from './tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── Test A — Unit: materializer skips __-prefixed streams ──────────────────

describe('ViewMaterializer_IteratesStreams_SkipsDunderPrefixedSentinels', () => {
  const VIEW_NAME = 'counter';

  it('does not pass __-prefixed streamIds into SnapshotStore.save', () => {
    const snapshotStore = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    // snapshotInterval=1 forces a save attempt on every event so the
    // assertion below is sensitive — without the sentinel guard,
    // `materialize('__migration__', …)` would invoke `save`, which (via
    // `getSnapshotPath`) throws `Invalid streamId: "__migration__"`.
    const materializer = new ViewMaterializer({
      snapshotStore,
      snapshotInterval: 1,
    });
    materializer.register(VIEW_NAME, counterProjection);

    // User-facing stream — the normal happy path.
    materializer.materialize('my-feature', VIEW_NAME, [
      makeEvent(1, 'my-feature'),
    ]);

    // Sentinel stream — must not crash, must not save, must not touch cache.
    expect(() =>
      materializer.materialize('__migration__', VIEW_NAME, [
        makeEvent(1, '__migration__'),
      ]),
    ).not.toThrow();

    // `save` was called for the user stream …
    expect(snapshotStore.save).toHaveBeenCalledWith(
      'my-feature',
      VIEW_NAME,
      expect.anything(),
      expect.any(Number),
    );
    // … and NEVER for `__migration__`.
    const sentinelCall = snapshotStore.save.mock.calls.find(
      (c) => c[0] === '__migration__',
    );
    expect(sentinelCall).toBeUndefined();

    // No state cached for the sentinel — it was skipped entirely.
    expect(materializer.getState('__migration__', VIEW_NAME)).toBeUndefined();
    // User stream cached normally.
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
    // load was never called — the sentinel was rejected before reaching the
    // store, so the validator inside `getSnapshotPath` can never fire.
    expect(snapshotStore.load).not.toHaveBeenCalled();
  });
});

// ─── Test B — Integration: pipeline view survives a __migration__ stream ───

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

  it('returns a success envelope when __migration__ exists alongside a normal stream', async () => {
    const featureId = 'my-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    // Seed an event on the internal `__migration__` stream — the real
    // backfill in `migrateV5ToV6` writes progress events here. The event
    // schema only requires `streamId.min(1).max(100)`, so this is a faithful
    // reproduction of the production crash.
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
    // The known crash signature was `VIEW_ERROR: Invalid streamId: "__migration__"`.
    // Pin the absence explicitly so a future regression that returns
    // `{success:false}` with this message is caught even if a different
    // assertion masks it.
    if (!result.success) {
      expect(result.error?.message).not.toContain('Invalid streamId');
    }
  });
});
