/**
 * Tests for `rebuildProjection`. It folds a reducer over every event of a stream from sequence 0
 * and reads no snapshot. The rehydrate handler uses it as the fallback when a snapshot read fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { createRegistry } from '../../../src/projections/registry.js';
import type { ProjectionRegistry } from '../../../src/projections/registry.js';
import type { ProjectionReducer } from '../../../src/projections/types.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import type { RehydrationDocument } from '../../../src/projections/rehydration/schema.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { rebuildProjection, UnknownProjectionIdError } from '../../../src/projections/rebuild.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'projection-rebuild-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

/** The oracle: a manual fold of `reducer` over the events that `EventStore.query` returns. */
async function manualFold<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
): Promise<State> {
  const events = (await eventStore.query(streamId)) as unknown as Event[];
  return events.reduce<State>(
    (acc, ev) => reducer.apply(acc, ev),
    reducer.initial,
  );
}

describe('rebuildProjection — full replay from sequence 0 (T029, DR-1, DR-18)', () => {
  /**
   * No snapshot exists, and the rebuild reads none.
   * The reducer handles each of the six events, so `projectionSequence` equals the stream length.
   */
  it('Rebuild_Given_CorruptSnapshot_When_Rebuild_Then_FullReplayProducesSameState', async () => {
    const streamId = 'wf-rebuild';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: 'rehydrate-foundation', workflowType: 'feature' },
    });
    await store.append(streamId, {
      type: 'workflow.transition',
      data: { from: 'design', to: 'tdd' },
    });
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 'T029' },
    });
    await store.append(streamId, {
      type: 'task.completed',
      data: { taskId: 'T029' },
    });
    await store.append(streamId, {
      type: 'state.patched',
      data: { patch: { artifacts: { design: 'docs/designs/rehydrate.md' } } },
    });
    await store.append(streamId, {
      type: 'review.completed',
      data: { verdict: 'blocked', stage: 'review', summary: 'needs redo' },
    });

    const rebuilt = await rebuildProjection(
      rehydrationReducer,
      store,
      streamId,
    );

    const oracle = await manualFold<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      streamId,
    );

    expect(rebuilt).toStrictEqual(oracle);

    expect(rebuilt.projectionSequence).toBe(6);
  });

  it('Rebuild_EmptyStream_ReturnsInitialState', async () => {
    const streamId = 'wf-empty';

    const rebuilt = await rebuildProjection(
      rehydrationReducer,
      store,
      streamId,
    );

    expect(rebuilt).toStrictEqual(rehydrationReducer.initial);
    expect(rebuilt.projectionSequence).toBe(0);
  });

  it('Rebuild_UsesRegistryLookup_WhenIdProvided', async () => {
    const streamId = 'wf-by-id';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: 'feat-42', workflowType: 'feature' },
    });
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 'T001' },
    });

    const registry: ProjectionRegistry = createRegistry();
    registry.register(
      rehydrationReducer as unknown as Parameters<typeof registry.register>[0],
    );

    const rebuilt = await rebuildProjection(
      'rehydration@v1',
      store,
      streamId,
      { registry },
    );

    const oracle = await manualFold<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      streamId,
    );
    expect(rebuilt).toStrictEqual(oracle);
  });

  /**
   * An unregistered id raises an error and does not return the initial state.
   * The test pins both the error class and the `unknown projection id:` message prefix.
   */
  it('Rebuild_UnknownProjectionId_Throws', async () => {
    const streamId = 'wf-missing-id';
    const registry: ProjectionRegistry = createRegistry();

    await expect(
      rebuildProjection('does-not-exist@v1', store, streamId, { registry }),
    ).rejects.toBeInstanceOf(UnknownProjectionIdError);
    await expect(
      rebuildProjection('does-not-exist@v1', store, streamId, { registry }),
    ).rejects.toThrow(/unknown projection id: does-not-exist@v1/);
  });
});
