/**
 * Tests for projection freshness: the comparison of one projection cursor with the durable event tail.
 * `assessProjectionFreshness` is pure, and its verdict is for one named fold, not for a stream.
 * `planRehydrationSource` calls it and plans the repair.
 * The plan folds a lagging fold forward, and discards and replays a contradictory fold.
 * `src/projections/fold-at-tail.ts` runs that plan before each read that answers from a projection.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  EventTypes,
} from '../../../src/events/schemas.js';
import {
  assessProjectionFreshness,
  toProjectionDegradedMeta,
  publishProjectionFreshness,
  readProjectionDegradedState,
  readAllProjectionDegradedStates,
  projectionDegradedIdempotencyKey,
  PROJECTION_DEGRADED_META,
  PROJECTION_HEALTH_STREAM_ID,
  PROJECTION_DEGRADED_EVENT_TYPE,
  PROJECTION_RECOVERED_EVENT_TYPE,
} from '../../../src/projections/freshness.js';
import { handleView } from '../../../src/projections/views/composite.js';
import { getOrCreateMaterializer } from '../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('projection freshness comparison (EFF-002)', () => {
  it('Freshness_CursorMatchesTail_NotDegraded', () => {
    const result = assessProjectionFreshness({ eventTail: 42, projectionCursor: 42 });
    expect(result.degraded).toBe(false);
    expect(result.lag).toBe(0);
    expect(toProjectionDegradedMeta(result)).toBeUndefined();
  });

  it('Freshness_CursorBehindTail_DegradedAsProjectionBehind', () => {
    const result = assessProjectionFreshness({
      eventTail: 236,
      projectionCursor: 235,
      viewName: 'workflow-state',
    });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('projection-behind');
    expect(result.lag).toBe(1);
    expect(result.staleViews).toEqual(['workflow-state']);
    expect(toProjectionDegradedMeta(result)).toMatchObject({ reason: 'projection-behind' });
  });

  /** A snapshot restored over a pruned or rebuilt log claims events that the store cannot produce. The fold contradicts the log. */
  it('Freshness_CursorAheadOfTail_DegradedAsProjectionAhead', () => {
    const result = assessProjectionFreshness({ eventTail: 10, projectionCursor: 25 });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('projection-ahead');
    expect(result.lag).toBe(-15);
  });

  /**
   * The verdict is for one named fold. A read advances one fold only, so no read can make every fold of a stream fresh.
   * A sibling fold of the same stream is judged separately and can be fresh at the same time.
   */
  it('Freshness_IsPerFold_NotPerStream', () => {
    const behind = assessProjectionFreshness({
      eventTail: 100,
      projectionCursor: 60,
      viewName: 'workflow-state',
    });
    expect(behind.staleViews, 'the verdict is about one named fold').toEqual(['workflow-state']);
    expect(behind.lag).toBe(40);

    const sibling = assessProjectionFreshness({
      eventTail: 100,
      projectionCursor: 100,
      viewName: 'pipeline',
    });
    expect(sibling.degraded).toBe(false);
    expect(sibling.staleViews).toEqual([]);
  });
});

describe('view chokepoint marks degraded reads (EFF-002)', () => {
  let stateDir: string;
  let ctx: DispatchContext;
  const STREAM = 'eff-002-stream';

  beforeEach(async () => {
    stateDir = await mkdtemp(nodePath.join(tmpdir(), 'eff-002-'));
    ctx = { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
    await ctx.eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function seedEvents(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await ctx.eventStore.append(STREAM, { type: 'task.progressed', data: { i } });
    }
  }

  function degradedMeta(result: { _meta?: unknown }): Record<string, unknown> | undefined {
    const meta = result._meta as Record<string, unknown> | undefined;
    return meta?.[PROJECTION_DEGRADED_META] as Record<string, unknown> | undefined;
  }

  /** The first read folds to the tail. The second read sees the same current fold. */
  it('HandleView_FreshProjection_NoDegradedMarker', async () => {
    await seedEvents(4);
    const first = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    expect(first.success).toBe(true);
    const second = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    expect(second.success).toBe(true);
    expect(degradedMeta(second)).toBeUndefined();
  });

  /**
   * The test warms the fold, then sets each cursor to 25, past the tail of 4.
   * An incremental read from sequence 25 returns no event, so the fold cannot repair itself.
   * The event log is the source of truth, so the read discards the fold, replays it, and answers.
   * The cursor then sits on the real tail.
   */
  it('HandleView_ProjectionAheadOfPrunedLog_IsRepairedAndAnswered', async () => {
    await seedEvents(4);
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    const materializer = getOrCreateMaterializer(stateDir);
    const cursors = materializer.getStreamCursors(STREAM);
    expect(cursors.length).toBeGreaterThan(0);
    for (const { viewName } of cursors) {
      const state = materializer.getState(STREAM, viewName);
      if (state) materializer.loadState(STREAM, viewName, state.view, 25);
    }

    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(result.error?.code).not.toBe('PROJECTION_DEGRADED');
    expect(result.data, 'a repaired read answers with real data').toBeDefined();

    const repaired = materializer.getState(STREAM, 'workflow-status');
    expect(repaired?.highWaterMark).toBe(4);
  });

  /**
   * A stale sibling fold is not a fact about this answer, because a read refreshes only its own fold.
   * The read of the current projection answers with no degraded marker and leaves the sibling stale.
   * A read of the sibling repairs the sibling.
   */
  it('HandleView_StaleSiblingFold_DoesNotDegradeAnUnrelatedAnswer', async () => {
    await seedEvents(4);
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    await handleView({ action: 'delegation_readiness', workflowId: STREAM }, ctx);

    const materializer = getOrCreateMaterializer(stateDir);
    const sibling = materializer
      .getStreamCursors(STREAM)
      .find((cursor) => cursor.viewName !== 'workflow-status');
    expect(sibling, 'test needs two distinct folds on the stream').toBeDefined();
    if (sibling === undefined) return;
    const siblingState = materializer.getState(STREAM, sibling.viewName);
    expect(siblingState).toBeDefined();
    if (siblingState === undefined) return;
    materializer.loadState(STREAM, sibling.viewName, siblingState.view, 1);

    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(degradedMeta(result), 'an unread fold is not a fact about this answer').toBeUndefined();
    expect(
      materializer.getState(STREAM, sibling.viewName)?.highWaterMark,
      'reading one fold must not silently touch another',
    ).toBe(1);

    const siblingRead = await handleView({ action: 'delegation_readiness', workflowId: STREAM }, ctx);
    expect(siblingRead.success, JSON.stringify(siblingRead.error)).toBe(true);
    expect(materializer.getState(STREAM, sibling.viewName)?.highWaterMark).toBe(4);
  });

  it('HandleView_NoWorkflowId_LeavesResponseUntouched', async () => {
    const result = await handleView({ action: 'describe' }, ctx);
    expect(degradedMeta(result)).toBeUndefined();
  });
});

/**
 * `publishProjectionFreshness` also writes the cursor and tail verdict as `projection.degraded` and `projection.recovered` events.
 * The events go to the durable `meta/projection-health` stream, and `readProjectionDegradedState` folds them back.
 * `_meta.projectionDegraded` stays a per-response annotation and is not the state of record.
 *
 * `JUDGED_VIEW` is the one named fold that these cases judge.
 * `warmFoldAndSetCursor` warms a fold through the view handler, then sets its high-water mark to `cursor`.
 * It changes one fold only, because a read advances exactly one fold.
 * `assessLive` compares the live cursor with the tail of the real store.
 */
describe('durable projection-degraded state (DR-4)', () => {
  let stateDir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  const STREAM = 'dr-4-stream';

  beforeEach(async () => {
    stateDir = await mkdtemp(nodePath.join(tmpdir(), 'dr-4-'));
    store = new EventStore(stateDir);
    await store.initialize();
    ctx = { stateDir, eventStore: store, enableTelemetry: false };
  });

  afterEach(async () => {
    store.close();
    await rmrfAsync(stateDir);
  });

  async function seedEvents(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await store.append(STREAM, { type: 'task.progressed', data: { i } });
    }
  }

  const JUDGED_VIEW = 'workflow-status';

  async function warmFoldAndSetCursor(cursor: number): Promise<void> {
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    const materializer = getOrCreateMaterializer(stateDir);
    const state = materializer.getState(STREAM, JUDGED_VIEW);
    expect(state, 'test needs a real materialized fold').toBeDefined();
    if (state) materializer.loadState(STREAM, JUDGED_VIEW, state.view, cursor);
  }

  async function assessLive(): Promise<ReturnType<typeof assessProjectionFreshness>> {
    const materializer = getOrCreateMaterializer(stateDir);
    return assessProjectionFreshness({
      eventTail: await store.tailSequence(STREAM),
      projectionCursor: materializer.getState(STREAM, JUDGED_VIEW)?.highWaterMark ?? 0,
      viewName: JUDGED_VIEW,
    });
  }

  /**
   * The fold stops 3 events short of the tail.
   * The test closes the store and opens a second `EventStore` on the same directory.
   * The degraded state must come back from the stream id alone, with no materializer and no `_meta`.
   * The `finally` block opens a new store because `afterEach` closes `store`.
   */
  it('ProjectionFreshness_StaleCursor_PublishesDurableDegradedState', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);

    const freshness = await assessLive();
    expect(freshness.degraded, 'fault injection must produce a real disagreement').toBe(true);
    expect(freshness.eventTail).toBe(4);
    expect(freshness.projectionCursor).toBe(1);

    const published = await publishProjectionFreshness(store, STREAM, freshness);
    expect(published).toMatchObject({
      streamId: STREAM,
      reason: 'projection-behind',
      eventTail: 4,
      projectionCursor: 1,
      lag: 3,
    });

    store.close();
    const reopened = new EventStore(stateDir);
    await reopened.initialize();
    try {
      const durable = await readProjectionDegradedState(reopened, STREAM);
      expect(durable, 'the degraded state must survive losing the process cache').toBeDefined();
      expect(durable).toMatchObject({
        streamId: STREAM,
        reason: 'projection-behind',
        eventTail: 4,
        projectionCursor: 1,
        lag: 3,
      });
      expect(durable?.staleViews.length).toBeGreaterThan(0);

      const persisted = await reopened.query(PROJECTION_HEALTH_STREAM_ID, {
        type: PROJECTION_DEGRADED_EVENT_TYPE,
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.data).toMatchObject({ streamId: STREAM, eventTail: 4 });
    } finally {
      reopened.close();
      store = new EventStore(stateDir);
    }
  });

  it('ProjectionFreshness_TailMatchesCursor_PublishesNoDegradedState', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(4);

    const freshness = await assessLive();
    expect(freshness.degraded).toBe(false);

    const published = await publishProjectionFreshness(store, STREAM, freshness);
    expect(published).toBeUndefined();

    const health = await store.query(PROJECTION_HEALTH_STREAM_ID);
    expect(health, 'a healthy stream must not write a row per read').toEqual([]);
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();
  });

  it('ProjectionDegraded_RepeatedDetectionOfSameCursor_AppendsOnce', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);

    const freshness = await assessLive();
    const first = await publishProjectionFreshness(store, STREAM, freshness);
    const second = await publishProjectionFreshness(store, STREAM, freshness);
    const third = await publishProjectionFreshness(store, STREAM, await assessLive());

    const persisted = await store.query(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_DEGRADED_EVENT_TYPE,
    });
    expect(persisted, 're-detecting the same degraded cursor must not spam').toHaveLength(1);
    expect(second?.sequence).toBe(first?.sequence);
    expect(third?.sequence).toBe(first?.sequence);
    expect(persisted[0]?.idempotencyKey).toBe(
      projectionDegradedIdempotencyKey(STREAM, 4, 1, 0),
    );
  });

  /**
   * The stream degrades, recovers, then degrades again at the identical tail and cursor.
   * A key of stream, tail and cursor alone dedupes the second `projection.degraded` onto the first row.
   * That row comes before the recovery, so the fold ends recovered and the stream reads as healthy.
   * The second detection must write a new row after the recovery.
   * Repeated detections in one generation still collapse onto one row.
   */
  it('ProjectionDegraded_RedetectionAfterRecovery_FoldEndsDegraded', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    expect(await publishProjectionFreshness(store, STREAM, await assessLive())).toBeDefined();

    await warmFoldAndSetCursor(4);
    await publishProjectionFreshness(store, STREAM, await assessLive());
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();

    await warmFoldAndSetCursor(1);
    const freshness = await assessLive();
    expect(freshness).toMatchObject({ degraded: true, eventTail: 4, projectionCursor: 1 });

    const republished = await publishProjectionFreshness(store, STREAM, freshness);
    expect(republished, 'the re-detection must produce a durable state').toBeDefined();

    const durable = await readProjectionDegradedState(store, STREAM);
    expect(durable, 'a re-degraded stream must not be served as healthy').toMatchObject({
      streamId: STREAM,
      reason: 'projection-behind',
      eventTail: 4,
      projectionCursor: 1,
    });

    await publishProjectionFreshness(store, STREAM, await assessLive());
    const persisted = await store.query(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_DEGRADED_EVENT_TYPE,
    });
    expect(persisted).toHaveLength(2);
  });

  /**
   * The publish must not append to the assessed stream.
   * Such an append moves the tail that the verdict compares against, so each read appends again without end.
   */
  it('ProjectionDegraded_PublishedOnMetaStream_LeavesAssessedStreamTailUntouched', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    await publishProjectionFreshness(store, STREAM, await assessLive());

    expect(await store.tailSequence(STREAM)).toBe(4);
    expect(await store.query(STREAM, { type: PROJECTION_DEGRADED_EVENT_TYPE })).toEqual([]);
  });

  /** When the fold catches the tail, the durable state must clear. A second healthy read publishes no more events. */
  it('ProjectionDegraded_FoldCatchesTail_ResolvesTheDurableState', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    expect(await publishProjectionFreshness(store, STREAM, await assessLive())).toBeDefined();
    expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();

    await warmFoldAndSetCursor(4);
    expect(await publishProjectionFreshness(store, STREAM, await assessLive())).toBeUndefined();
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();

    const recovered = await store.query(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_RECOVERED_EVENT_TYPE,
    });
    expect(recovered).toHaveLength(1);

    await publishProjectionFreshness(store, STREAM, await assessLive());
    expect(
      await store.query(PROJECTION_HEALTH_STREAM_ID, {
        type: PROJECTION_RECOVERED_EVENT_TYPE,
      }),
    ).toHaveLength(1);
  });

  it('ProjectionDegraded_DistinctStreams_FoldIndependently', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    await publishProjectionFreshness(store, STREAM, await assessLive());

    const all = await readAllProjectionDegradedStates(store);
    expect([...all.keys()]).toEqual([STREAM]);
    expect(await readProjectionDegradedState(store, 'some-other-stream')).toBeUndefined();
  });

  /** The persisted payload must parse against the registered schema, so the stored data cannot drift from the emitter. */
  it('ProjectionDegraded_EventTypes_RegisteredWithSourceAndSchema', async () => {
    for (const type of [PROJECTION_DEGRADED_EVENT_TYPE, PROJECTION_RECOVERED_EVENT_TYPE]) {
      expect(EventTypes).toContain(type);
      expect(EVENT_EMISSION_REGISTRY[type]).toBe('auto');
      expect(EVENT_DATA_SCHEMAS[type], `${type} needs a data schema`).toBeDefined();
    }

    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    await publishProjectionFreshness(store, STREAM, await assessLive());
    const [event] = await store.query(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_DEGRADED_EVENT_TYPE,
    });
    expect(
      EVENT_DATA_SCHEMAS[PROJECTION_DEGRADED_EVENT_TYPE]?.safeParse(event?.data).success,
    ).toBe(true);
  });
});
