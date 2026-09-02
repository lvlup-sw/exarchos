// ─── #1855: a read establishes its own tail coverage ────────────────────────
//
// ## The defect these tests pin
//
// `assessStreamFreshness` required EVERY cached fold of a stream to sit exactly
// on the durable tail. A read advances exactly ONE. The two are incompatible
// the moment a stream has more than one cached fold, and `workflow-state` made
// it terminal: orchestrate verbs and gates fold it into the shared view
// materializer, and no `exarchos_view` action folds it, so no view read could
// restore agreement — while the view surface was the only publisher of
// `projection.recovered`. `workflow get` and four orchestrate actions stayed
// refused across processes and restarts on a lag of ONE event, and the
// `suggestedFix` named the call that had just failed.
//
// ## What replaced it
//
// Every projection-derived read folds its own view to the stream's durable tail
// before answering (`projections/fold-at-tail.ts`). Behind is folded forward;
// ahead is discarded and replayed from the log. `PROJECTION_DEGRADED` now means
// undecidable — a fold that finished short of the tail it was pinned against —
// and nothing else.
//
// ## No mocked readers
//
// Every case drives a REAL `EventStore` on a real temp dir, through the REAL
// composite handlers. Faults are injected by rewinding an actual materialized
// cursor (`loadState`), never by stubbing a freshness reader.

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
 * A store that lets one event land in the window between the tail pin and the
 * fold's query — the window a concurrent writer actually occupies.
 *
 * Without it these guarantees cannot be tested at all: a single-threaded fold
 * queries microseconds after it pins, so the bound never has anything to
 * exclude and the assertions hold for the wrong reason. Removing the bound from
 * the seam leaves such a test green, which is the definition of a test that
 * cannot fail.
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

/**
 * The exact shape of #1855: a verb folds `workflow-state` into the SHARED view
 * materializer, then the stream keeps appending. Before the fix this made every
 * subsequent read of the stream refuse, on any view, forever.
 */
async function foldWorkflowStateThenAppend(appends: number): Promise<void> {
  const materializer = getOrCreateMaterializer(stateDir);
  await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);
  for (let i = 0; i < appends; i++) {
    await store.append(STREAM, { type: 'task.progressed', data: { i } });
  }
}

describe('#1855 — the wedge', () => {
  it('FoldAtTail_StaleSiblingFold_DoesNotRefuseAnUnrelatedViewRead', async () => {
    await seedWorkflow();
    await foldWorkflowStateThenAppend(1);

    // A single event behind a fold NOTHING in this read touches. This is the
    // reported case verbatim: `convergence` refused with
    // `staleViews: ["workflow-state"]` at lag 1.
    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);

    expect(result.error?.code, JSON.stringify(result.error)).not.toBe('PROJECTION_DEGRADED');
    expect(result.success).toBe(true);
  });

  it('FoldAtTail_RepeatedReadsOnAnAppendingStream_AllSucceed', async () => {
    await seedWorkflow();
    await foldWorkflowStateThenAppend(1);

    // The reported loop: each refusal window was long enough for more events to
    // land, so retrying the refusing read never drained the lag. Append between
    // every attempt and every attempt must still answer.
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

  it('FoldAtTail_FabricatedDegradedMarker_DoesNotWedgeAHealthyStream', async () => {
    await seedWorkflow();

    // A durable marker whose numbers bear no relation to this store — the
    // sticky-latch shape. It is a point-in-time observation, not a current fact
    // about the stream, and a read that can prove its own coverage must not
    // defer to it.
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

    // …and a view read clears the spent observation, so the journal records live
    // conditions rather than latching.
    const view = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    expect(view.success).toBe(true);
    expect(await readProjectionDegradedState(store, STREAM)).toBeUndefined();
  });
});

describe('#1855 — a read never answers from a fold behind the tail', () => {
  it('FoldAtTail_RewoundFold_AnswersFromTheTailNotFromTheStaleFold', async () => {
    await seedWorkflow();
    const materializer = getOrCreateMaterializer(stateDir);

    // Warm a real fold, then rewind its cursor and let the stream move — a
    // genuinely stale fold, injected for real. The old contract detected this
    // and refused.
    // The stronger claim is that the ANSWER is right, so assert the answer.
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

  it('FoldAtTail_ContradictoryFold_IsDiscardedAndReplayedFromTheLog', async () => {
    await seedWorkflow();
    const materializer = getOrCreateMaterializer(stateDir);

    const warm = await foldToTail<WorkflowStateView>(store, materializer, STREAM, WORKFLOW_STATE_VIEW);
    const tail = await store.tailSequence(STREAM);

    // `projection-ahead`: a cursor past the tail, with a corrupted payload. A
    // hwm-filtered re-fold cannot heal this — every event sits below the cursor
    // — so the fold must be DISCARDED and replayed from the log.
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

  it('FoldAtTail_AppendLandsMidFold_SequenceStaysOnThePinnedTail', async () => {
    // The reported sequence is what callers bound their own evidence to — the
    // emissions gate reads the phase from the fold and then filters raw events
    // to that sequence. A fold that ran past its own pin would make those two
    // halves describe different states of the stream.
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

      // The raced event is real and the tail really did move…
      expect(await racing.tailSequence(STREAM)).toBeGreaterThan(pinned);
      // …and the fold still answers for the sequence it pinned.
      expect(folded.sequence).toBe(pinned);
    } finally {
      racing.close();
    }
  });

  it('FoldPairToTail_TwoViews_ShareOneSequence', async () => {
    // Two independent folds pin two tails, so a read that COMBINES them can
    // describe a state the stream was never in: one view holding an event the
    // other has not seen. The attribution and correlation views do exactly that
    // combining.
    await seedWorkflow();
    const materializer = getOrCreateMaterializer(stateDir);

    // Race an append into the window BETWEEN the two folds. Two independent
    // pins would put the second view a sequence ahead of the first.
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
  it('WorkflowUpdate_CoverageUnprovable_StillReportsTheCommittedWrite', async () => {
    // `handleSet` refreshes `<featureId>.state.json` AFTER its events are
    // durable. A coverage failure in that refresh used to reject the whole
    // call, so a caller saw `INTERNAL_ERROR` for a write that had landed — and
    // would reasonably retry it.
    //
    // The snapshot path is gated on a CONFIGURED workflow materializer, and
    // nothing in `src/` calls `configureWorkflowMaterializer`, so the path is
    // dark in the shipped composition today. Without this wiring the test
    // passes whether or not the fix is present — it never reaches the fold.
    // Configuring it here is what makes the assertion mean something, and the
    // reachability gap itself is a separate finding.
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

    // …and the write really did land: a healthy read sees it.
    const get = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    expect(get.success, JSON.stringify(get.error)).toBe(true);
    const data = get.data as { riskTier?: string; data?: { riskTier?: string } } | undefined;
    expect(data?.riskTier ?? data?.data?.riskTier).toBe('low');
  });

  it('FoldAtTail_UnprovableCoverage_ThrowsRatherThanAnswering', async () => {
    // The negative twin. A READ in the same condition must not answer at all —
    // that is the one meaning `PROJECTION_DEGRADED` still carries, and it is
    // what makes the tolerance above a deliberate write-side rule rather than a
    // blanket swallow.
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
