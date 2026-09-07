// ─── `execute_intent` registration boundary ──────────────────────────────────
//
// Two things this suite pins, at the boundary rather than inside the handler
// (the handler's own behavior is covered by `compile.test.ts` / `executor.test.ts`):
//
//   1. The composite router: `exarchos_orchestrate` dispatches action
//      'execute_intent' to `handleExecuteIntent`, hands it the live handler
//      table, and envelope-wraps whatever it returns — the stubbed-handler
//      pattern `tools.test.ts` already uses for every other routed action.
//   2. The registered economy declaration: over the declared budget, the real
//      registered action's `economy.summarize` (not the generic list fallback)
//      caps the receipt while keeping the four fields a caller needs to keep
//      following the operation — `operationId`, `outcome`, `failedLeaf`,
//      `tailSequence` — outside the capped shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { enforceResponseEconomy } from '../../../../src/dispatch/core/dispatch.js';
import { estimateOutputTokens } from '../../../../src/dispatch/core/economy.js';
import { EventStore } from '../../../../src/events/store.js';
import { findActionInRegistry } from '../../../../src/registry.js';

// Partial mock: only the handler is stubbed. `productionExecuteDeps` stays
// real, because the assertion below is that the composite hands the executor
// the live handler table rather than the executor reaching back for it.
vi.mock('../../../../src/verbs/execute/executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/verbs/execute/executor.js')>()),
  handleExecuteIntent: vi.fn().mockResolvedValue({
    success: true,
    data: {
      operationId: 'op-1',
      intent: 'task-completion',
      outcome: 'committed',
      leaves: [{ action: 'task_complete', status: 'passed', events: [{ type: 'task.completed', sequence: 1 }] }],
      tailSequence: 1,
      requestDigest: 'sha256:deadbeef',
      interaction: { leavesExecuted: 1, eventsAppended: 1, requests: 1, deferred: [] },
    },
  }),
}));

import { handleExecuteIntent } from '../../../../src/verbs/execute/executor.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

describe('exarchos_orchestrate routes execute_intent (registration boundary)', () => {
  const stateDir = '/tmp/test-execute-intent-registration-state';
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx(stateDir);
  });

  it('ExecuteIntent_RoutedToHandler_AndEnvelopeWrapped', async () => {
    const result = await handleOrchestrate(
      { action: 'execute_intent', intent: 'task-completion', featureId: 'f1', args: { taskId: 't1', worktreePath: '/tmp/wt' } },
      ctx,
    );

    expect(handleExecuteIntent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(handleExecuteIntent).mock.calls[0];
    expect(call?.[0]).toEqual({ intent: 'task-completion', featureId: 'f1', args: { taskId: 't1', worktreePath: '/tmp/wt' } });
    expect(call?.[1]).toBe(stateDir);
    expect(call?.[2]).toBe(ctx);
    // The table is handed IN. If the composite ever stopped passing it, the
    // executor would have nothing to route a compiled leaf through.
    expect(Object.keys(call?.[3]?.handlers ?? {})).toContain('task_complete');

    expect(result.success).toBe(true);
    expect(Object.hasOwn(result, 'data')).toBe(true);
    expect(Array.isArray(result.next_actions)).toBe(true);
    expect(result._meta).toBeTypeOf('object');
    expect((result._perf as { ms: number } | undefined)?.ms).toBeTypeOf('number');
  });
});

describe('execute_intent registered economy declaration', () => {
  const action = findActionInRegistry('exarchos_orchestrate', 'execute_intent');

  it('the action is registered with a declared budget', () => {
    expect(action).toBeDefined();
    expect(action?.economy?.budgetTokens).toBeGreaterThan(0);
    expect(typeof action?.economy?.summarize).toBe('function');
  });

  it('ExecuteIntentEconomy_OverBudgetPlusOne_SummarizesAndKeepsPinnedFields', () => {
    const budget = action?.economy?.budgetTokens;
    expect(budget).toBeDefined();
    if (budget === undefined) return;

    // A receipt whose serialized size clears the declared budget (byte length
    // over 4, `estimateOutputTokens`) by a wide margin — a runbook with many
    // more leaves than the one shipped intent has, so the over-budget shape
    // stays a realistic receipt rather than a padded blob.
    const leafCount = Math.ceil((budget * 5) / 60) + 50;
    const leaves = Array.from({ length: leafCount }, (_, i) => ({
      action: `leaf_${i}`,
      status: 'passed' as const,
      events: [{ type: 'gate.executed', sequence: i + 1 }],
    }));
    const bundleRefs = [
      { artifactId: 'run-bundle:execute-intent-run:op-over-budget', digest: { algorithm: 'sha256', value: 'c'.repeat(64) } },
    ];
    const receipt = {
      operationId: 'op-over-budget',
      intent: 'task-completion',
      outcome: 'committed' as const,
      leaves,
      tailSequence: leaves.length,
      requestDigest: 'sha256:over-budget',
      bundleRefs,
      interaction: { leavesExecuted: leaves.length, eventsAppended: leaves.length, requests: 1, deferred: [] },
    };

    const result = enforceResponseEconomy(
      { success: true, data: receipt },
      'exarchos_orchestrate',
      'execute_intent',
    );

    expect(result._meta).toMatchObject({ truncated: true });
    const data = result.data as Record<string, unknown>;
    // The pinned fields survive the cap — they are what a caller needs to keep
    // following the operation without the full per-leaf detail.
    expect(data.operationId).toBe('op-over-budget');
    expect(data.outcome).toBe('committed');
    expect(data.tailSequence).toBe(leaves.length);
    expect(data.failedLeaf).toBeUndefined();
    // The custody reference is the only pointer to the run's interior, so it
    // survives the cap alongside the four fields a caller follows the
    // operation by.
    expect(data.bundleRefs).toEqual(bundleRefs);
    // The generic capped shape's own fields are still present (CappedDataSchema).
    expect(typeof data.summary).toBe('string');
    expect(data.counts).toBeDefined();
    expect(Array.isArray(data.firstPage)).toBe(true);

    // The cap is a CEILING, not a label. A reducer that mapped every leaf into
    // `firstPage` produced a "capped" payload well over the declared budget,
    // which is the same thing as no cap while reading as one.
    expect(estimateOutputTokens(data)).toBeLessThanOrEqual(budget);
    expect((data.firstPage as unknown[]).length).toBeLessThan(leafCount);
    expect(data.counts).toMatchObject({
      leaves: leafCount,
      shown: (data.firstPage as unknown[]).length,
      total: leafCount,
    });
  });
});
