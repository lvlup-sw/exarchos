// ─── HSMTransitionGuard.fail_closed (Commit C7, closes #1225) ─────────────
//
// `workflow.set({ phase })` must route every phase update through
// `HSMTransitionGuard.attempt`, which is the single decision point for
// guarded phase transitions. The atomicity invariant: a guarded transition
// either appends `workflow.transition` (on guard pass) OR
// `workflow.guard-failed` (on guard fail) — NEVER both for the same target
// phase in the same attempt.
//
// Tests treat `handleSet` as the entry point: each test exercises the full
// composed path that `workflow.set` will follow once routed through the
// guard primitive. Test 3 pins non-phase updates so they remain on the
// existing field-only path with no guard involvement.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet } from './tools.js';
import { DefaultHSMTransitionGuard, buildHsmEventData } from './hsm-transition-guard.js';
import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { EVENT_DATA_SCHEMAS } from '../event-store/schemas.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

let tmpDir: string;
const featureId = 'hsm-guard-test';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-guard-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

/**
 * Patch the raw state file to advance phase to `delegate` and seed tasks.
 * The feature HSM transition `delegate → review` requires the composite
 * guard `all-tasks-complete + team-disbanded` to pass. We bypass earlier
 * phases by editing the state file directly so each test isolates the
 * guard-on-set behavior, not the multi-phase walk.
 */
async function patchStateForDelegatePhase(opts: {
  tasks?: Array<{ id: string; title: string; status: string }>;
}): Promise<void> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
  raw.phase = 'delegate';
  if (opts.tasks !== undefined) raw.tasks = opts.tasks;
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
}

/** Count events of a given type in the JSONL store for `featureId`. */
async function countEvents(
  store: EventStore,
  type: string,
  filter?: (e: WorkflowEvent) => boolean,
): Promise<number> {
  const events = await store.query(featureId, { type: type as never });
  return filter ? events.filter(filter).length : events.length;
}

describe('HSMTransitionGuard.fail_closed (C7, closes #1225)', () => {
  it('workflowSet_phaseUpdateWithFailedGuard_doesNotEmitTransition', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    // Force phase=delegate with an INCOMPLETE task. allTasksComplete must
    // fail; the composite delegate→review guard must therefore fail.
    await patchStateForDelegatePhase({
      tasks: [{ id: 't1', title: 'task one', status: 'in_progress' }],
    });

    const result = await handleSet(
      { featureId, phase: 'review' },
      tmpDir,
      eventStore,
    );

    // The set returns ok:false (success:false in ToolResult terms).
    expect(result.success).toBe(false);

    // Atomicity invariant: ZERO workflow.transition events with to:'review'.
    // The bug being closed (#1225) shows both events landing ~6s apart.
    const transitionsToReview = await countEvents(
      eventStore,
      'workflow.transition',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(transitionsToReview).toBe(0);
  });

  it('workflowSet_phaseUpdateWithFailedGuard_emitsGuardFailedOnly', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await patchStateForDelegatePhase({
      tasks: [{ id: 't1', title: 'task one', status: 'in_progress' }],
    });

    const result = await handleSet(
      { featureId, phase: 'review' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(false);

    // Atomicity invariant: exactly ONE guard-failed for the attempted target.
    const guardFailures = await countEvents(
      eventStore,
      'workflow.guard-failed',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(guardFailures).toBe(1);

    // And ZERO transitions for the same target.
    const transitions = await countEvents(
      eventStore,
      'workflow.transition',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(transitions).toBe(0);
  });

  it('workflowSet_nonPhaseUpdates_passThroughUnchanged', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);

    // Pin: a field-only update (no `phase` key) does NOT invoke guard logic
    // and does NOT emit transition or guard-failed events. Prevents
    // regression where the phase-routing wrapper fires for any update.
    const result = await handleSet(
      { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const transitions = await countEvents(eventStore, 'workflow.transition');
    expect(transitions).toBe(0);
    const guardFailures = await countEvents(eventStore, 'workflow.guard-failed');
    expect(guardFailures).toBe(0);
  });

  it('workflowSet_phaseUpdateWithPassingGuard_emitsSingleTransition', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    // Empty tasks ⇒ allTasksComplete passes (vacuously). No team.spawned in
    // event log ⇒ teamDisbandedEmitted passes. The composite guard
    // therefore returns true, so delegate → review transitions cleanly.
    await patchStateForDelegatePhase({ tasks: [] });

    const result = await handleSet(
      { featureId, phase: 'review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');

    // Exactly one workflow.transition for to:'review'.
    const transitions = await countEvents(
      eventStore,
      'workflow.transition',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(transitions).toBe(1);

    // Zero guard-failed events for the same target.
    const guardFailures = await countEvents(
      eventStore,
      'workflow.guard-failed',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(guardFailures).toBe(0);
  });
});

// ─── Resolve-then-freeze persists phase.entered end-to-end (DR-13, #1546) ────
//
// The unit test in state-machine.test.ts proves executeTransition RETURNS a
// phase.entered. This proves it actually PERSISTS through the guard's emission
// boundary: mapped to the canonical `phase.entered` type (not laundered to
// `workflow.phase.entered` by the fallback) with a schema-valid obligation.
describe('HSMTransitionGuard phase.entered freeze (DR-13)', () => {
  it('passingTransition_PersistsOnePhaseEnteredWithFrozenObligation', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    // Empty tasks ⇒ delegate → review transitions cleanly (kind REVIEW).
    await patchStateForDelegatePhase({ tasks: [] });

    const result = await handleSet({ featureId, phase: 'review' }, tmpDir, eventStore);
    expect(result.success).toBe(true);

    // Exactly one phase.entered for the entered phase lands on the durable log.
    const entered = await eventStore.query(featureId, { type: 'phase.entered' as never });
    const toReview = entered.filter(
      (e) => (e.data as Record<string, unknown>).phase === 'review',
    );
    expect(toReview).toHaveLength(1);

    // It carries the frozen REVIEW obligation and validates against the schema.
    const data = toReview[0].data as Record<string, unknown>;
    expect(data.kind).toBe('REVIEW');
    expect(data.resolver).toBe('review-contract');
    expect(data.policySource).toBe('builtin');
    expect(data.mode).toBe('enforce');
    expect(Array.isArray(data.resolvedGates)).toBe(true);
    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(data).success).toBe(true);

    // Regression: NOT laundered into the non-existent `workflow.phase.entered`
    // by the mapInternalToExternalType fallback.
    const mangled = await countEvents(eventStore, 'workflow.phase.entered');
    expect(mangled).toBe(0);
  });
});

// ─── Resolve-then-freeze fail-closed path persists phase.blocked (DR-7, #1546) ─
//
// The FAILURE mirror of the phase.entered freeze test. When the gate-set
// resolver faults, `executeTransition` returns PHASE_BLOCKED + a `phase.blocked`
// event. This proves the guard (1) PRESERVES the PHASE_BLOCKED errorCode rather
// than collapsing it to GUARD_FAILED, and (2) PERSISTS the event as the
// canonical `phase.blocked` type with a schema-valid PhaseBlockedData payload —
// not the unregistered `workflow.phase.blocked` the `workflow.${type}` fallback
// would mint (which `WorkflowEventBase`'s unknown-type refine would reject).
describe('HSMTransitionGuard phase.blocked fail-closed (DR-7)', () => {
  it('blockedTransition_PreservesPhaseBlockedCode_PersistsCanonicalSchemaValidEvent', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    // Empty tasks ⇒ the delegate → review composite guard passes, so the attempt
    // reaches the gate-set resolution boundary (REVIEW kind).
    await patchStateForDelegatePhase({ tasks: [] });
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

    const guard = new DefaultHSMTransitionGuard();
    const result = await guard.attempt(featureId, 'delegate', 'review', {
      state,
      workflowType: 'feature',
      eventStore,
      // Inject a faulting resolver so the gate-set boundary fails CLOSED — the
      // real resolver never throws for valid inputs, so injection is the only
      // way to exercise the PHASE_BLOCKED branch through the guard's full path.
      resolveGatesFn: () => {
        throw new Error('resolver boom');
      },
    });

    // (1) Finding F4: the fail-closed code is PRESERVED across the guard
    // boundary, not flattened to GUARD_FAILED.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('PHASE_BLOCKED');
    }

    // (2) Finding F2: exactly one canonical phase.blocked lands on the log...
    const blocked = await eventStore.query(featureId, {
      type: 'phase.blocked' as never,
    });
    expect(blocked).toHaveLength(1);

    // ...with a schema-valid PhaseBlockedData payload (would THROW at the
    // emission boundary pre-fix, since buildHsmEventData had no phase.blocked
    // case and the default shape is missing `phase`/`error`).
    const data = blocked[0].data as Record<string, unknown>;
    expect(EVENT_DATA_SCHEMAS['phase.blocked']?.safeParse(data).success).toBe(true);
    expect(data.kind).toBe('REVIEW');
    expect(data.phase).toBe('review');

    // ...and is NOT laundered into the unregistered `workflow.phase.blocked`.
    expect(await countEvents(eventStore, 'workflow.phase.blocked')).toBe(0);

    // The transition is refused — no phase.entered for the blocked target.
    const enteredReview = await countEvents(
      eventStore,
      'phase.entered',
      (e) => (e.data as Record<string, unknown>).phase === 'review',
    );
    expect(enteredReview).toBe(0);
  });
});

// ─── phase.exited gate status is not silently coerced (DR-13, #1546, F-CR3) ───
//
// `allRequiredGatesPassed` is a REQUIRED boolean on PhaseExitedData. The
// emission boundary must NOT `Boolean(...)`-coerce a missing/non-boolean value
// into `false` — that silently records wrong exit status and masks a boundary
// regression. It surfaces `undefined`, which the required-boolean schema rejects
// loudly at `buildValidatedEvent`.
describe('buildHsmEventData phase.exited gate-status integrity (DR-13)', () => {
  const exitEvt = (allRequiredGatesPassed: unknown) => ({
    type: 'phase.exited',
    from: 'delegate',
    to: 'review',
    trigger: 'execute-transition',
    metadata: { phase: 'delegate', allRequiredGatesPassed },
  });

  it('preserves an explicit boolean gate status', () => {
    expect(buildHsmEventData(exitEvt(true), featureId, {}).allRequiredGatesPassed).toBe(true);
    expect(buildHsmEventData(exitEvt(false), featureId, {}).allRequiredGatesPassed).toBe(false);
  });

  it('surfaces undefined (NOT false) for a missing/non-boolean gate status, failing the schema', () => {
    for (const bad of [undefined, 'true', 1, null]) {
      const data = buildHsmEventData(exitEvt(bad), featureId, {});
      // Not silently coerced to a persisted `false`...
      expect(data.allRequiredGatesPassed).toBeUndefined();
      // ...and the required-boolean schema rejects it at the emission boundary.
      expect(EVENT_DATA_SCHEMAS['phase.exited']?.safeParse(data).success).toBe(false);
    }
  });
});

// ─── HSM emission boundary routes through EVENT_DATA_SCHEMAS (T-03, #1339) ──
//
// Defense-in-depth follow-up to T-02. Even with the fix-cycle shape fixed,
// the legacy `EventStore.append` path validates only the envelope
// (`WorkflowEventBase`) and skips `EVENT_DATA_SCHEMAS`. The fix-cycle event
// emitted by the HSM walk carries `data: { from, to, trigger, featureId }`,
// which is MISSING the required `count: z.number().int()` that
// `WorkflowFixCycleData` mandates. Via the legacy path this schema-invalid
// data is laundered straight onto the log. T-03 makes the emission boundary
// route through `buildValidatedEvent` so a schema-invalid `data` can NEVER
// reach the log.
describe('HSM emission boundary schema-validates event data (T-03, #1339)', () => {
  it('LegacyAppendPath_SchemaInvalidWorkflowEvent_IsRejected', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);

    // Drive a real fix-cycle: review → delegate (isFixCycle in the feature
    // HSM). `anyReviewFailed` passes when state.reviews has a failed entry.
    // review and delegate are both top-level phases, so getParentCompound
    // returns undefined and the fix-cycle event carries no compoundStateId.
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'review';
    raw.reviews = { 'reviewer-a': { status: 'failed' } };
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleSet(
      { featureId, phase: 'delegate' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    // A fix-cycle event must have been appended for this transition.
    const fixCycleEvents = await eventStore.query(featureId, {
      type: 'workflow.fix-cycle' as never,
    });
    expect(fixCycleEvents.length).toBeGreaterThanOrEqual(1);

    // The emission boundary must guarantee that any persisted fix-cycle
    // event's `data` satisfies EVENT_DATA_SCHEMAS — i.e. the same validation
    // `buildValidatedEvent` runs. Pre-T-03 this fails: the legacy append path
    // wrote `data` missing the required `count` field, laundering invalid
    // data onto the log.
    const fixCycleSchema = EVENT_DATA_SCHEMAS['workflow.fix-cycle'];
    expect(fixCycleSchema).toBeDefined();
    for (const evt of fixCycleEvents) {
      const parsed = fixCycleSchema!.safeParse(evt.data);
      expect(parsed.success).toBe(true);
    }
  });
});
