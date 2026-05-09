// ─── ACCEPTANCE — workflow.set({phase}) deprecation rerouting (T35, DR-4) ───
//
// Verifies the C4 (HSM API single-path) bundle as visible at the dispatch
// boundary:
//
//   1. Calling `set({phase})` and `transition({target})` against equivalent
//      starting states emits a byte-equivalent `workflow.transition` event
//      (same type, same `data` shape — sequence/timestamps/eventIds excepted).
//   2. The deprecated path additionally emits exactly one
//      `hsm.deprecated_action_invoked` event with
//      `data.action: 'workflow.set.phase'`.
//   3. The deprecated path's response carries
//      `_meta.deprecation = { since: '2.10.0', removeIn: '2.11.0',
//      replacement: 'transition' }`.
//   4. The registry's `outputSchema` for the affected actions registers
//      `_meta.deprecation` as a typed sub-shape so model-facing tools can
//      surface the migration breadcrumb without ad-hoc extraction.
//
// Kept RED until T36 + T37 + T38 + T40 + T41 + T42 land — the assertions
// below collectively exercise every deliverable in the bundle.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleInit, handleSet } from '../workflow/tools.js';
import { handleWorkflow } from '../workflow/composite.js';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

let setDir: string;
let transitionDir: string;
let setCtx: DispatchContext;
let transitionCtx: DispatchContext;

beforeEach(async () => {
  setDir = await fs.mkdtemp(path.join(os.tmpdir(), 'set-deprec-'));
  transitionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transition-'));
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

/**
 * Initialize a feature workflow and walk it to a state where
 * `ideate → plan` is a valid transition (requires `artifacts.design`).
 */
async function primeForIdeateToPlan(
  ctx: DispatchContext,
  featureId: string,
): Promise<void> {
  await handleInit(
    { featureId, workflowType: 'feature' },
    ctx.stateDir,
    ctx.eventStore,
  );
  await handleSet(
    { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
    ctx.stateDir,
    ctx.eventStore,
  );
}

/**
 * Drop dynamic fields (sequence, eventId, timestamp, streamId) so two
 * independent appends produce byte-equal `data` payloads for comparison.
 */
function normalizeTransitionEvent(evt: WorkflowEvent): {
  type: string;
  data: unknown;
} {
  return { type: evt.type, data: evt.data };
}

// ─── ACCEPTANCE TEST ────────────────────────────────────────────────────────

describe('WorkflowSet_DeprecatedAction (acceptance, T35, DR-4)', () => {
  it('WorkflowSet_DeprecatedAction_EmitsTransitionEventAndDeprecationEnvelope', async () => {
    const featureId = 'depr-acceptance';

    // Arrange — both arms primed with the same workflow shape.
    await primeForIdeateToPlan(setCtx, featureId);
    await primeForIdeateToPlan(transitionCtx, featureId);

    // Act — deprecated `set({phase: 'plan'})` arm.
    const setResult = await handleWorkflow(
      { action: 'set', featureId, phase: 'plan' },
      setCtx,
    );

    // Act — canonical `transition({target: 'plan'})` arm.
    const transitionResult = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan' },
      transitionCtx,
    );

    // Both arms succeeded.
    expect(setResult.success).toBe(true);
    expect(transitionResult.success).toBe(true);

    // ─── (1) Same workflow.transition event type + data shape ─────────────
    const setEvents = await setCtx.eventStore.query(featureId);
    const transitionEvents = await transitionCtx.eventStore.query(featureId);

    const setTransitions = setEvents.filter(
      (e) => e.type === 'workflow.transition',
    );
    const transitionTransitions = transitionEvents.filter(
      (e) => e.type === 'workflow.transition',
    );

    expect(setTransitions.length).toBe(1);
    expect(transitionTransitions.length).toBe(1);
    expect(normalizeTransitionEvent(setTransitions[0])).toEqual(
      normalizeTransitionEvent(transitionTransitions[0]),
    );

    // ─── (2) `hsm.deprecated_action_invoked` emitted on the set arm ───────
    const deprecationEvents = setEvents.filter(
      (e) => e.type === 'hsm.deprecated_action_invoked',
    );
    expect(deprecationEvents.length).toBe(1);
    expect(deprecationEvents[0].data).toMatchObject({
      action: 'workflow.set.phase',
    });
    expect((deprecationEvents[0].data as { invokedBy?: string }).invokedBy)
      .toBeDefined();

    // ─── (3) Response envelope carries _meta.deprecation ──────────────────
    const meta = (setResult as { _meta?: Record<string, unknown> })._meta;
    expect(meta).toBeDefined();
    expect(meta?.deprecation).toEqual({
      since: '2.10.0',
      removeIn: '2.11.0',
      replacement: 'transition',
    });

    // ─── (4) outputSchema registers _meta.deprecation as typed sub-shape ─
    const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');
    expect(workflowTool).toBeDefined();

    const setAction = workflowTool!.actions.find((a) => a.name === 'set');
    const transitionAction = workflowTool!.actions.find(
      (a) => a.name === 'transition',
    );
    expect(setAction).toBeDefined();
    expect(transitionAction).toBeDefined();

    // The action's `outputSchema` field MUST register `_meta.deprecation`.
    // We assert via parse so a refactor to a different Zod nesting strategy
    // (e.g. `_meta` as a wrapped object vs. inlined) still satisfies the
    // contract as long as the field is type-checked.
    const outputSchemas = [
      (setAction as { outputSchema?: unknown }).outputSchema,
      (transitionAction as { outputSchema?: unknown }).outputSchema,
    ];
    for (const schema of outputSchemas) {
      expect(schema).toBeDefined();
      // The schema must accept a payload carrying `_meta.deprecation`.
      const deprecationProbe = {
        success: true,
        data: { phase: 'plan', updatedAt: '2026-05-08T00:00:00Z' },
        _meta: {
          deprecation: {
            since: '2.10.0',
            removeIn: '2.11.0',
            replacement: 'transition',
          },
        },
      };
      const parser = schema as { safeParse: (input: unknown) => { success: boolean } };
      const parsed = parser.safeParse(deprecationProbe);
      expect(parsed.success).toBe(true);
    }
  });
});
