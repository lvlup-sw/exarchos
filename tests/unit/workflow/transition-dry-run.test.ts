// A `transition` call with `dryRun` must not move the workflow. The composite input
// schema carries `dryRun` for `cancel` and `cleanup`, but `transition` does not
// declare it, so dispatch refuses the parameter.
//
// The tests assert against the event stream, because a well-shaped response can
// hide a real transition. The expected stream is written out, not snapshotted, so
// a setup that emits nothing cannot pass. The suite calls `dispatch()`, because the
// parameter check runs there and not in `handleWorkflow()`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { dispatch, type DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The whole log after setup, written by hand. `init` appends `workflow.started`, and the `update` that sets
 * the plan artifact appends `state.patched`. A dry run must leave this log unchanged.
 */
const SETUP_STREAM = ['workflow.started', 'state.patched'];

/** What a real `plan → plan-review` transition appends on top of it. */
const PHASE_TRAIL = ['workflow.transition', 'phase.exited', 'phase.entered'];

let tmpDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;
let featureId: string;

/** Event types on the feature's stream, in order. The authoritative record. */
async function eventTypes(): Promise<string[]> {
  const events = await eventStore.query(featureId);
  return events.map((e) => e.type);
}

/**
 * Parks a feature workflow at `plan` with its plan artifact set, so the HSM guard allows
 * `plan → plan-review`. A blocked transition also appends no `workflow.transition`. The setup asserts its own
 * log, so the later checks start from a known stream.
 */
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transition-dry-run-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  featureId = 'transition-dry-run-fixture';

  const init = await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
  expect(init.success).toBe(true);
  const update = await dispatch(
    'exarchos_workflow',
    { action: 'update', featureId, updates: { artifacts: { plan: 'p.md' } } },
    ctx,
  );
  expect(update.success).toBe(true);

  const seeded = await eventTypes();
  expect(seeded).toEqual(SETUP_STREAM);
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(tmpDir);
});

describe('exarchos_workflow.transition — dryRun (DR-7, task 090)', () => {
  /**
   * The call must fail with `INVALID_INPUT`, so the caller does not get a success envelope for a dropped
   * parameter.
   */
  it('TransitionDryRun_AppendsNoPhaseEvent_AssertedAgainstTheEventStream', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review', dryRun: true },
      ctx,
    );

    const after = await eventTypes();
    expect(after).toEqual(SETUP_STREAM);
    for (const type of PHASE_TRAIL) expect(after).not.toContain(type);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('dryRun');
  });

  it('TransitionDryRun_LeavesTheProjectedPhaseUnchanged', async () => {
    await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review', dryRun: true },
      ctx,
    );

    const get = await dispatch('exarchos_workflow', { action: 'get', featureId }, ctx);
    expect(get.success).toBe(true);
    expect((get.data as { phase?: unknown }).phase).toBe('plan');
  });

  /**
   * This control proves that the transition works without `dryRun`. Without it, the dry-run tests also pass
   * when `transition` is broken or the guard denies the edge.
   */
  it('TransitionWithoutDryRun_StillAppendsThePhaseTrail', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx,
    );
    expect(result.success).toBe(true);

    const after = await eventTypes();
    expect(after).toEqual([...SETUP_STREAM, ...PHASE_TRAIL]);

    const get = await dispatch('exarchos_workflow', { action: 'get', featureId }, ctx);
    expect((get.data as { phase?: unknown }).phase).toBe('plan-review');
  });

  /**
   * A caller that sends `dryRun: false` believes that the parameter exists. Dispatch refuses it the same way
   * as `dryRun: true`.
   */
  it('TransitionDryRunFalse_IsRefusedToo_TheParameterIsNotHalfSupported', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review', dryRun: false },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    const after = await eventTypes();
    expect(after).toEqual(SETUP_STREAM);
  });

  /** The refusal names the actions that declare `dryRun` and the parameters that `transition` accepts. */
  it('TransitionRefusal_NamesTheActionsThatDoDeclareDryRun', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review', dryRun: true },
      ctx,
    );
    expect(result.error?.message).toContain('exarchos_workflow.cancel');
    expect(result.error?.message).toContain('target');
  });
});

describe('exarchos_workflow.cancel — reason (DR-7 sweep, second instance)', () => {
  /**
   * `handleCancel` reads `input.reason`, so the action schema must declare it, or dispatch drops it. The test
   * checks the event payload, because the response does not show a dropped reason.
   */
  it('CancelReason_ReachesTheCancelRequestedEvent_NotDroppedInDispatch', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'cancel', featureId, reason: 'operator stated cause' },
      ctx,
    );
    expect(result.success).toBe(true);

    const events = await eventStore.query(featureId);
    const requested = events.find((e) => e.type === 'cancel.requested');
    expect(requested).toBeDefined();
    expect((requested!.data as { reason?: unknown }).reason).toBe('operator stated cause');
  });
});
