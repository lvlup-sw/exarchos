// Tests for the canonical `workflow.transition({target})` action, end to end
// through `handleWorkflow` with no mocks at the boundary. A valid call emits one
// `workflow.transition` event. A failed call returns an error with `validTargets`,
// `expectedShape` and `suggestedFix`.

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

describe('WorkflowTransition_ValidTarget (T36, DR-4)', () => {
  /** `plan` is the initial phase, and the `plan → plan-review` edge needs `artifacts.plan`. */
  it('WorkflowTransition_ValidTarget_EmitsTransitionEventOnce', async () => {
    const featureId = 't36-canonical';

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      ctx.eventStore,
    );

    const before = await ctx.eventStore.query(featureId);
    expect(before.filter((e) => e.type === 'workflow.transition').length).toBe(
      0,
    );

    const result = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx,
    );
    expect(result.success).toBe(true);

    const after = await ctx.eventStore.query(featureId);
    const transitions = after.filter((e) => e.type === 'workflow.transition');
    expect(transitions.length).toBe(1);
    expect(transitions[0].data).toMatchObject({
      from: 'plan',
      to: 'plan-review',
      featureId,
    });
  });

  /**
   * From the initial phase, an undeclared target fails with `INVALID_TRANSITION`.
   * The probe reads the phase from `getInitialPhase`, so it follows the real topology.
   */
  it('WorkflowTransition_OnlyDeclaredTargetsAreReachable', async () => {
    const featureId = 't36-property';
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);

    const hsm = getHSMDefinition('feature');
    const fromPhase = getInitialPhase('feature');
    expect(fromPhase).toBe('plan');
    const undeclaredTarget = 'completed';

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

describe('WorkflowTransition_GuardFailure (T42, DR-5)', () => {
  /**
   * A fresh workflow has no `artifacts.plan`, so the guard on `plan → plan-review`
   * fails with `GUARD_FAILED`. The `suggestedFix` has the `{ tool, params }` shape.
   */
  it('WorkflowTransition_GuardFailure_PopulatesValidTargetsAndSuggestedFix', async () => {
    const featureId = 't42-guard-fail';

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);

    const result = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('GUARD_FAILED');

    expect(result.error?.validTargets).toBeDefined();
    expect(Array.isArray(result.error?.validTargets)).toBe(true);
    expect(result.error?.validTargets!.length).toBeGreaterThan(0);

    expect(result.error?.expectedShape).toBeDefined();
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

  /** The CLI and MCP error envelopes are equal after the normalizer drops `_perf`. */
  it('WorkflowTransition_GuardFailure_CliMcpParityByteEquivalent', async () => {
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

      const opts = { dropKeys: new Set(['_perf']) };
      expect(normalize(cliResult, opts)).toEqual(normalize(mcpResult, opts));

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

  /**
   * `completed` has no edge from the initial `plan` phase, so the call takes the
   * no-transition-defined branch of the guard.
   */
  it('WorkflowTransition_InvalidTarget_PopulatesValidTargetsAndSuggestedFix', async () => {
    const featureId = 't42-invalid-target';

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, ctx.eventStore);

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
