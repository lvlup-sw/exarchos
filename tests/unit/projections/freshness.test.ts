// ─── EFF-002: projection-degraded signal on cursor/tail disagreement ─────────
//
// A phase-gate dogfood run found workflow views serving a silently stale fold —
// a cancelled workflow still reported at `plan-review`, 7 of 10 completed tasks
// visible, lag past 500s — with nothing on the response saying the answer did
// not derive from the current event tail.
//
// The comparison is pure (`assessProjectionFreshness`). Its consumer is
// `planRehydrationSource`, which REPAIRS what it reports — folds a lagging fold
// forward, discards and replays a contradictory one — and
// `projections/fold-at-tail.ts` runs that decision ahead of every
// projection-derived read.
//
// #1855 removed the stream-wide sibling `assessStreamFreshness`, which required
// every cached fold of a stream to sit on the tail while a read advances only
// one. The tests that pinned it are rewritten below to the claim that replaced
// them, not deleted: what a stale sibling fold must do is exactly the question
// that got answered wrongly, so it is worth an explicit test of the new answer.
// ─────────────────────────────────────────────────────────────────────────────

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

  it('Freshness_CursorAheadOfTail_DegradedAsProjectionAhead', () => {
    // A snapshot restored over a pruned/rebuilt log: the fold claims events the
    // store cannot produce. Contradiction, not staleness — but equally unusable.
    const result = assessProjectionFreshness({ eventTail: 10, projectionCursor: 25 });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('projection-ahead');
    expect(result.lag).toBe(-15);
  });

  it('Freshness_IsPerFold_NotPerStream', () => {
    // `assessStreamFreshness` used to answer this question for a whole stream
    // by requiring EVERY cached fold to sit on the tail. That is a different
    // and false obligation: a read advances one fold, so the predicate could
    // not come back clean on any stream with two of them, and the staleness of
    // a fold nobody is reading is not a fact about the answer being produced.
    // The comparison that survives is per-fold and names the fold it judged.
    const behind = assessProjectionFreshness({
      eventTail: 100,
      projectionCursor: 60,
      viewName: 'workflow-state',
    });
    expect(behind.staleViews, 'the verdict is about one named fold').toEqual(['workflow-state']);
    expect(behind.lag).toBe(40);

    // A sibling fold of the same stream is judged separately and can be fresh
    // at the same instant. Nothing collapses the two into one stream verdict.
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

  it('HandleView_ProjectionAheadOfPrunedLog_IsRepairedAndAnswered', async () => {
    await seedEvents(4);
    // Warm the fold so a cursor exists…
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    // …then inject the contradiction a snapshot restored over a pruned or
    // rebuilt log produces: the fold claims events the store cannot produce.
    // The incremental read path asks for `sinceSequence: 25` and gets nothing,
    // so the impossible fold cannot heal itself.
    const materializer = getOrCreateMaterializer(stateDir);
    const cursors = materializer.getStreamCursors(STREAM);
    expect(cursors.length).toBeGreaterThan(0);
    for (const { viewName } of cursors) {
      const state = materializer.getState(STREAM, viewName);
      if (state) materializer.loadState(STREAM, viewName, state.view, 25);
    }

    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    // #1855 ORACLE UPDATE — deliberate, and the second time this line has
    // moved. It first read `success: true` (the impossible fold was SERVED,
    // with the verdict whispered on `_meta`). It then became a refusal.
    // Both readings shared an assumption: that the only choices are serving a
    // bad fold or withholding an answer. There is a third — the event log is
    // authoritative — it is the source of truth — so the fold is DISCARDED and
    // replayed, and the
    // answer that comes back is correct rather than merely marked.
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(result.error?.code).not.toBe('PROJECTION_DEGRADED');
    expect(result.data, 'a repaired read answers with real data').toBeDefined();

    // The cursor now sits on the real tail, not the impossible one.
    const repaired = materializer.getState(STREAM, 'workflow-status');
    expect(repaired?.highWaterMark).toBe(4);
  });

  it('HandleView_StaleSiblingFold_DoesNotDegradeAnUnrelatedAnswer', async () => {
    // This test previously asserted the OPPOSITE — "a stale sibling fold must
    // degrade the stream answer" — and that assertion is #1855. It made the
    // staleness of a fold nobody was reading into a property of every read of
    // the stream, and since a read refreshes only its own fold, the condition
    // could not be cleared by any read at all.
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

    // Reading the CURRENT projection answers, and answers cleanly. The sibling
    // stays stale in cache and is repaired by the next read OF IT.
    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(degradedMeta(result), 'an unread fold is not a fact about this answer').toBeUndefined();
    expect(
      materializer.getState(STREAM, sibling.viewName)?.highWaterMark,
      'reading one fold must not silently touch another',
    ).toBe(1);

    // …and reading the sibling repairs the sibling.
    const siblingRead = await handleView({ action: 'delegation_readiness', workflowId: STREAM }, ctx);
    expect(siblingRead.success, JSON.stringify(siblingRead.error)).toBe(true);
    expect(materializer.getState(STREAM, sibling.viewName)?.highWaterMark).toBe(4);
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
//
// T-07 (DR-4, consumption half): the durable state is now READ by every
// projection-derived consumer (`exarchos_view`, `exarchos_workflow get`, the
// four materializer-backed `exarchos_orchestrate` readiness/reliability
// actions), each returning the ONE shared typed degraded result
// (`projections/degraded-result.ts`) instead of `success: true` with a stale
// payload. `HandleView_ProjectionAheadOfPrunedLog_ReturnsTypedDegradedMarker`
// above carries the resulting oracle update; the other three `HandleView_*`
// cases are unchanged. See `degraded-consumers.test.ts` for the consumer sweep.
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

  /** The fold these journal cases judge — one named view, as production does. */
  const JUDGED_VIEW = 'workflow-status';

  /**
   * Warm a REAL fold through the real view chokepoint, then drive its cursor to
   * `cursor`. This is the fault under test: a materialized projection whose
   * high-water mark no longer matches the durable tail.
   *
   * It rewinds ONE named fold. The version before #1855 looped over every
   * cursor on the stream and set them all, because the verdict under test
   * quantified over all of them — which meant the recovery case reached its
   * precondition through an input no production path can produce (a read
   * advances exactly one fold). Judging one named fold keeps the fixture inside
   * what the system can actually do.
   */
  async function warmFoldAndSetCursor(cursor: number): Promise<void> {
    await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    const materializer = getOrCreateMaterializer(stateDir);
    const state = materializer.getState(STREAM, JUDGED_VIEW);
    expect(state, 'test needs a real materialized fold').toBeDefined();
    if (state) materializer.loadState(STREAM, JUDGED_VIEW, state.view, cursor);
  }

  /** The REAL cursor/tail comparison — no synthetic numbers, no mocked store. */
  async function assessLive(): Promise<ReturnType<typeof assessProjectionFreshness>> {
    const materializer = getOrCreateMaterializer(stateDir);
    return assessProjectionFreshness({
      eventTail: await store.tailSequence(STREAM),
      projectionCursor: materializer.getState(STREAM, JUDGED_VIEW)?.highWaterMark ?? 0,
      viewName: JUDGED_VIEW,
    });
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
      projectionDegradedIdempotencyKey(STREAM, 4, 1, 0),
    );
  });

  it('ProjectionDegraded_RedetectionAfterRecovery_FoldEndsDegraded', async () => {
    // Regression: the degraded key used to be keyed on (streamId, eventTail,
    // cursor) alone. Degrade → recover → degrade AGAIN at the IDENTICAL pair
    // (cursor regression via snapshot restore/rebuild — this module's own
    // documented scenario) deduped the second `projection.degraded` onto the
    // ORIGINAL row, whose sequence precedes the recovered event — so the fold
    // ended 'recovered' and the degraded stream was served as healthy.
    await seedEvents(4);
    await warmFoldAndSetCursor(1);
    expect(await publishProjectionFreshness(store, STREAM, await assessLive())).toBeDefined();

    // The fold catches the tail: recovered.
    await warmFoldAndSetCursor(4);
    await publishProjectionFreshness(store, STREAM, await assessLive());
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();

    // The cursor regresses to the IDENTICAL (eventTail, cursor) pair.
    await warmFoldAndSetCursor(1);
    const freshness = await assessLive();
    expect(freshness).toMatchObject({ degraded: true, eventTail: 4, projectionCursor: 1 });

    const republished = await publishProjectionFreshness(store, STREAM, freshness);
    expect(republished, 'the re-detection must produce a durable state').toBeDefined();

    // The fold must end 'degraded': the re-detection minted a NEW row PAST the
    // recovered event instead of collapsing onto the pre-recovery one.
    const durable = await readProjectionDegradedState(store, STREAM);
    expect(durable, 'a re-degraded stream must not be served as healthy').toMatchObject({
      streamId: STREAM,
      reason: 'projection-behind',
      eventTail: 4,
      projectionCursor: 1,
    });

    // Two degraded rows persisted (one per generation) — history, not spam:
    // repeated re-detections WITHIN the new generation still collapse.
    await publishProjectionFreshness(store, STREAM, await assessLive());
    const persisted = await store.query(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_DEGRADED_EVENT_TYPE,
    });
    expect(persisted).toHaveLength(2);
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
