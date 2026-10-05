/**
 * Each read that answers from a projection folds its own view to the durable tail first.
 * A fold behind the tail folds forward. A fold ahead of the tail is discarded and replayed from the log.
 * `PROJECTION_DEGRADED` means only that a fold ended short of its pinned tail.
 *
 * No test mocks a reader. Each test uses a real `EventStore` in a temporary directory and the composite handlers.
 * A test injects a fault with `loadState`, which rewinds a materialized cursor.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import { foldPairToTail, foldToTail } from '../../../src/projections/fold-at-tail.js';
import {
  PROJECTION_HEALTH_STREAM_ID,
  PROJECTION_DEGRADED_EVENT_TYPE,
  readProjectionDegradedState,
} from '../../../src/projections/freshness.js';
import { handleView } from '../../../src/projections/views/composite.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../../../src/projections/views/tools.js';
import {
  WORKFLOW_STATE_VIEW,
  workflowStateProjection,
  type WorkflowStateView,
} from '../../../src/projections/views/workflow-state-projection.js';
import { ViewMaterializer } from '../../../src/projections/views/materializer.js';
import { handleWorkflow } from '../../../src/workflow/composite.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** Only the cursor matters for the pair test, so the shape is deliberately loose. */
type WorkflowStatusLike = Record<string, unknown>;

/**
 * A store that appends one event between the tail pin and a query of the fold, as a concurrent writer does.
 * Without that event the bound has nothing to exclude, and a test stays green when the bound is removed.
 */
class RacingEventStore extends EventStore {
  private queries = 0;

  constructor(
    stateDir: string,
    private readonly raceOnQuery: number,
    private readonly raceStream: string,
  ) {
    super(stateDir);
  }

  override async query(
    streamId: string,
    filters?: Parameters<EventStore['query']>[1],
  ): Promise<Awaited<ReturnType<EventStore['query']>>> {
    this.queries += 1;
    if (this.queries === this.raceOnQuery) {
      await super.append(this.raceStream, { type: 'task.progressed', data: { raced: true } });
    }
    return super.query(streamId, filters);
  }
}


/**
 * A store whose tail outruns what it can produce — the one condition
 * `foldToTail` refuses to answer through. `tailSequence` claims events the log
 * cannot return, so no fold can be shown to cover it.
 */
class UnprovableTailEventStore extends EventStore {
  override async tailSequence(streamId: string): Promise<number> {
    return (await super.tailSequence(streamId)) + 10;
  }
}

const STREAM = 'fold-at-tail-feature';

let stateDir: string;
let store: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  resetMaterializerCache();
  stateDir = await mkdtemp(nodePath.join(tmpdir(), 'fold-at-tail-'));
  store = new EventStore(stateDir);
  await store.initialize();
  ctx = { stateDir, eventStore: store, enableTelemetry: false };
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  resetMaterializerCache();
});

async function seedWorkflow(): Promise<void> {
  const init = await handleWorkflow(
    { action: 'init', featureId: STREAM, workflowType: 'feature' },
    ctx,
  );
  expect(init.success, `seed init failed: ${JSON.stringify(init.error)}`).toBe(true);
}

/** Folds `workflow-state` into the shared view materializer, then appends events so that fold lags the tail. */
async function foldWorkflowStateThenAppend(appends: number): Promise<void> {
  const materializer = getOrCreateMaterializer(stateDir);
  await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);
  for (let i = 0; i < appends; i++) {
    await store.append(STREAM, { type: 'task.progressed', data: { i } });
  }
}

describe('#1855 — the wedge', () => {
  /** The `workflow-state` fold is one event behind, and the `workflow_status` read does not use that fold. */
  it('FoldAtTail_StaleSiblingFold_DoesNotRefuseAnUnrelatedViewRead', async () => {
    await seedWorkflow();
    await foldWorkflowStateThenAppend(1);

    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    expect(result.error?.code, JSON.stringify(result.error)).not.toBe('PROJECTION_DEGRADED');
    expect(result.success).toBe(true);
  });

  /** An append lands before each attempt, so the lag never drains. Each read must still answer. */
  it('FoldAtTail_RepeatedReadsOnAnAppendingStream_AllSucceed', async () => {
    await seedWorkflow();
    await foldWorkflowStateThenAppend(1);

    for (let attempt = 0; attempt < 3; attempt++) {
      await store.append(STREAM, { type: 'task.progressed', data: { attempt } });
      const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
      expect(result.success, `attempt ${attempt}: ${JSON.stringify(result.error)}`).toBe(true);
    }
  });

  it('FoldAtTail_WorkflowGet_IsNotWedgedByASiblingFold', async () => {
    await seedWorkflow();
    await foldWorkflowStateThenAppend(1);

    const result = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);

    expect(result.error?.code, JSON.stringify(result.error)).not.toBe('PROJECTION_DEGRADED');
    expect(result.success).toBe(true);
  });

  /**
   * The durable marker holds numbers that do not match this store. It is an observation at one time.
   * A read that proves its own coverage must not defer to the marker, and a view read clears it.
   */
  it('FoldAtTail_FabricatedDegradedMarker_DoesNotWedgeAHealthyStream', async () => {
    await seedWorkflow();

    await store.append(PROJECTION_HEALTH_STREAM_ID, {
      type: PROJECTION_DEGRADED_EVENT_TYPE,
      data: {
        streamId: STREAM,
        reason: 'projection-behind',
        eventTail: 42,
        projectionCursor: 13,
        lag: 29,
        staleViews: ['workflow-state'],
      },
    });
    expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();

    const get = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(get.success, JSON.stringify(get.error)).toBe(true);

    const view = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(view.success).toBe(true);
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();
  });
});

describe('#1855 — a read never answers from a fold behind the tail', () => {
  /**
   * The test warms a fold, rewinds its cursor to 1, then moves the stream.
   * The assertion is on the answer: the phase at the tail.
   */
  it('FoldAtTail_RewoundFold_AnswersFromTheTailNotFromTheStaleFold', async () => {
    await seedWorkflow();
    const materializer = getOrCreateMaterializer(stateDir);

    const warm = await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);
    const rewound = materializer.getState<WorkflowStateView>(STREAM, WORKFLOW_STATE_VIEW);
    expect(rewound, 'the fault needs a real materialized fold').toBeDefined();
    materializer.loadState(STREAM, WORKFLOW_STATE_VIEW, rewound!.view, 1);

    const stamped = await handleWorkflow(
      {
        action: 'update',
        featureId: STREAM,
        updates: { artifacts: { plan: 'a plan the transition guard accepts' } },
      },
      ctx,
    );
    expect(stamped.success, JSON.stringify(stamped.error)).toBe(true);
    const transition = await handleWorkflow(
      { action: 'transition', featureId: STREAM, target: 'plan-review' },
      ctx,
    );
    expect(transition.success, JSON.stringify(transition.error)).toBe(true);

    const refolded = await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);
    expect(refolded.sequence).toBe(await store.tailSequence(STREAM));
    expect(refolded.sequence).toBeGreaterThan(warm.sequence);
    expect(refolded.view.phase, 'the answer came from the stale fold, not the tail').toBe(
      'plan-review',
    );
  });

  /**
   * The cursor is past the tail and the payload is corrupt (`projection-ahead`).
   * A re-fold filtered by the high-water mark applies no event, so the fold must be discarded and replayed.
   */
  it('FoldAtTail_ContradictoryFold_IsDiscardedAndReplayedFromTheLog', async () => {
    await seedWorkflow();
    const materializer = getOrCreateMaterializer(stateDir);

    const warm = await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);
    const tail = await store.tailSequence(STREAM);

    materializer.loadState(
      STREAM,
      WORKFLOW_STATE_VIEW,
      { ...warm.view, phase: 'synthesize' } as WorkflowStateView,
      tail + 50,
    );

    const repaired = await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);

    expect(repaired.sequence).toBe(tail);
    expect(repaired.view.phase, 'the contradictory payload survived the repair').toBe('plan');
    expect(repaired.repaired?.reason, 'the repair must stay observable').toBe('projection-ahead');
  });

  it('FoldAtTail_ColdStream_CoversTheTailWithNoWarmFold', async () => {
    await seedWorkflow();
    await store.append(STREAM, { type: 'task.progressed', data: {} });

    const folded = await foldToTail<WorkflowStateView>(
      store,
      getOrCreateMaterializer(stateDir),
      STREAM,
      WORKFLOW_STATE_VIEW,
    );

    expect(folded.sequence).toBe(await store.tailSequence(STREAM));
    expect(folded.repaired).toBeUndefined();
  });

  /**
   * A caller bounds its own evidence to the reported sequence.
   * The emissions gate reads the phase from the fold, then filters the raw events to that sequence.
   * A fold past its pin makes the two parts describe different states of the stream.
   * The raced event moves the tail, and the fold still answers for the pinned sequence.
   */
  it('FoldAtTail_AppendLandsMidFold_SequenceStaysOnThePinnedTail', async () => {
    await seedWorkflow();
    const racing = new RacingEventStore(stateDir, 1, STREAM);
    await racing.initialize();
    try {
      const materializer = getOrCreateMaterializer(stateDir);
      const pinned = await racing.tailSequence(STREAM);

      const folded = await foldToTail<WorkflowStateView>(
        racing,
        materializer,
        STREAM,
        WORKFLOW_STATE_VIEW,
      );

      expect(await racing.tailSequence(STREAM)).toBeGreaterThan(pinned);
      expect(folded.sequence).toBe(pinned);
    } finally {
      racing.close();
    }
  });

  /**
   * Two separate folds pin two tails, so a combined read can describe a state that the stream never had.
   * The attribution and correlation views combine two folds in this way.
   * The store appends an event between the two folds, and both views must stay at the one pinned sequence.
   */
  it('FoldPairToTail_TwoViews_ShareOneSequence', async () => {
    await seedWorkflow();
    const materializer = getOrCreateMaterializer(stateDir);

    const racing = new RacingEventStore(stateDir, 2, STREAM);
    await racing.initialize();
    try {
      const pair = await foldPairToTail<WorkflowStateView, WorkflowStatusLike>(
        racing,
        materializer,
        STREAM,
        WORKFLOW_STATE_VIEW,
        'workflow-status',
      );

      expect(await racing.tailSequence(STREAM)).toBeGreaterThan(pair.sequence);
      expect(materializer.getState(STREAM, WORKFLOW_STATE_VIEW)?.highWaterMark).toBe(pair.sequence);
      expect(materializer.getState(STREAM, 'workflow-status')?.highWaterMark).toBe(pair.sequence);
    } finally {
      racing.close();
    }
  });

  it('FoldAtTail_EmptyStream_IsCoveredAtSequenceZero', async () => {
    const folded = await foldToTail<WorkflowStateView>(
      store,
      getOrCreateMaterializer(stateDir),
      'never-written',
      WORKFLOW_STATE_VIEW,
    );

    expect(folded.sequence).toBe(0);
  });
});

describe('#1855 — a committed mutation is never reported as a failure', () => {
  /**
   * `update` must report a committed write as a success when the store claims a tail that the log cannot produce.
   * A healthy read then sees the write.
   */
  it('WorkflowUpdate_CoverageUnprovable_StillReportsTheCommittedWrite', async () => {
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await seedWorkflow();

    const lying = new UnprovableTailEventStore(stateDir);
    await lying.initialize();
    try {
      const update = await handleWorkflow(
        { action: 'update', featureId: STREAM, updates: { riskTier: 'low' } },
        { stateDir, eventStore: lying, enableTelemetry: false },
      );

      expect(update.success, JSON.stringify(update.error)).toBe(true);
      expect(update.error?.code).not.toBe('INTERNAL_ERROR');
    } finally {
      lying.close();
    }

    const get = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(get.success, JSON.stringify(get.error)).toBe(true);
    const data = get.data as { riskTier?: string; data?: { riskTier?: string } } | undefined;
    expect(data?.riskTier ?? data?.data?.riskTier).toBe('low');
  });

  /** A read against the same store must throw and not answer. `PROJECTION_DEGRADED` reports exactly this condition. */
  it('FoldAtTail_UnprovableCoverage_ThrowsRatherThanAnswering', async () => {
    await seedWorkflow();

    const lying = new UnprovableTailEventStore(stateDir);
    await lying.initialize();
    try {
      await expect(
        foldToTail<WorkflowStateView>(
          lying,
          getOrCreateMaterializer(stateDir),
          STREAM,
          WORKFLOW_STATE_VIEW,
        ),
      ).rejects.toThrow(/short of the durable tail/);
    } finally {
      lying.close();
    }
  });
});
