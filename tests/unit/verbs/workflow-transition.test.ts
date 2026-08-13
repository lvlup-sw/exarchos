// ─── workflow.transition canonical handler tests (T36, T42, DR-4 / DR-5) ───
//
// `workflow.transition({target})` is the canonical phase-mutation action
// after the C4 single-path consolidation. The tests below cover:
//
//   • T36 — emits exactly one `workflow.transition` event per call (+ a
//     property check that reachable phases match the HSM topology).
//   • T42 — guard-failure path returns a structured error envelope with
//     `validTargets[]`, `expectedShape`, and `suggestedFix`.
//
// Tests are end-to-end against `handleWorkflow`'s composite dispatch so
// the registry → composite → handler → event-store wiring is exercised
// against the real action dispatch surface (no mocks at the boundary).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import { handleWorkflow } from '../../../src/workflow/composite.js';
import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { getHSMDefinition, getInitialPhase } from '../../../src/workflow/state-machine.js';
import {
  callCli,
  callMcp,
  normalize,
  TRANSITION_GUARD_FAILURE_FIXTURE,
} from '../parity-harness.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

let tmpDir: string;
let ctx: DispatchContext;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-transition-'));
  ctx = {
    stateDir: tmpDir,
    eventStore: new EventStore(tmpDir),
    enableTelemetry: false,
  };
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

// ─── T36: canonical handler emits exactly one transition event ──────────────

describe('WorkflowTransition_ValidTarget (T36, DR-4)', () => {
  it('WorkflowTransition_ValidTarget_EmitsTransitionEventOnce', async () => {
    const featureId = 't36-canonical';

    // Arrange — feature workflow primed for `plan → plan-review` (requires
    // `artifacts.plan`). DR-4 (#1581): plan is the initial phase.
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      ctx.eventStore,
    );

    // Sanity — no transition events before the call.
    const before = await ctx.eventStore.query(featureId);
    expect(before.filter((e) => e.type === 'workflow.transition').length).toBe(
      0,
    );

    // Act — single transition call.
    const result = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx,
    );
    expect(result.success).toBe(true);

    // Assert — exactly one workflow.transition event.
    const after = await ctx.eventStore.query(featureId);
    const transitions = after.filter((e) => e.type === 'workflow.transition');
    expect(transitions.length).toBe(1);
    expect(transitions[0].data).toMatchObject({
      from: 'plan',
      to: 'plan-review',
      featureId,
    });
  });

  // Property test — from any reachable phase, only declared transition
  // targets succeed. We sample the HSM topology and check that an
  // undeclared edge is rejected with `INVALID_TRANSITION`.
  it('WorkflowTransition_OnlyDeclaredTargetsAreReachable', async () => {
    const featureId = 't36-property';
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);

    const hsm = getHSMDefinition('feature');
    // The collapse made `plan` the initial feature phase (DR-4); it declares
    // `plan → plan-review` but NOT `plan → completed`. Probe from the ACTUAL
    // initial phase (not a hardcoded, now-removed `ideate`) so the topology
    // check stays anchored to the real transition source under test.
    const fromPhase = getInitialPhase('feature');
    expect(fromPhase).toBe('plan');
    const undeclaredTarget = 'completed';

    // Sanity — the HSM agrees the edge is undeclared.
    const declaredTargets = hsm.transitions
      .filter((t) => t.from === fromPhase)
      .map((t) => t.to);
    expect(declaredTargets).not.toContain(undeclaredTarget);

    const result = await handleWorkflow(
      { action: 'transition', featureId, target: undeclaredTarget },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
  });
});

// ─── T42: guard-failure error envelope ──────────────────────────────────────

describe('WorkflowTransition_GuardFailure (T42, DR-5)', () => {
  it('WorkflowTransition_GuardFailure_PopulatesValidTargetsAndSuggestedFix', async () => {
    const featureId = 't42-guard-fail';

    // Arrange — fresh feature workflow without `artifacts.plan`. DR-4 (#1581):
    // plan is initial; the `plan → plan-review` edge has a guard requiring the
    // plan artifact, so the transition fails with a guard error (not "no transition").
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);

    // Act — transition without the required artifact.
    const result = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx,
    );

    // Assert — structured error envelope.
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('GUARD_FAILED');

    // (1) validTargets[] populated from the HSM topology.
    expect(result.error?.validTargets).toBeDefined();
    expect(Array.isArray(result.error?.validTargets)).toBe(true);
    expect(result.error?.validTargets!.length).toBeGreaterThan(0);

    // (2) expectedShape describing the expected `target` value.
    expect(result.error?.expectedShape).toBeDefined();
    expect(result.error?.expectedShape).toMatchObject({
      target: expect.any(String),
    });

    // (3) suggestedFix referencing the closest valid transition. The
    // suggestion is shaped as `{ tool, params }` per the existing
    // `ToolResult.error.suggestedFix` contract.
    expect(result.error?.suggestedFix).toBeDefined();
    expect(result.error?.suggestedFix?.tool).toBe('exarchos_workflow');
    expect(result.error?.suggestedFix?.params).toMatchObject({
      action: 'transition',
      target: expect.any(String),
    });
  });

  it('WorkflowTransition_GuardFailure_CliMcpParityByteEquivalent', async () => {
    // T42 / DR-5: drive both carriers through the shared fixture and
    // assert byte-equivalence of the structured error envelope.
    const cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-guard-cli-'));
    const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-guard-mcp-'));
    try {
      const cliCtx: DispatchContext = {
        stateDir: cliDir,
        eventStore: new EventStore(cliDir),
        enableTelemetry: false,
      };
      const mcpCtx: DispatchContext = {
        stateDir: mcpDir,
        eventStore: new EventStore(mcpDir),
        enableTelemetry: false,
      };

      await TRANSITION_GUARD_FAILURE_FIXTURE.setup(cliCtx);
      await TRANSITION_GUARD_FAILURE_FIXTURE.setup(mcpCtx);

      const { result: cliResult } = await callCli(
        cliCtx,
        TRANSITION_GUARD_FAILURE_FIXTURE.cliCall.toolAlias,
        TRANSITION_GUARD_FAILURE_FIXTURE.cliCall.action,
        TRANSITION_GUARD_FAILURE_FIXTURE.cliCall.flags,
      );
      const mcpResult = await callMcp(
        mcpCtx,
        TRANSITION_GUARD_FAILURE_FIXTURE.mcpCall.tool,
        TRANSITION_GUARD_FAILURE_FIXTURE.mcpCall.args,
      );

      expect(cliResult.success).toBe(false);
      expect(mcpResult.success).toBe(false);

      // Drop _perf so wall-clock duration jitter doesn't break parity.
      const opts = { dropKeys: new Set(['_perf']) };
      expect(normalize(cliResult, opts)).toEqual(normalize(mcpResult, opts));

      // Spot-check the structured envelope is preserved on both arms.
      expect(cliResult.error?.code).toBe('GUARD_FAILED');
      expect(mcpResult.error?.code).toBe('GUARD_FAILED');
      expect(cliResult.error?.validTargets).toEqual(mcpResult.error?.validTargets);
      expect(cliResult.error?.suggestedFix).toEqual(mcpResult.error?.suggestedFix);
      expect(cliResult.error?.expectedShape).toEqual(mcpResult.error?.expectedShape);
    } finally {
      await rmrfAsync(cliDir);
      await rmrfAsync(mcpDir);
    }
  });

  it('WorkflowTransition_InvalidTarget_PopulatesValidTargetsAndSuggestedFix', async () => {
    const featureId = 't42-invalid-target';

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);

    // Act — transition to a phase with no edge from `ideate` (e.g.
    // `completed` is not directly reachable). This goes through the
    // `no-transition-defined` branch of the guard primitive.
    const result = await handleWorkflow(
      { action: 'transition', featureId, target: 'completed' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
    expect(result.error?.validTargets).toBeDefined();
    expect((result.error?.validTargets ?? []).length).toBeGreaterThan(0);
    expect(result.error?.expectedShape).toMatchObject({
      target: expect.any(String),
    });
    expect(result.error?.suggestedFix).toBeDefined();
    expect(result.error?.suggestedFix?.tool).toBe('exarchos_workflow');
    expect(result.error?.suggestedFix?.params).toMatchObject({
      action: 'transition',
      target: expect.any(String),
    });
  });
});
