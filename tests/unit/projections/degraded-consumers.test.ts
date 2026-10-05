/**
 * Every consumer that answers from a projection folds its own view to the durable tail first.
 * So each consumer answers from the tail, and a durable `projection.degraded` row cannot block it.
 * `CONSUMERS` lists the surfaces that a change to `src/projections/fold-at-tail.ts` must keep covered.
 *
 * No test mocks a reader. To inject a stale fold, a test warms a fold through the view handler on a real `EventStore`.
 * Then it rewinds the high-water mark of that fold with `materializer.loadState`.
 * `publishProjectionFreshness` writes the durable row from the comparison of the live cursor with the tail.
 */

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
 * Injects a stale fold. It warms a fold through the view handler.
 * Then it sets the high-water mark of the `workflow-state` fold to `cursor`, short of the durable tail.
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

/**
 * `CONSUMERS` lists the composite actions whose answer comes from a cached fold.
 * Each action runs against a stale cursor and a durable degraded row.
 * A readiness verdict can be negative, but the action must not withhold it with `PROJECTION_DEGRADED`.
 */
describe('#1855 — every readiness/workflow/reliability consumer answers', () => {
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

      expect(
        errorCode(result),
        `${label} refused a read it could have folded: ${JSON.stringify(result.error)}`,
      ).not.toBe(PROJECTION_DEGRADED_ERROR_CODE);
      expect(isProjectionDegradedResult(result)).toBe(false);
    });
  }

  /**
   * A fold rewound to sequence 1 did not see the transition to `plan-review`.
   * So an answer with that phase came from the durable tail and not from the stale fold.
   */
  it('Consumer_RewoundFold_AnswersFromTheTail', async () => {
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

describe('#1855 — the reserved code still separates its neighbours', () => {
  /** The store answers truly that a stream has no events. So `get` must not report `PROJECTION_DEGRADED` for that stream. */
  it('DegradedResult_IsNotConfusableWithNoData', async () => {
    const empty = await handleWorkflow({ action: 'get', featureId: 'never-written' }, ctx);
    expect(errorCode(empty)).not.toBe(PROJECTION_DEGRADED_ERROR_CODE);
    expect(isProjectionDegradedResult(empty)).toBe(false);
  });

  /** An unknown action on a stream with a degraded row still reports `UNKNOWN_ACTION`, not a projection error. */
  it('DegradedResult_IsNotConfusableWithGenuineFailure', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();

    const bogus = await handleWorkflow({ action: 'no_such_action', featureId: STREAM }, ctx);
    expect(bogus.success).toBe(false);
    expect(errorCode(bogus)).toBe('UNKNOWN_ACTION');
    expect(isProjectionDegradedResult(bogus)).toBe(false);
    expect(bogus.error?.projectionDegraded).toBeUndefined();
  });

  /** A remedy that names the failed call makes the caller repeat the same read. `isSameCall` detects that circular remedy. */
  it('SuggestedFix_NeverNamesTheCallThatFailed', () => {
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

describe('#1855 — a spent observation clears', () => {
  /** A read that answers proves that the stream is servable, so the view handler clears the durable row. */
  it('DegradedRow_SurvivingRead_IsClearedByTheViewChokepoint', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();
    expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();

    const reread = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(reread.success).toBe(true);
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();
  });

  /** Writes go to the authoritative log, and `reconcile` repairs the projection. A degraded row must not block either action. */
  it('WorkflowMutationsAndRecoveryActions_StayUnguarded', async () => {
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
