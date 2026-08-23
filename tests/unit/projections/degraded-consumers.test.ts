// ─── Every projection-derived consumer answers from a tail-covering fold ────
//
// ## What this file used to assert, and why it moved
//
// A dogfood run caught workflow views serving a silently stale fold: a cancelled
// workflow reported at `plan-review`, 7 of 10 completed tasks visible, lag past
// 500s. The answer shipped for it made the verdict durable
// (`projection.degraded` on `meta/projection-health`) and had every
// readiness / workflow / reliability consumer REFUSE on it. This file was the
// enumeration of those consumers, and every case asserted the refusal.
//
// The refusal was the wrong remedy for the right harm (#1855). It was published
// durably from a point-in-time observation of one process's cache and never
// revalidated, only the refused surface could clear it, and the freshness
// predicate quantified over every cached fold of a stream while a read advances
// exactly one — so on a live stream it could not be cleared at all. `workflow
// get` stayed unreadable on a lag of ONE event, and a fabricated marker wedged
// workflows that were never unhealthy.
//
// ## What it asserts now
//
// The same enumeration, against the claim that replaced the refusal: each
// consumer folds its own view to the stream's durable tail before answering
// (`projections/fold-at-tail.ts`), so it ANSWERS, it answers from the tail, and
// no durable marker can wedge it. The enumeration is worth keeping — it is the
// list of surfaces that can serve a projection-derived answer, and that list is
// what a future change to the seam has to keep covered.
//
// The guarantee is stronger here than it was under the refusal, because the
// assertion is about the ANSWER rather than about the presence of an error:
// `Consumer_RewoundFold_AnswersFromTheTail` reads the phase back and requires
// it to be the phase at the tail, which a stale fold cannot produce.
//
// ## Fault injection (no mocked readers anywhere in this file)
//
// Every test drives a REAL stale cursor on a REAL `EventStore`: warm a REAL
// fold through the REAL view chokepoint, then rewind that fold's high-water
// mark via `materializer.loadState(...)`. Durable rows are produced by
// `publishProjectionFreshness` fed from the REAL live cursor/tail comparison,
// never by stubbing `readProjectionDegradedState`.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../src/format.js';
import { EventStore } from '../../../src/events/store.js';
import { handleView } from '../../../src/projections/views/composite.js';
import { handleWorkflow } from '../../../src/workflow/composite.js';
import { handleOrchestrate } from '../../../src/verbs/composite.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import {
  assessProjectionFreshness,
  publishProjectionFreshness,
  readProjectionDegradedState,
} from '../../../src/projections/freshness.js';
import {
  isProjectionDegradedResult,
  isSameCall,
  PROJECTION_DEGRADED_ERROR_CODE,
} from '../../../src/projections/degraded-result.js';

const STREAM = 'dr4-consumers-feature';
/** The fold `workflow get` and the workflow-shaped verbs read. */
const JUDGED_VIEW = 'workflow-state';

let stateDir: string;
let store: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  resetMaterializerCache();
  stateDir = await mkdtemp(nodePath.join(tmpdir(), 'dr4-consumers-'));
  store = new EventStore(stateDir);
  await store.initialize();
  ctx = { stateDir, eventStore: store, enableTelemetry: false };
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  resetMaterializerCache();
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
 * The stale-fold fault, injected for real: warm a genuine fold through the genuine
 * view chokepoint, then rewind ONE named fold's high-water mark so the
 * materialized cursor provably stops short of the durable tail.
 */
async function injectStaleFold(cursor: number): Promise<void> {
  await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
  const materializer = getOrCreateMaterializer(stateDir);
  const state = materializer.getState(STREAM, JUDGED_VIEW)
    ?? materializer.getState(STREAM, 'workflow-status');
  expect(state, 'fault injection needs a real materialized fold').toBeDefined();
  if (state) materializer.loadState(STREAM, JUDGED_VIEW, state.view, cursor);
}

/** Publish the durable row from the REAL live cursor/tail disagreement. */
async function publishLiveDegradation(): Promise<void> {
  const materializer = getOrCreateMaterializer(stateDir);
  const freshness = assessProjectionFreshness({
    eventTail: await store.tailSequence(STREAM),
    projectionCursor: materializer.getState(STREAM, JUDGED_VIEW)?.highWaterMark ?? 0,
    viewName: JUDGED_VIEW,
  });
  expect(freshness.degraded, 'fault injection must produce a real disagreement').toBe(true);
  await publishProjectionFreshness(store, STREAM, freshness);
  expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();
}

function errorCode(result: ToolResult): string | undefined {
  return result.error?.code;
}

// ─── Every consumer, one claim ──────────────────────────────────────────────

describe('#1855 — every readiness/workflow/reliability consumer answers', () => {
  /**
   * The full enumeration, derived mechanically rather than assumed: these are
   * the composite actions whose answer flows through a cached fold. Each is
   * driven here against a REAL stale cursor AND a REAL durable degraded row —
   * the exact state that used to refuse all ten.
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
      run: () =>
        handleOrchestrate({ action: 'prepare_synthesis', featureId: STREAM, repoRoot: process.cwd() }, ctx),
    },
  ];

  for (const { label, run } of CONSUMERS) {
    it(`Consumer_StaleFoldAndDurableMarker_IsNotWedged [${label}]`, async () => {
      await seedWorkflow();
      await injectStaleFold(1);
      await publishLiveDegradation();

      const result = await run();

      // Each of these ten returned `PROJECTION_DEGRADED` before, and stayed
      // returning it: the marker could only be cleared by a surface the same
      // marker disabled. A readiness verdict may still legitimately be
      // negative — what it may not be is withheld because a cache lagged.
      expect(
        errorCode(result),
        `${label} refused a read it could have folded: ${JSON.stringify(result.error)}`,
      ).not.toBe(PROJECTION_DEGRADED_ERROR_CODE);
      expect(isProjectionDegradedResult(result)).toBe(false);
    });
  }

  it('Consumer_RewoundFold_AnswersFromTheTail', async () => {
    // The guarantee itself — a read never answers from a fold that has not seen
    // events already durable when it was asked — stated as a claim about the
    // ANSWER rather than about the presence of an error. A fold rewound to sequence 1 has not seen
    // the transition; if the answer still carries the tip phase, it was not
    // served from the stale fold.
    await seedWorkflow();
    const stamped = await handleWorkflow(
      {
        action: 'update',
        featureId: STREAM,
        updates: { artifacts: { plan: 'a plan the transition guard accepts' } },
      },
      ctx,
    );
    expect(stamped.success, JSON.stringify(stamped.error)).toBe(true);
    const moved = await handleWorkflow(
      { action: 'transition', featureId: STREAM, target: 'plan-review' },
      ctx,
    );
    expect(moved.success, JSON.stringify(moved.error)).toBe(true);

    await injectStaleFold(1);

    const result = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    const data = result.data as { data?: { phase?: string }; phase?: string } | undefined;
    expect(
      data?.phase ?? data?.data?.phase,
      'the answer came from the rewound fold, not from the durable tail',
    ).toBe('plan-review');
  });
});

// ─── Causality: undecidable ≠ no data ≠ genuine failure ─────────────────────

describe('#1855 — the reserved code still separates its neighbours', () => {
  it('DegradedResult_IsNotConfusableWithNoData', async () => {
    // "No data": a stream that was never written. The store WAS asked and
    // answered truthfully — a fact about the tail, not a failure to read it.
    const empty = await handleWorkflow({ action: 'get', featureId: 'never-written' }, ctx);
    expect(errorCode(empty)).not.toBe(PROJECTION_DEGRADED_ERROR_CODE);
    expect(isProjectionDegradedResult(empty)).toBe(false);
  });

  it('DegradedResult_IsNotConfusableWithGenuineFailure', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();

    // An input fault on a stream carrying a degraded marker still reports the
    // input fault. An unknown action is not a projection problem and must not
    // be laundered into one, nor the reverse.
    const bogus = await handleWorkflow({ action: 'no_such_action', featureId: STREAM }, ctx);
    expect(bogus.success).toBe(false);
    expect(errorCode(bogus)).toBe('UNKNOWN_ACTION');
    expect(isProjectionDegradedResult(bogus)).toBe(false);
    expect(bogus.error?.projectionDegraded).toBeUndefined();
  });

  it('SuggestedFix_NeverNamesTheCallThatFailed', () => {
    // The loop #1855 reported: the remedy was a constant naming
    // `exarchos_view workflow_status`, so when that was the refusing surface
    // the caller retried the identical read, failed identically, and each
    // attempt left a window for more events to land.
    expect(
      isSameCall(
        { tool: 'exarchos_event', params: { action: 'query', stream: STREAM } },
        { tool: 'exarchos_event', action: 'query' },
      ),
      'a remedy identical to the failing call must be recognised as circular',
    ).toBe(true);
    expect(
      isSameCall(
        { tool: 'exarchos_event', params: { action: 'query', stream: STREAM } },
        { tool: 'exarchos_view', action: 'workflow_status' },
      ),
    ).toBe(false);
  });
});

// ─── The journal records live conditions, it does not latch ─────────────────

describe('#1855 — a spent observation clears', () => {
  it('DegradedRow_SurvivingRead_IsClearedByTheViewChokepoint', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();
    expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();

    // A read that answers is proof the stream is servable, so the row it still
    // carries is a spent observation. Before #1855 this was the ONLY way to
    // clear the row and it was unreachable on a live stream; now it is a
    // bookkeeping step on a read that was never blocked.
    const reread = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(reread.success).toBe(true);
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();
  });

  it('WorkflowMutationsAndRecoveryActions_StayUnguarded', async () => {
    // Causality, unchanged: writes land on the authoritative log and
    // `reconcile` REPAIRS the projection. Neither may be refused because a
    // derived read lagged.
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
