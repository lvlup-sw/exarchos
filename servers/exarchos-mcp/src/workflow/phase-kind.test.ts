import { describe, it, expect } from 'vitest';
import { KIND_OBLIGATIONS } from './phase-kind.js';

describe('KIND_OBLIGATIONS', () => {
  it('KindObligations_EveryKind_HasARow', () => {
    expect(Object.keys(KIND_OBLIGATIONS).sort()).toEqual([
      'GATHER',
      'IMPLEMENT',
      'PLAN',
      'REVIEW',
      'SYNTHESIZE',
    ]);
  });

  it('KindObligations_ImplementRow_PointsAtVerificationLadder', () => {
    expect(KIND_OBLIGATIONS.IMPLEMENT.gates?.resolver).toBe('verification-ladder');
  });

  it('KindObligations_GatherRow_HasNullGates', () => {
    expect(KIND_OBLIGATIONS.GATHER.gates).toBeNull();
  });

  it('KindObligations_ReviewRow_IsReadOnly', () => {
    expect(KIND_OBLIGATIONS.REVIEW.posture).toBe('read-only');
  });
});
