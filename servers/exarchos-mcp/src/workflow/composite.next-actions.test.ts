// ─── T041: next_actions populated on workflow envelopes ────────────────────
//
// DR-8: every envelope must carry `next_actions: NextAction[]` derived from
// the current workflow state + HSM topology. This suite asserts the
// composite-level integration — when a workflow handler returns data that
// includes `phase` + `workflowType`, the composite layer must invoke
// `computeNextActions` and attach the result to the envelope.
//
// The handler internals are mocked here so the test exercises only the
// wrap-boundary behavior (as with T036/T039 envelope suites).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import type { NextAction } from '../next-action.js';

// Mock every handler invoked by `handleWorkflow`. Critically, the mocked
// `handleGet` returns data containing BOTH `phase` and `workflowType`, which
// is what the real handler does (see `handleGet` in `./tools.ts`) — so the
// composite should look up the feature HSM and compute the outbound
// transitions from `plan-review`.
vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>();
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

vi.mock('./cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancelled' } }),
}));

vi.mock('./cleanup.js', () => ({
  handleCleanup: vi.fn().mockResolvedValue({ success: true, data: { phase: 'completed' } }),
}));

vi.mock('../describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleWorkflow } from './composite.js';

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

  it('NextActions_GetOnPlanReviewPhase_IncludesDelegateTransition', async () => {
    const result = await handleWorkflow({ action: 'get', featureId: 'f-test' }, ctx);

    // Shape guard: envelope still conforms.
    expect(result.success).toBe(true);

    const env = result as unknown as Record<string, unknown>;
    expect(Array.isArray(env.next_actions)).toBe(true);
    const actions = env.next_actions as NextAction[];

    // The feature HSM has plan-review → delegate as an outbound transition.
    // The composite must compute and attach this NextAction to the envelope.
    expect(actions.length).toBeGreaterThan(0);
    const hasDelegate = actions.some(
      (a) => a.verb === 'delegate' || a.validTargets?.includes('delegate') === true,
    );
    expect(hasDelegate).toBe(true);
  });

  it('NextActions_DescribeAction_ReturnsEmpty', async () => {
    // `describe` has no workflow context (no phase/workflowType in its
    // response data), so the composite must pass an empty array.
    const result = await handleWorkflow({ action: 'describe' }, ctx);

    expect(result.success).toBe(true);
    const env = result as unknown as Record<string, unknown>;
    expect(env.next_actions).toEqual([]);
  });

  it('NextActions_InitWithoutWorkflowType_ReturnsEmpty', async () => {
    // The mocked `handleInit` returns only `{ phase: 'ideate' }` with no
    // `workflowType` — the composite must feature-detect and pass `[]`
    // rather than throwing on an unknown workflow type.
    const result = await handleWorkflow(
      { action: 'init', featureId: 'test', workflowType: 'feature' },
      ctx,
    );

    expect(result.success).toBe(true);
    const env = result as unknown as Record<string, unknown>;
    expect(env.next_actions).toEqual([]);
  });
});
