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
  assessProjectionFreshness,
  assessStreamFreshness,
  toProjectionDegradedMeta,
  PROJECTION_DEGRADED_META,
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
    const siblingState = materializer.getState(STREAM, sibling!.viewName);
    materializer.loadState(STREAM, sibling!.viewName, siblingState!.view, 1);

    // Reading the CURRENT projection still reports the stream as degraded.
    const result = await handleView(
      { action: 'workflow_status', workflowId: STREAM },
      ctx,
    );
    const meta = degradedMeta(result);
    expect(meta, 'a stale sibling fold must degrade the stream answer').toBeDefined();
    expect(meta).toMatchObject({ reason: 'projection-behind', eventTail: 4 });
    expect(meta?.['staleViews']).toContain(sibling!.viewName);
  });

  it('HandleView_NoWorkflowId_LeavesResponseUntouched', async () => {
    const result = await handleView({ action: 'describe' }, ctx);
    expect(degradedMeta(result)).toBeUndefined();
  });
});
