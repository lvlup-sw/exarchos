// Co-located unit tests for `nextActionsFromResult` (#1208 / DR-MO-1).
//
// Two payload shapes must be recognised:
//
//   1. Workflow-handler shape (`handleInit`/`handleGet`/`handleSet`):
//      `{ phase, workflowType, ... }` at the top level.
//   2. Rehydration document shape (`handleRehydrate`):
//      `{ workflowState: { phase, workflowType, featureId, mergeOrchestrator } }`.
//
// Pre-fix only shape 1 was extracted, so rehydrate envelopes always returned
// `next_actions: []` even when the merge-pending detour was active. These
// tests pin shape 2 + the merge_orchestrate surfacing branch.
import { describe, it, expect } from 'vitest';
import { nextActionsFromResult } from './next-actions-from-result.js';
import type { ToolResult } from './format.js';

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

describe('nextActionsFromResult — shape recognition', () => {
  it('returns [] for non-success results', () => {
    const result: ToolResult = {
      success: false,
      error: { code: 'X', message: 'no' },
    };
    expect(nextActionsFromResult(result)).toEqual([]);
  });

  it('returns [] when payload lacks phase + workflowType', () => {
    expect(nextActionsFromResult(ok({}))).toEqual([]);
    expect(nextActionsFromResult(ok({ random: 'thing' }))).toEqual([]);
    expect(nextActionsFromResult(ok(null))).toEqual([]);
  });

  it('extracts shape 1 (handler payload) — phase + workflowType at top level', () => {
    const actions = nextActionsFromResult(
      ok({ phase: 'ideate', workflowType: 'feature' }),
    );
    // `ideate → plan` is the sole transition out of `ideate`.
    expect(actions.map((a) => a.verb)).toEqual(['plan']);
  });

  it('extracts shape 2 (rehydration document) — workflowState segment', () => {
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'feat-x',
          phase: 'ideate',
          workflowType: 'feature',
        },
      }),
    );
    expect(actions.map((a) => a.verb)).toEqual(['plan']);
  });

  it('surfaces merge_orchestrate from shape 2 when phase is merge-pending', () => {
    // Pre-fix this returned [] because shape 2 was not recognised. With
    // shape-2 recognition in place, the `merge-pending` substate's
    // `merge_orchestrate` verb is surfaced (idempotency-keyed by
    // `<featureId>:merge_orchestrate:<taskId>`).
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'p2-detour',
          phase: 'merge-pending',
          workflowType: 'feature',
          mergeOrchestrator: { taskId: '001', phase: 'pending' },
        },
      }),
    );
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(true);
    const mo = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(mo?.idempotencyKey).toBe('p2-detour:merge_orchestrate:001');
  });

  it('does NOT surface merge_orchestrate when mergeOrchestrator phase is terminal', () => {
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'p2-detour',
          phase: 'merge-pending',
          workflowType: 'feature',
          mergeOrchestrator: { taskId: '001', phase: 'completed' },
        },
      }),
    );
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(false);
  });

  it('prefers shape 1 when both shapes could match', () => {
    // Top-level fields take precedence — keeps the cheap, common path
    // unchanged for handler payloads that happen to include a workflowState
    // sibling for downstream consumers.
    const actions = nextActionsFromResult(
      ok({
        phase: 'ideate',
        workflowType: 'feature',
        workflowState: {
          featureId: 'x',
          phase: 'merge-pending',
          workflowType: 'feature',
        },
      }),
    );
    expect(actions.map((a) => a.verb)).toEqual(['plan']);
  });

  it('returns [] for unknown workflowType in shape 2', () => {
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'x',
          phase: 'ideate',
          workflowType: 'no-such-workflow',
        },
      }),
    );
    expect(actions).toEqual([]);
  });
});
