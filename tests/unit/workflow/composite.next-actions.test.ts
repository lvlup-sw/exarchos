/**
 * Pins that `handleWorkflow` attaches `next_actions` to the envelope. When the handler data
 * carries `phase` and `workflowType`, the list holds the outbound HSM transitions. Otherwise
 * the list is empty. The handlers are mocked, so the suite tests only the envelope boundary.
 * The mocked `handleGet` returns `phase` and `workflowType`, as the real handler does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import type { NextAction } from '../../../src/next-action.js';

vi.mock('../../../src/workflow/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/workflow/tools.js')>();
  return {
    ...actual,
    handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' } }),
    handleGet: vi.fn().mockResolvedValue({
      success: true,
      data: {
        featureId: 'f-test',
        workflowType: 'feature',
        phase: 'plan-review',
      },
    }),
    handleSet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'plan-review' } }),
    handleCheckpoint: vi.fn().mockResolvedValue({ success: true, data: { phase: 'plan-review' } }),
    handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 0 } }),
  };
});

vi.mock('../../../src/workflow/cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancelled' } }),
}));

vi.mock('../../../src/workflow/cleanup.js', () => ({
  handleCleanup: vi.fn().mockResolvedValue({ success: true, data: { phase: 'completed' } }),
}));

vi.mock('../../../src/describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleWorkflow } from '../../../src/workflow/composite.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

describe('WorkflowComposite_NextActions_Populated (T041, DR-8)', () => {
  const stateDir = '/tmp/test-t041-next-actions';
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx(stateDir);
  });

  /** The feature HSM has a `plan-review` to `delegate` transition, so the envelope must list it. */
  it('NextActions_GetOnPlanReviewPhase_IncludesDelegateTransition', async () => {
    const result = await handleWorkflow({ action: 'get', featureId: 'f-test' }, ctx);

    expect(result.success).toBe(true);

    const env = result as unknown as Record<string, unknown>;
    expect(Array.isArray(env.next_actions)).toBe(true);
    const actions = env.next_actions as NextAction[];

    expect(actions.length).toBeGreaterThan(0);
    const hasDelegate = actions.some(
      (a) => a.verb === 'delegate' || a.validTargets?.includes('delegate') === true,
    );
    expect(hasDelegate).toBe(true);
  });

  /** The `describe` data holds no `phase` and no `workflowType`, so the list must be empty. */
  it('NextActions_DescribeAction_ReturnsEmpty', async () => {
    const result = await handleWorkflow({ action: 'describe' }, ctx);

    expect(result.success).toBe(true);
    const env = result as unknown as Record<string, unknown>;
    expect(env.next_actions).toEqual([]);
  });

  /**
   * The mocked `handleInit` returns only `{ phase: 'ideate' }`. Without `workflowType`, the list
   * must be empty and the call must not throw.
   */
  it('NextActions_InitWithoutWorkflowType_ReturnsEmpty', async () => {
    const result = await handleWorkflow(
      { action: 'init', featureId: 'test', workflowType: 'feature' },
      ctx,
    );

    expect(result.success).toBe(true);
    const env = result as unknown as Record<string, unknown>;
    expect(env.next_actions).toEqual([]);
  });
});
