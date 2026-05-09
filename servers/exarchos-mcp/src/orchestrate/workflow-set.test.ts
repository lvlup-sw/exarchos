// ─── workflow.set({phase}) deprecation behavior tests (T37, T38, DR-4) ─────
//
// `workflow.set({phase})` is retained for one release as a deprecation
// rerouting surface (#1259, C4). The tests below verify that:
//
//   • T37 — `set({phase})` produces events indistinguishable from a direct
//     `transition({target})` call (no second phase-write surface).
//   • T38 — every `set({phase})` invocation additionally emits a
//     `hsm.deprecated_action_invoked` event with structured telemetry data
//     so the migration window can be measured.
//
// Tests are end-to-end against `handleWorkflow`'s composite dispatch so the
// dispatch → handler → event-store wiring is exercised against the real
// surface (no mocks at the boundary).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleInit, handleSet } from '../workflow/tools.js';
import { handleWorkflow } from '../workflow/composite.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

let setDir: string;
let transitionDir: string;
let setCtx: DispatchContext;
let transitionCtx: DispatchContext;

beforeEach(async () => {
  setDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-set-'));
  transitionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-transition-cmp-'));
  setCtx = {
    stateDir: setDir,
    eventStore: new EventStore(setDir),
    enableTelemetry: false,
  };
  transitionCtx = {
    stateDir: transitionDir,
    eventStore: new EventStore(transitionDir),
    enableTelemetry: false,
  };
});

afterEach(async () => {
  await fs.rm(setDir, { recursive: true, force: true });
  await fs.rm(transitionDir, { recursive: true, force: true });
});

async function primeForIdeateToPlan(
  ctx: DispatchContext,
  featureId: string,
): Promise<void> {
  await handleInit({ featureId, workflowType: 'feature' }, ctx.stateDir, ctx.eventStore);
  await handleSet(
    { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
    ctx.stateDir,
    ctx.eventStore,
  );
}

/** Drop dynamic fields so two appends can be compared byte-equally. */
function projectTransition(evt: WorkflowEvent): { type: string; data: unknown } {
  return { type: evt.type, data: evt.data };
}

// ─── T37: set({phase}) delegates to transition handler ──────────────────────

describe('WorkflowSet_PhaseDelegate (T37, DR-4)', () => {
  it('WorkflowSet_PhaseDelegate_RoutesToTransitionHandlerNoSecondPath', async () => {
    const featureId = 't37-delegate';

    await primeForIdeateToPlan(setCtx, featureId);
    await primeForIdeateToPlan(transitionCtx, featureId);

    // Act — drive both arms with their respective canonical action.
    const setResult = await handleWorkflow(
      { action: 'set', featureId, phase: 'plan' },
      setCtx,
    );
    const transitionResult = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan' },
      transitionCtx,
    );

    expect(setResult.success).toBe(true);
    expect(transitionResult.success).toBe(true);

    // The set arm produces exactly one workflow.transition event with
    // a data shape byte-equivalent to the canonical arm. (The set arm
    // additionally emits hsm.deprecated_action_invoked — that signal is
    // covered by T38 below, so we filter to transition events here.)
    const setEvents = await setCtx.eventStore.query(featureId);
    const transitionEvents = await transitionCtx.eventStore.query(featureId);

    const setTransitions = setEvents
      .filter((e) => e.type === 'workflow.transition')
      .map(projectTransition);
    const transitionTransitions = transitionEvents
      .filter((e) => e.type === 'workflow.transition')
      .map(projectTransition);

    expect(setTransitions.length).toBe(1);
    expect(transitionTransitions.length).toBe(1);
    expect(setTransitions[0]).toEqual(transitionTransitions[0]);
  });
});

// ─── T38: set({phase}) emits hsm.deprecated_action_invoked ─────────────────

describe('WorkflowSet_OnInvocation (T38, DR-4)', () => {
  it('WorkflowSet_OnInvocation_EmitsHsmDeprecatedActionInvoked', async () => {
    const featureId = 't38-deprecated-emit';

    await primeForIdeateToPlan(setCtx, featureId);

    // Act — single set({phase}) invocation.
    const result = await handleWorkflow(
      { action: 'set', featureId, phase: 'plan' },
      setCtx,
    );
    expect(result.success).toBe(true);

    // Exactly one `hsm.deprecated_action_invoked` event with the
    // structured telemetry payload.
    const events = await setCtx.eventStore.query(featureId);
    const deprecationEvents = events.filter(
      (e) => e.type === 'hsm.deprecated_action_invoked',
    );
    expect(deprecationEvents.length).toBe(1);

    const data = deprecationEvents[0].data as {
      action: string;
      invokedBy: string;
    };
    expect(data.action).toBe('workflow.set.phase');
    expect(data.invokedBy).toBeTruthy();
  });

  it('WorkflowSet_FieldUpdateOnly_DoesNotEmitDeprecation', async () => {
    // Sanity: `set({updates})` without a phase argument is NOT the
    // deprecated phase-write path; no deprecation event should fire.
    const featureId = 't38-no-deprec';

    await handleInit({ featureId, workflowType: 'feature' }, setDir, setCtx.eventStore);

    const result = await handleWorkflow(
      {
        action: 'set',
        featureId,
        updates: { 'artifacts.design': 'docs/design.md' },
      },
      setCtx,
    );
    expect(result.success).toBe(true);

    const events = await setCtx.eventStore.query(featureId);
    const deprecationEvents = events.filter(
      (e) => e.type === 'hsm.deprecated_action_invoked',
    );
    expect(deprecationEvents.length).toBe(0);
  });
});

// ─── T72: deprecation event routes through canonical emit helper ───────────
//
// CodeRabbit Major #12 (composite.ts:125) — the deprecation-emitter must
// route through the canonical `buildValidatedEvent` + `appendValidated`
// path used by every other system-boundary event emitter (see
// `event-store/tools.ts`). Direct `eventStore.append(...)` is a
// side-channel that bypasses per-event-type data validation and the
// envelope-population semantics the canonical helper enforces.
//
// INV-1 (event-sourcing integrity — single emission path) and INV-5d
// (action discriminator — manual append within an action handler is a
// side-channel) both require the canonical helper. The witness here
// spies on `appendValidated` and asserts it carries the deprecation
// event with the canonical envelope fields populated.
// ────────────────────────────────────────────────────────────────────────────

describe('WorkflowSet_DeprecationEmit_CanonicalEnvelope (T72, INV-1, INV-5d)', () => {
  it('WorkflowSet_OnPhaseInvocation_RoutesDeprecationThroughAppendValidated', async () => {
    const featureId = 't72-canonical-emit';

    await primeForIdeateToPlan(setCtx, featureId);

    // Spy on the canonical helper. The bare `append` path bypasses this;
    // the canonical path validates via `buildValidatedEvent` then writes
    // through `appendValidated`. The witness asserts the deprecation
    // event traverses `appendValidated` with the type set.
    const appendValidatedSpy = vi.spyOn(setCtx.eventStore, 'appendValidated');

    const result = await handleWorkflow(
      { action: 'set', featureId, phase: 'plan' },
      setCtx,
    );
    expect(result.success).toBe(true);

    // The deprecation event MUST traverse the canonical helper. With the
    // bare `append` path this spy never fires for the deprecation type.
    const deprecationCall = appendValidatedSpy.mock.calls.find(([, evt]) =>
      (evt as { type?: string }).type === 'hsm.deprecated_action_invoked',
    );
    expect(deprecationCall).toBeDefined();

    appendValidatedSpy.mockRestore();
  });

  it('WorkflowSet_DeprecationEvent_CarriesCanonicalEnvelopeFields', async () => {
    const featureId = 't72-envelope-fields';

    await primeForIdeateToPlan(setCtx, featureId);

    const result = await handleWorkflow(
      { action: 'set', featureId, phase: 'plan' },
      setCtx,
    );
    expect(result.success).toBe(true);

    const events = await setCtx.eventStore.query(featureId);
    const deprecation = events.find(
      (e) => e.type === 'hsm.deprecated_action_invoked',
    );
    expect(deprecation).toBeDefined();

    // Canonical envelope contract — every emitter must populate these.
    // The canonical helper derives `correlationId`, `source`, and
    // `schemaVersion` so all consumers see consistent envelopes (DR-3,
    // INV-1). The bare-append path leaves `schemaVersion` to the Zod
    // default; the canonical helper sets it explicitly via
    // `buildValidatedEvent`.
    expect(deprecation!.correlationId).toBeTruthy();
    expect(deprecation!.source).toBeTruthy();
    expect(deprecation!.schemaVersion).toBeTruthy();

    // The deprecation event's `data` MUST satisfy the per-type schema
    // (HsmDeprecatedActionInvokedData) — the canonical
    // `buildValidatedEvent` enforces this; the bare-append path skips
    // per-type validation entirely.
    const data = deprecation!.data as { action: string; invokedBy: string };
    expect(typeof data.action).toBe('string');
    expect(data.action.length).toBeGreaterThan(0);
    expect(typeof data.invokedBy).toBe('string');
    expect(data.invokedBy.length).toBeGreaterThan(0);
  });
});
