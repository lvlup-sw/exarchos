import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { createRegistry } from './registry.js';
import type { ProjectionRegistry } from './registry.js';
import type { ProjectionReducer } from './types.js';
import { rehydrationReducer } from './rehydration/reducer.js';
import type { RehydrationDocument } from './rehydration/schema.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { rebuildProjection } from './rebuild.js';

/**
 * T029 — `rebuildProjection` helper
 *
 * Rebuilds a projection's state by folding its reducer over a stream's events
 * from sequence 0. Used by the rehydrate MCP handler (T031) as the
 * degraded/cold-cache fallback path when the snapshot sidecar is missing
 * or corrupt (DR-1, DR-18).
 *
 * These tests validate three behaviours:
 *   1. Given a stream with events and a missing/corrupt snapshot, rebuild
 *      produces the canonical state (parity with manual fold).
 *   2. Given an empty stream, rebuild returns `reducer.initial` unchanged.
 *   3. When passed a projection id string, rebuild resolves the reducer via
 *      the provided registry (defaults to `defaultRegistry`).
 */

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'projection-rebuild-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Produce a canonical state by manually folding a reducer over the events
 * returned by `EventStore.query`. Used as the oracle the rebuild helper must
 * match byte-for-byte (structural equality).
 */
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
  it('Rebuild_Given_CorruptSnapshot_When_Rebuild_Then_FullReplayProducesSameState', async () => {
    // GIVEN: a stream with a variety of events covering every rehydration
    //   reducer handler — task.*, workflow.*, state.*, review.*. These are the
    //   real event types the rehydration reducer folds; replay over them
    //   exercises every branch.
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

    // AND: no snapshot sidecar exists (corrupt / missing). The rebuild helper
    //   does not consult snapshots — it folds the reducer over the live event
    //   stream starting at sequence 0. This test asserts that contract.

    // WHEN: we invoke rebuildProjection with the rehydration reducer.
    const rebuilt = await rebuildProjection(
      rehydrationReducer,
      store,
      streamId,
    );

    // THEN: the rebuilt state matches the oracle (manual fold over query()).
    const oracle = await manualFold<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      streamId,
    );

    expect(rebuilt).toStrictEqual(oracle);

    // AND: projectionSequence reflects the number of events actually folded.
    //   Every event in the stream above is handled by the rehydration reducer,
    //   so projectionSequence MUST equal the stream length (6).
    expect(rebuilt.projectionSequence).toBe(6);
  });

  it('Rebuild_EmptyStream_ReturnsInitialState', async () => {
    // GIVEN: a stream with zero events (no file on disk either).
    const streamId = 'wf-empty';

    // WHEN: we invoke rebuildProjection.
    const rebuilt = await rebuildProjection(
      rehydrationReducer,
      store,
      streamId,
    );

    // THEN: the returned state is reducer.initial (structural equality).
    //   An empty fold yields the seed state by definition.
    expect(rebuilt).toStrictEqual(rehydrationReducer.initial);
    expect(rebuilt.projectionSequence).toBe(0);
  });

  it('Rebuild_UsesRegistryLookup_WhenIdProvided', async () => {
    // GIVEN: an isolated registry with the rehydration reducer registered,
    //   and a small stream so rebuild has something to fold.
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

    // WHEN: we invoke rebuildProjection with a projection id string instead of
    //   a reducer. The helper resolves the reducer from the registry.
    const rebuilt = await rebuildProjection(
      'rehydration@v1',
      store,
      streamId,
      { registry },
    );

    // THEN: the rebuilt state matches a manual fold via the registered reducer.
    const oracle = await manualFold<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      streamId,
    );
    expect(rebuilt).toStrictEqual(oracle);
  });

  it('Rebuild_UnknownProjectionId_Throws', async () => {
    // GIVEN: an isolated, empty registry (no reducers registered).
    const streamId = 'wf-missing-id';
    const registry: ProjectionRegistry = createRegistry();

    // WHEN/THEN: invoking rebuild with an unregistered id raises a structured
    //   error so the rehydrate handler can translate it to a degraded-mode
    //   response (DR-18) rather than silently returning initial state.
    await expect(
      rebuildProjection('does-not-exist@v1', store, streamId, { registry }),
    ).rejects.toThrow(/does-not-exist@v1/);
  });
});
