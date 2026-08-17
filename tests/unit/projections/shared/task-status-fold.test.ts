/**
 * Co-located tests for the shared monotonic task-status fold helper.
 *
 * Sentry follow-up on PR #1394 (`task-status-fold.ts:58`): the workflow-side
 * `TaskStatusSchema` carries a `z.preprocess` mapping the legacy
 * `'completed'` literal to the canonical `'complete'`, but
 * `state.patched` events emitted by `handleSet` do NOT route their
 * `input.updates` through that schema. Historical events with
 * `status: 'completed'` therefore arrive at the projections unchanged.
 * Without the same legacy-mapping inside `normalizeTaskStatus`, those
 * tasks would silently downgrade to `pending`, breaking
 * taskCount/completedCount and risking re-dispatch of finished work.
 */

import { describe, it, expect } from 'vitest';

import {
  extractPlanTasksFromPatch,
  normalizeTaskStatus,
  promoteStatus,
  rankOf,
} from '../../../../src/projections/shared/task-status-fold.js';

describe('normalizeTaskStatus', () => {
  it('NormalizeTaskStatus_CanonicalValues_RoundTrip', () => {
    expect(normalizeTaskStatus('pending')).toBe('pending');
    expect(normalizeTaskStatus('in_progress')).toBe('in_progress');
    expect(normalizeTaskStatus('complete')).toBe('complete');
    expect(normalizeTaskStatus('failed')).toBe('failed');
  });

  it('NormalizeTaskStatus_LegacyCompleted_MapsToComplete', () => {
    // Pre-#1359 corpus emits `state.patched { patch: { tasks: [{status: "completed"}] } }`.
    // The legacy literal must promote to the canonical `complete`, not
    // silently downgrade to `pending` (which would re-dispatch finished
    // work). Mirrors the `TaskStatusSchema` `z.preprocess` mapping.
    expect(normalizeTaskStatus('completed')).toBe('complete');
  });

  it('NormalizeTaskStatus_LegacyAssigned_MapsToInProgress', () => {
    // Pre-#1359 corpus emits `state.patched { patch: { tasks: [{status: "assigned"}] } }`.
    // The legacy `'assigned'` literal must promote to `'in_progress'`,
    // not silently downgrade to `'pending'` (which would re-dispatch
    // work already in flight). Mirrors `upgradeRehydrationDocumentV3toV4`'s
    // `'assigned' → 'in_progress'` rename (#1359 / PR4 T12).
    expect(normalizeTaskStatus('assigned')).toBe('in_progress');
  });

  it('NormalizeTaskStatus_UnknownValue_FallsBackToPending', () => {
    expect(normalizeTaskStatus('mystery-status')).toBe('pending');
    expect(normalizeTaskStatus(undefined)).toBe('pending');
    expect(normalizeTaskStatus(null)).toBe('pending');
    expect(normalizeTaskStatus(42)).toBe('pending');
  });
});

describe('extractPlanTasksFromPatch (legacy status carrier)', () => {
  it('ExtractPlanTasks_LegacyCompletedStatus_MapsToCanonicalComplete', () => {
    // Simulates a pre-#1359 `state.patched` payload containing the
    // legacy literal. The extracted task must surface the canonical
    // `complete` so downstream rankOf/promoteStatus treats it as
    // terminal.
    const extracted = extractPlanTasksFromPatch({
      patch: {
        tasks: [
          { id: 'T-001', status: 'completed' },
          { id: 'T-002', status: 'complete' },
          { id: 'T-003', status: 'in_progress' },
        ],
      },
    });

    expect(extracted).toEqual([
      { id: 'T-001', status: 'complete' },
      { id: 'T-002', status: 'complete' },
      { id: 'T-003', status: 'in_progress' },
    ]);
  });
});

describe('promoteStatus + rankOf (monotonic ladder)', () => {
  it('PromoteStatus_LegacyCompletedFold_MonotonicallyPromotesFromInProgress', () => {
    // The historical projection scenario: an in_progress task is
    // re-asserted via state.patched with the legacy `'completed'`.
    // After normalization, promoteStatus must advance the entry to
    // `complete` (rank 2 > rank 1).
    const initial: Record<string, string> = { 'T-001': 'in_progress' };
    const next = promoteStatus(initial, 'T-001', normalizeTaskStatus('completed'));
    expect(next['T-001']).toBe('complete');
    expect(rankOf(next['T-001'])).toBe(2);
  });

  it('PromoteStatus_TerminalNeverRegresses', () => {
    // Once `complete`, a subsequent `pending` assertion must not
    // regress the entry — the precedence ladder is monotonic.
    const initial: Record<string, string> = { 'T-001': 'complete' };
    const next = promoteStatus(initial, 'T-001', 'pending');
    expect(next['T-001']).toBe('complete');
  });
});
