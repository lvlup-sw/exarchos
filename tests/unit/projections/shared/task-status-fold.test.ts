/**
 * Tests for the shared monotonic task-status fold.
 *
 * `state.patched` events from `handleSet` skip the `TaskStatusSchema` preprocess, so old events
 * keep the legacy status words. `normalizeTaskStatus` must map those words. If it does not, the
 * tasks fall back to `pending` and the task counts go wrong.
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

  /** The legacy `'completed'` maps to `complete`, the same as the `TaskStatusSchema` preprocess. */
  it('NormalizeTaskStatus_LegacyCompleted_MapsToComplete', () => {
    expect(normalizeTaskStatus('completed')).toBe('complete');
  });

  /** The legacy `'assigned'` maps to `in_progress`, the same as `upgradeRehydrationDocumentV3toV4`. */
  it('NormalizeTaskStatus_LegacyAssigned_MapsToInProgress', () => {
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
  /** The legacy `'completed'` normalizes to `complete`, which has a higher rank than `in_progress`. */
  it('PromoteStatus_LegacyCompletedFold_MonotonicallyPromotesFromInProgress', () => {
    const initial: Record<string, string> = { 'T-001': 'in_progress' };
    const next = promoteStatus(initial, 'T-001', normalizeTaskStatus('completed'));
    expect(next['T-001']).toBe('complete');
    expect(rankOf(next['T-001'])).toBe(2);
  });

  it('PromoteStatus_TerminalNeverRegresses', () => {
    const initial: Record<string, string> = { 'T-001': 'complete' };
    const next = promoteStatus(initial, 'T-001', 'pending');
    expect(next['T-001']).toBe('complete');
  });
});
