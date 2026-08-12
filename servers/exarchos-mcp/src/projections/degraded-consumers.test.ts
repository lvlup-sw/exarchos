// ─── DR-4 (T-07): every consumer returns a typed degraded result ────────────
//
// ## Characterization — what these consumers did BEFORE this task
//
// T-06 made ONE durable degraded state publishable (`projection.degraded` on
// `meta/projection-health`, read back through `readProjectionDegradedState`).
// Nothing consumed it. Every read surface below folded through the SAME
// in-memory materializer LRU that CB-8 caught lying, and answered
// `success: true` with the stale payload:
//
//   - `exarchos_view`      → `success: true`, degradation only whispered on the
//                            ephemeral `_meta.projectionDegraded` courtesy key.
//   - `exarchos_workflow`  → `success: true` off `moduleViewMaterializer`;
//                            no freshness signal at all, not even `_meta`.
//   - `exarchos_orchestrate` readiness/reliability actions
//                          → `success: true` off `getOrCreateMaterializer`;
//                            no freshness signal at all.
//
// A caller could therefore dispatch agents, gate a phase, or report a workflow
// complete from a fold that provably did not cover the durable tail.
//
// ## The change
//
// One shared typed degraded result (`projections/degraded-result.ts`) is now
// returned by every one of those consumers when `readProjectionDegradedState`
// reports the stream degraded: `success: false` with the reserved
// `PROJECTION_DEGRADED` error code and the durable state attached as
// `error.projectionDegraded`. The stale payload is DROPPED, not annotated.
//
// ## Fault injection (no mocked readers anywhere in this file)
//
// Every test drives a REAL stale cursor: seed real events on a real
// `EventStore`, warm a REAL fold through the REAL view chokepoint, then rewind
// that fold's high-water mark via `materializer.loadState(...)`. The durable
// `projection.degraded` row is then produced by the production publish path
// (the view chokepoint) or by `publishProjectionFreshness` fed from the REAL
// live cursor/tail comparison — never by stubbing `readProjectionDegradedState`.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../dispatch/core/dispatch.js';
import type { ToolResult } from '../format.js';
import { EventStore } from '../events/store.js';
import { handleView } from './views/composite.js';
import { handleWorkflow } from '../workflow/composite.js';
import { handleOrchestrate } from '../verbs/composite.js';
import { getOrCreateMaterializer } from './views/tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import {
  assessStreamFreshness,
  publishProjectionFreshness,
  readProjectionDegradedState,
} from './freshness.js';
import {
  isProjectionDegradedResult,
  PROJECTION_DEGRADED_ERROR_CODE,
} from './degraded-result.js';

const STREAM = 'dr4-consumers-feature';

let stateDir: string;
let store: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  stateDir = await mkdtemp(nodePath.join(tmpdir(), 'dr4-consumers-'));
  store = new EventStore(stateDir);
  await store.initialize();
  ctx = { stateDir, eventStore: store, enableTelemetry: false };
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** Seed a REAL workflow stream through the REAL init path, then real activity. */
async function seedWorkflow(): Promise<void> {
  const init = await handleWorkflow(
    { action: 'init', featureId: STREAM, workflowType: 'feature' },
    ctx,
  );
  expect(init.success, `seed init failed: ${JSON.stringify(init.error)}`).toBe(true);
  for (let i = 0; i < 3; i++) {
    await store.append(STREAM, { type: 'task.progressed', data: { i } });
  }
}

/**
 * The CB-8 fault, injected for real: warm a genuine fold through the genuine
 * view chokepoint, then rewind its high-water mark so the materialized cursor
 * provably stops short of the durable tail.
 */
async function injectStaleFold(cursor: number): Promise<void> {
  await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
  const materializer = getOrCreateMaterializer(stateDir);
  const cursors = materializer.getStreamCursors(STREAM);
  expect(cursors.length, 'fault injection needs a real materialized fold').toBeGreaterThan(0);
  for (const { viewName } of cursors) {
    const state = materializer.getState(STREAM, viewName);
    if (state) materializer.loadState(STREAM, viewName, state.view, cursor);
  }
}

/** Publish the durable row from the REAL live cursor/tail disagreement. */
async function publishLiveDegradation(): Promise<void> {
  const materializer = getOrCreateMaterializer(stateDir);
  const freshness = assessStreamFreshness(
    await store.tailSequence(STREAM),
    materializer.getStreamCursors(STREAM),
  );
  expect(freshness.degraded, 'fault injection must produce a real disagreement').toBe(true);
  await publishProjectionFreshness(store, STREAM, freshness);
  expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();
}

function errorCode(result: ToolResult): string | undefined {
  return result.error?.code;
}

describe('CHARACTERIZATION (superseded) — consumers served stale folds as success:true', () => {
  // These three cases are the RECORD of the pre-T-07 contract, rewritten to the
  // contract that replaced it. Each `expect` below inverts exactly one
  // assertion that used to read `expect(result.success).toBe(true)` with no
  // error code — the change is the deliverable, so the tests move with it
  // rather than being weakened to stay green.

  it('ViewComposite_DegradedProjection_ReturnsTypedDegradedResult', async () => {
    await seedWorkflow();
    // `projection-ahead`: a fold claiming events the log cannot produce. A
    // re-fold cannot heal it, so the disagreement survives the read that
    // observes it — exactly the snapshot-over-pruned-log case.
    await injectStaleFold(25);

    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    // WAS: success:true with the stale payload; degradation only on `_meta`.
    expect(result.success).toBe(false);
    expect(errorCode(result)).toBe(PROJECTION_DEGRADED_ERROR_CODE);
    expect(isProjectionDegradedResult(result)).toBe(true);
    expect(result.error?.projectionDegraded).toMatchObject({
      streamId: STREAM,
      reason: 'projection-ahead',
      eventTail: 4,
      projectionCursor: 25,
      lag: -21,
    });
    // The stale payload is DROPPED, not annotated — a caller branching on
    // `success` must not be able to reach it.
    expect(result.data).toBeUndefined();
  });

  it('WorkflowComposite_DegradedProjection_DoesNotReturnStalePayload', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();

    const result = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);

    // WAS: success:true off the materializer LRU, with no freshness signal.
    expect(result.success).toBe(false);
    expect(errorCode(result)).toBe(PROJECTION_DEGRADED_ERROR_CODE);
    expect(result.data).toBeUndefined();
    expect(result.error?.projectionDegraded).toMatchObject({
      streamId: STREAM,
      reason: 'projection-behind',
      eventTail: 4,
      projectionCursor: 1,
      lag: 3,
    });
  });

  it('OrchestrateComposite_DegradedProjection_ReturnsTypedDegradedResult', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();

    const result = await handleOrchestrate(
      { action: 'check_convergence', featureId: STREAM },
      ctx,
    );

    // WAS: success:true carrying a convergence verdict computed off a fold
    // that provably did not cover the tail.
    expect(result.success).toBe(false);
    expect(errorCode(result)).toBe(PROJECTION_DEGRADED_ERROR_CODE);
    expect(result.data).toBeUndefined();
  });
});

// ─── Every consumer, one shape ──────────────────────────────────────────────

describe('DR-4 — every readiness/workflow/reliability consumer refuses', () => {
  /**
   * The full enumeration, derived mechanically rather than assumed: these are
   * the composite actions whose answer flows through the materializer LRU
   * (`git grep -l materializer -- src/{views,workflow,orchestrate}`). Each is
   * driven here against a REAL durable `projection.degraded` row.
   */
  const CONSUMERS: ReadonlyArray<{
    readonly label: string;
    readonly run: () => Promise<ToolResult>;
  }> = [
    {
      label: 'exarchos_view workflow_status',
      run: () => handleView({ action: 'workflow_status', workflowId: STREAM }, ctx),
    },
    {
      label: 'exarchos_view delegation_readiness (readiness)',
      run: () => handleView({ action: 'delegation_readiness', workflowId: STREAM }, ctx),
    },
    {
      label: 'exarchos_view synthesis_readiness (readiness)',
      run: () => handleView({ action: 'synthesis_readiness', workflowId: STREAM }, ctx),
    },
    {
      label: 'exarchos_view gate_reliability (reliability)',
      run: () => handleView({ action: 'gate_reliability', workflowId: STREAM }, ctx),
    },
    {
      label: 'exarchos_view tasks',
      run: () => handleView({ action: 'tasks', workflowId: STREAM }, ctx),
    },
    {
      label: 'exarchos_workflow get',
      run: () => handleWorkflow({ action: 'get', featureId: STREAM }, ctx),
    },
    {
      label: 'exarchos_orchestrate check_convergence (reliability)',
      run: () => handleOrchestrate({ action: 'check_convergence', featureId: STREAM }, ctx),
    },
    {
      label: 'exarchos_orchestrate check_event_emissions (reliability)',
      run: () => handleOrchestrate({ action: 'check_event_emissions', featureId: STREAM }, ctx),
    },
    {
      label: 'exarchos_orchestrate prepare_delegation (readiness)',
      run: () => handleOrchestrate({ action: 'prepare_delegation', featureId: STREAM }, ctx),
    },
    {
      label: 'exarchos_orchestrate prepare_synthesis (readiness)',
      run: () => handleOrchestrate({ action: 'prepare_synthesis', featureId: STREAM }, ctx),
    },
  ];

  for (const { label, run } of CONSUMERS) {
    it(`Consumer_DegradedProjection_ReturnsTypedDegradedResult [${label}]`, async () => {
      await seedWorkflow();
      // A fold ahead of the log: the disagreement is real, is published by the
      // production view chokepoint, and cannot be healed by a re-fold — so the
      // durable row still stands when each consumer below is driven.
      await injectStaleFold(25);
      await publishLiveDegradation();

      const result = await run();

      expect(result.success, `${label} must not answer from a stale fold`).toBe(false);
      expect(errorCode(result)).toBe(PROJECTION_DEGRADED_ERROR_CODE);
      // ONE shape, reused verbatim — not a per-consumer dialect.
      expect(result.error?.projectionDegraded).toMatchObject({
        streamId: STREAM,
        reason: 'projection-ahead',
        eventTail: 4,
        projectionCursor: 25,
      });
      expect(result.error?.suggestedFix?.tool).toBe('exarchos_view');
      expect(result.data, 'the stale payload must be dropped, not annotated').toBeUndefined();
    });
  }
});

// ─── Causality: degraded ≠ no data ≠ genuine failure ────────────────────────

describe('DR-4 — a degraded result is distinguishable from its neighbours', () => {
  it('DegradedResult_IsNotConfusableWithNoData', async () => {
    // "No data": a stream that was never written. The store WAS asked and
    // answered truthfully — that is a fact about the tail, not a failure to
    // read it, so it must NOT carry the reserved code.
    const empty = await handleWorkflow({ action: 'get', featureId: 'never-written' }, ctx);
    expect(errorCode(empty)).not.toBe(PROJECTION_DEGRADED_ERROR_CODE);
    expect(isProjectionDegradedResult(empty)).toBe(false);

    // Degraded: the same surface, same success:false, DIFFERENT code — and
    // unlike the above it reports how far the fold missed by.
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();
    const degraded = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(isProjectionDegradedResult(degraded)).toBe(true);
    expect(degraded.error?.projectionDegraded?.lag).toBe(3);
    expect(errorCode(degraded)).not.toBe(errorCode(empty));
  });

  it('DegradedResult_IsNotConfusableWithGenuineFailure', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();

    // A real input fault on a degraded stream still reports the input fault:
    // an unknown action is not a projection problem and must not be laundered
    // into one (nor the reverse).
    const bogus = await handleWorkflow({ action: 'no_such_action', featureId: STREAM }, ctx);
    expect(bogus.success).toBe(false);
    expect(errorCode(bogus)).toBe('UNKNOWN_ACTION');
    expect(isProjectionDegradedResult(bogus)).toBe(false);
    expect(bogus.error?.projectionDegraded).toBeUndefined();
  });

  it('HealthyStream_NoDurableRow_ConsumersAnswerNormally', async () => {
    // The negative control. Without fault injection every consumer answers as
    // before — the guard must not degrade a healthy stream.
    await seedWorkflow();
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();

    const view = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(view.success).toBe(true);
    expect(isProjectionDegradedResult(view)).toBe(false);

    const wf = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(wf.success).toBe(true);
    expect(isProjectionDegradedResult(wf)).toBe(false);

    const orch = await handleOrchestrate(
      { action: 'check_convergence', featureId: STREAM },
      ctx,
    );
    expect(isProjectionDegradedResult(orch)).toBe(false);
  });
});

// ─── Recovery: the refusal is a step, not a dead end ────────────────────────

describe('DR-4 — recovery clears the refusal', () => {
  it('DegradedStream_RefoldViaViewChokepoint_PublishesRecoveryAndUnblocksConsumers', async () => {
    await seedWorkflow();
    // A fold merely BEHIND the tail — the case a re-fold genuinely repairs.
    await injectStaleFold(1);
    await publishLiveDegradation();
    expect(
      isProjectionDegradedResult(await handleWorkflow({ action: 'get', featureId: STREAM }, ctx)),
    ).toBe(true);

    // The view chokepoint is the publisher: reading through it re-folds to the
    // tail, observes agreement, and emits the paired `projection.recovered`.
    const reread = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(reread.success).toBe(true);
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();

    // …which releases the pure consumers. A refusal that could not be cleared
    // would be a wedge, not a safeguard.
    const wf = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(wf.success).toBe(true);
    expect(isProjectionDegradedResult(wf)).toBe(false);
  });

  it('WorkflowMutationsAndRecoveryActions_StayUnguarded', async () => {
    // Causality: writes land on the authoritative log and `reconcile` REPAIRS
    // the projection. Refusing either because a derived read is stale would
    // block progress on a healthy source of truth, and deadlock the one action
    // able to clear the state.
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();
    expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();

    const reconcile = await handleWorkflow({ action: 'reconcile', featureId: STREAM }, ctx);
    expect(isProjectionDegradedResult(reconcile)).toBe(false);

    const update = await handleWorkflow(
      { action: 'update', featureId: STREAM, updates: { riskTier: 'low' } },
      ctx,
    );
    expect(isProjectionDegradedResult(update)).toBe(false);
  });
});
