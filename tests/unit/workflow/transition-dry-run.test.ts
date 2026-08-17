// ─── DR-7 kill fixture — a dryRun transition must not move the workflow ─────
//
// Found live: a dry-run probe of `review → synthesize` on
// `internal-mechanics-overhaul` advanced the phase for real.
// `exarchos_workflow`'s composite input schema carries `dryRun` because
// `cancel` and `cleanup` declare it; `transition` does not, so dispatch
// stripped it and ran the transition. `success: true` came back either way.
//
// Every assertion here is made against the EVENT STREAM, not the response.
// The response is precisely what lied — a test that only reads `result.success`
// or `data.phase` reproduces the original defect instead of catching it, since
// both were populated and both were wrong. `workflow.transition` /
// `phase.exited` / `phase.entered` landing in the log is the observable that
// cannot be faked by a well-shaped envelope.
//
// The expected stream is WRITTEN OUT below rather than snapshotted before the
// call and compared after. A snapshot compared against itself cannot disagree
// with itself; the hand-written list is the independent authority, and it also
// catches the failure mode a snapshot cannot — a setup that emitted nothing,
// which would make "unchanged" trivially true.
//
// The suite runs through `dispatch()` rather than `handleWorkflow()` because
// the parameter-acceptance seam lives in dispatch — a direct composite call
// never sees the flattened-parent payload an MCP caller actually sends.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { dispatch, type DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The whole log after setup, hand-written. `init` emits `workflow.started`;
 * the `update` that populates the plan artifact emits `state.patched`. A dry
 * run must leave exactly this and nothing more.
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
 * A feature workflow parked at `plan` with its plan artifact populated, so
 * `plan → plan-review` is a transition the HSM guard would ALLOW. Without
 * this the fixture would be green for the wrong reason: a blocked transition
 * also appends no `workflow.transition`.
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

  // Premise, stated: the fixture's later "nothing was appended" assertions are
  // only meaningful if setup wrote what it claims to have written.
  const seeded = await eventTypes();
  expect(seeded).toEqual(SETUP_STREAM);
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(tmpDir);
});

describe('exarchos_workflow.transition — dryRun (DR-7, task 090)', () => {
  it('TransitionDryRun_AppendsNoPhaseEvent_AssertedAgainstTheEventStream', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review', dryRun: true },
      ctx,
    );

    // THE kill assertion: the log still holds exactly what setup put there.
    // Not "the response said no" — nothing was written.
    const after = await eventTypes();
    expect(after).toEqual(SETUP_STREAM);
    for (const type of PHASE_TRAIL) expect(after).not.toContain(type);

    // And the caller is told, rather than handed a success envelope for a
    // parameter that was thrown away.
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

  it('TransitionWithoutDryRun_StillAppendsThePhaseTrail', async () => {
    // Control arm — without it the two assertions above would also pass on a
    // build where `transition` was broken outright, or where the guard
    // happened to deny this edge. The fixture's premise is that this exact
    // transition DOES work when asked honestly.
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

  it('TransitionDryRunFalse_IsRefusedToo_TheParameterIsNotHalfSupported', async () => {
    // `dryRun:false` is the reading where a caller believes the parameter is
    // understood and is opting OUT of the dry run. Accepting it would publish
    // a knob that does not exist; the refusal is the same either way.
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

  it('TransitionRefusal_NamesTheActionsThatDoDeclareDryRun', async () => {
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review', dryRun: true },
      ctx,
    );
    // Derived from the registry, so the pointer cannot go stale against a
    // rename: the message tells the caller where `dryRun` is actually honoured.
    expect(result.error?.message).toContain('exarchos_workflow.cancel');
    expect(result.error?.message).toContain('target');
  });
});

describe('exarchos_workflow.cancel — reason (DR-7 sweep, second instance)', () => {
  it('CancelReason_ReachesTheCancelRequestedEvent_NotDroppedInDispatch', async () => {
    // `handleCancel` has always read `input.reason`; the action schema did not
    // declare it, so dispatch discarded it and the cancel-requested event
    // recorded no reason while the call reported success. Asserted on the
    // event payload for the same reason as above — the response never showed
    // the loss.
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
