// ─── EFF-002: projection-degraded signal on cursor/tail disagreement ─────────
//
// CB-8 (phase-gate v2.12 dogfood): workflow views served a silently stale fold —
// a cancelled workflow still reported at `plan-review`, 7 of 10 completed tasks
// visible, lag past 500s — with nothing on the response saying the answer did
// not derive from the current event tail.
//
// The comparison is pure (`assessStreamFreshness`); the chokepoint is
// `handleView`, so EVERY view action inherits it rather than each handler
// re-implementing a freshness check.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  EventTypes,
} from '../event-store/schemas.js';
import {
  assessProjectionFreshness,
  assessStreamFreshness,
  toProjectionDegradedMeta,
  publishProjectionFreshness,
  readProjectionDegradedState,
  readAllProjectionDegradedStates,
  projectionDegradedIdempotencyKey,
  PROJECTION_DEGRADED_META,
  PROJECTION_HEALTH_STREAM_ID,
  PROJECTION_DEGRADED_EVENT_TYPE,
  PROJECTION_RECOVERED_EVENT_TYPE,
} from './freshness.js';
import { handleView } from '../views/composite.js';
import { getOrCreateMaterializer } from '../views/tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

  it('Freshness_CursorAheadOfTail_DegradedAsProjectionAhead', () => {
    // A snapshot restored over a pruned/rebuilt log: the fold claims events the
    // store cannot produce. Contradiction, not staleness — but equally unusable.
    const result = assessProjectionFreshness({ eventTail: 10, projectionCursor: 25 });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('projection-ahead');
    expect(result.lag).toBe(-15);
  });

  it('Freshness_MultipleCursors_ReportsWorstOffenderFirst', () => {
    const result = assessStreamFreshness(100, [
      { viewName: 'pipeline', cursor: 100 },
      { viewName: 'workflow-state', cursor: 60 },
      { viewName: 'delegation-readiness', cursor: 95 },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.projectionCursor).toBe(60);
    expect(result.lag).toBe(40);
    expect(result.staleViews).toEqual(['workflow-state', 'delegation-readiness']);
    expect(result.staleViews).not.toContain('pipeline');
  });

  it('Freshness_AllCursorsAtTail_NotDegraded', () => {
    const result = assessStreamFreshness(7, [
      { viewName: 'pipeline', cursor: 7 },
      { viewName: 'workflow-state', cursor: 7 },
    ]);
    expect(result.degraded).toBe(false);
    expect(result.staleViews).toEqual([]);
  });

  it('Freshness_NoMaterializedFolds_NotDegraded', () => {
    // A cold read folds from scratch — there is no stale answer to serve.
    expect(assessStreamFreshness(500, []).degraded).toBe(false);
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

  it('HandleView_FreshProjection_NoDegradedMarker', async () => {
    await seedEvents(4);
    // First read folds to the tail.
    const first = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    expect(first.success).toBe(true);
    // Second read observes the same, still-current fold.
    const second = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    expect(second.success).toBe(true);
    expect(degradedMeta(second)).toBeUndefined();
  });

  it('HandleView_ProjectionAheadOfPrunedLog_ReturnsTypedDegradedMarker', async () => {
    await seedEvents(4);
    // Warm the fold so a cursor exists…
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    // …then inject the contradiction a snapshot restored over a pruned or
    // rebuilt log produces: the fold claims events the store cannot produce.
    // The incremental read path asks for `sinceSequence: 25`, gets nothing, and
    // would happily serve the impossible fold as authoritative.
    const materializer = getOrCreateMaterializer(stateDir);
    const cursors = materializer.getStreamCursors(STREAM);
    expect(cursors.length).toBeGreaterThan(0);
    for (const { viewName } of cursors) {
      const state = materializer.getState(STREAM, viewName);
      if (state) materializer.loadState(STREAM, viewName, state.view, 25);
    }

    const result = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    expect(result.success).toBe(true);
    const meta = degradedMeta(result);
    expect(meta, 'a fold ahead of the log must not answer unmarked').toBeDefined();
    expect(meta).toMatchObject({
      reason: 'projection-ahead',
      eventTail: 4,
      projectionCursor: 25,
    });
  });

  it('HandleView_StaleSiblingFold_DegradesTheWholeStreamAnswer', async () => {
    // The CB-8 shape: one projection is current while a sibling projection of
    // the SAME stream lags, so two surfaces contradict each other. Reading the
    // current one catches only its own fold up — the stream is still not
    // internally consistent, and the answer must say so.
    await seedEvents(4);
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    await handleView({ action: 'delegation_readiness', workflowId: STREAM }, ctx);

    const materializer = getOrCreateMaterializer(stateDir);
    const cursors = materializer.getStreamCursors(STREAM);
    const sibling = cursors.find((c) => c.viewName !== 'workflow-status');
    expect(sibling, 'test needs two distinct folds on the stream').toBeDefined();
    if (sibling === undefined) return;
    const siblingState = materializer.getState(STREAM, sibling.viewName);
    expect(siblingState).toBeDefined();
    if (siblingState === undefined) return;
    materializer.loadState(STREAM, sibling.viewName, siblingState.view, 1);

    // Reading the CURRENT projection still reports the stream as degraded.
    const result = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    const meta = degradedMeta(result);
    expect(meta, 'a stale sibling fold must degrade the stream answer').toBeDefined();
    expect(meta).toMatchObject({ reason: 'projection-behind', eventTail: 4 });
    expect(meta?.['staleViews']).toContain(sibling.viewName);
  });

  it('HandleView_NoWorkflowId_LeavesResponseUntouched', async () => {
    const result = await handleView({ action: 'describe' }, ctx);
    expect(degradedMeta(result)).toBeUndefined();
  });
});

// ─── DR-4: one durable projection-degraded state ────────────────────────────
//
// CHARACTERIZATION of what came before (the tests above still pin it):
// `_meta.projectionDegraded` is an EPHEMERAL per-response annotation.
// `stampProjectionFreshness` recomputes it on every read from the in-memory
// materializer LRU and stamps it on ONE envelope. Nothing is persisted, so the
// verdict does not survive the response — let alone a process restart — and a
// consumer that does not read `_meta` (or runs in another process with a cold
// cache) still receives the stale fold as `success: true`.
//
// WHAT CHANGED: the same cursor/tail verdict is now also PUBLISHED — as
// `projection.degraded` / `projection.recovered` on the dedicated durable
// `meta/projection-health` stream — and read back as a folded state through
// `readProjectionDegradedState`. The `_meta` annotation is deliberately
// untouched; it remains a per-response courtesy, not the state of record.
// ─────────────────────────────────────────────────────────────────────────────

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

  /**
   * Warm a REAL fold through the real view chokepoint, then drive its cursor to
   * `cursor`. This is the CB-8 fault: a materialized projection whose
   * high-water mark no longer matches the durable tail.
   */
  async function warmFoldAndSetCursor(cursor: number): Promise<void> {
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    const materializer = getOrCreateMaterializer(stateDir);
    const cursors = materializer.getStreamCursors(STREAM);
    expect(cursors.length, 'test needs at least one materialized fold').toBeGreaterThan(0);
    for (const { viewName } of cursors) {
      const state = materializer.getState(STREAM, viewName);
      if (state) materializer.loadState(STREAM, viewName, state.view, cursor);
    }
  }

  /** The REAL cursor/tail comparison — no synthetic numbers, no mocked store. */
  async function assessLive(): Promise<ReturnType<typeof assessStreamFreshness>> {
    const materializer = getOrCreateMaterializer(stateDir);
    return assessStreamFreshness(
      await store.tailSequence(STREAM),
      materializer.getStreamCursors(STREAM),
    );
  }

  it('ProjectionFreshness_StaleCursor_PublishesDurableDegradedState', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1); // fold stops 3 events short of the tail

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

    // DURABILITY — the whole point. Drop the store (and with it every
    // in-memory cursor), reopen the same state directory through a SEPARATE,
    // independent EventStore, and read the state back with nothing but a
    // stream id. No materializer, no warm LRU, no `_meta`.
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

      // It is a real persisted event on the dedicated health stream, readable
      // by any consumer that never imported this module.
      const persisted = await reopened.query(PROJECTION_HEALTH_STREAM_ID, {
        type: PROJECTION_DEGRADED_EVENT_TYPE,
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.data).toMatchObject({ streamId: STREAM, eventTail: 4 });
    } finally {
      reopened.close();
      store = new EventStore(stateDir); // afterEach closes this handle
    }
  });

  it('ProjectionFreshness_TailMatchesCursor_PublishesNoDegradedState', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(4); // fold covers the tail exactly

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
      projectionDegradedIdempotencyKey(STREAM, 4, 1),
    );
  });

  it('ProjectionDegraded_PublishedOnMetaStream_LeavesAssessedStreamTailUntouched', async () => {
    // Publishing onto the assessed stream would move the very tail the verdict
    // is computed against — each read would observe a NEW disagreement and
    // append again, forever.
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    await publishProjectionFreshness(store, STREAM, await assessLive());

    expect(await store.tailSequence(STREAM)).toBe(4);
    expect(await store.query(STREAM, { type: PROJECTION_DEGRADED_EVENT_TYPE })).toEqual([]);
  });

  it('ProjectionDegraded_FoldCatchesTail_ResolvesTheDurableState', async () => {
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    expect(await publishProjectionFreshness(store, STREAM, await assessLive())).toBeDefined();
    expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();

    // The fold catches up: the durable state must clear, not stick forever.
    await warmFoldAndSetCursor(4);
    expect(await publishProjectionFreshness(store, STREAM, await assessLive())).toBeUndefined();
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();

    const recovered = await store.query(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_RECOVERED_EVENT_TYPE,
    });
    expect(recovered).toHaveLength(1);

    // …and a second healthy read publishes nothing further.
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

  it('ProjectionDegraded_EventTypes_RegisteredWithSourceAndSchema', async () => {
    for (const type of [PROJECTION_DEGRADED_EVENT_TYPE, PROJECTION_RECOVERED_EVENT_TYPE]) {
      expect(EventTypes).toContain(type);
      expect(EVENT_EMISSION_REGISTRY[type]).toBe('auto');
      expect(EVENT_DATA_SCHEMAS[type], `${type} needs a data schema`).toBeDefined();
    }

    // The persisted payload parses against the REGISTERED schema — the wire
    // contract T-07 reads it back through cannot drift from the emitter.
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
