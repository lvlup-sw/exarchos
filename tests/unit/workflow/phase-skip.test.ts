import { describe, it, expect } from 'vitest';
import { applyPhaseSkips } from '../../../src/workflow/phase-skip.js';
import type { HSMDefinition, State, Transition } from '../../../src/workflow/state-machine.js';

/** `testHsm` is the chain A, B, C, D, and D is final. */
describe('applyPhaseSkips', () => {
  const testHsm: HSMDefinition = {
    id: 'test',
    states: {
      A: { id: 'A', type: 'atomic' as const },
      B: { id: 'B', type: 'atomic' as const },
      C: { id: 'C', type: 'atomic' as const },
      D: { id: 'D', type: 'final' as const },
    },
    transitions: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C', guard: { id: 'b-to-c-guard', description: 'test guard', evaluate: () => true as const } },
      { from: 'C', to: 'D' },
    ],
  };

  it('applyPhaseSkips_EmptyList_ReturnsUnmodifiedHSM', () => {
    const result = applyPhaseSkips(testHsm, []);
    expect(result.transitions).toHaveLength(3);
    expect(result).toEqual(testHsm);
  });

  it('applyPhaseSkips_SkipMiddlePhase_ReroutesTransitions', () => {
    const result = applyPhaseSkips(testHsm, ['B']);
    const aTransition = result.transitions.find(t => t.from === 'A');
    expect(aTransition?.to).toBe('C');
    expect(result.transitions.find(t => t.from === 'B')).toBeUndefined();
  });

  it('applyPhaseSkips_SkipMultiplePhases_ReroutesAll', () => {
    const result = applyPhaseSkips(testHsm, ['B', 'C']);
    const aTransition = result.transitions.find(t => t.from === 'A');
    expect(aTransition?.to).toBe('D');
  });

  it('applyPhaseSkips_SkippedPhaseGuard_InheritedByPredecessor', () => {
    const result = applyPhaseSkips(testHsm, ['B']);
    const aTransition = result.transitions.find(t => t.from === 'A');
    expect(aTransition?.guard?.id).toBe('b-to-c-guard');
  });

  /** A has no incoming transition, so the skip treats it as the initial phase. */
  it('applyPhaseSkips_InitialPhase_RejectedWithError', () => {
    expect(() => applyPhaseSkips(testHsm, ['A'])).toThrow(/cannot skip initial/i);
  });

  it('applyPhaseSkips_FinalPhase_RejectedWithError', () => {
    expect(() => applyPhaseSkips(testHsm, ['D'])).toThrow(/cannot skip final/i);
  });

  it('applyPhaseSkips_NonexistentPhase_IgnoredSilently', () => {
    const result = applyPhaseSkips(testHsm, ['nonexistent']);
    expect(result.transitions).toHaveLength(3);
  });

  it('applyPhaseSkips_CompoundState_ChildrenSkipped', () => {
    const hsmWithCompound: HSMDefinition = {
      id: 'test-compound',
      states: {
        start: { id: 'start', type: 'atomic' as const },
        impl: { id: 'impl', type: 'compound' as const, initial: 'delegate' },
        delegate: { id: 'delegate', type: 'atomic' as const, parent: 'impl' },
        review: { id: 'review', type: 'atomic' as const, parent: 'impl' },
        done: { id: 'done', type: 'final' as const },
      },
      transitions: [
        { from: 'start', to: 'impl' },
        { from: 'delegate', to: 'review' },
        { from: 'impl', to: 'done' },
      ],
    };

    const result = applyPhaseSkips(hsmWithCompound, ['impl']);
    const startTransition = result.transitions.find(t => t.from === 'start');
    expect(startTransition?.to).toBe('done');
    expect(result.transitions.find(t => t.from === 'delegate')).toBeUndefined();
  });

  it('applyPhaseSkips_PredecessorGuardPreserved_WhenSkippedHasNoGuard', () => {
    const hsmWithGuardOnPredecessor: HSMDefinition = {
      id: 'test-guard-preserve',
      states: {
        X: { id: 'X', type: 'atomic' as const },
        Y: { id: 'Y', type: 'atomic' as const },
        Z: { id: 'Z', type: 'final' as const },
      },
      transitions: [
        { from: 'X', to: 'Y', guard: { id: 'x-guard', description: 'predecessor guard', evaluate: () => true as const } },
        { from: 'Y', to: 'Z' },
      ],
    };

    const result = applyPhaseSkips(hsmWithGuardOnPredecessor, ['Y']);
    const xTransition = result.transitions.find(t => t.from === 'X');
    expect(xTransition?.to).toBe('Z');
    expect(xTransition?.guard?.id).toBe('x-guard');
  });

  it('applyPhaseSkips_DoesNotMutateOriginalHSM', () => {
    const originalTransitionCount = testHsm.transitions.length;
    applyPhaseSkips(testHsm, ['B']);
    expect(testHsm.transitions).toHaveLength(originalTransitionCount);
  });

  it('applyPhaseSkips_MultiBranch_AllOutgoingTransitionsPreserved', () => {
    const multiBranchHsm: HSMDefinition = {
      id: 'test-multi-branch',
      states: {
        A: { id: 'A', type: 'atomic' as const },
        B: { id: 'B', type: 'atomic' as const },
        C: { id: 'C', type: 'atomic' as const },
        E: { id: 'E', type: 'atomic' as const },
        D: { id: 'D', type: 'final' as const },
      },
      transitions: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C', guard: { id: 'success-guard', description: 'success path', evaluate: () => true as const } },
        { from: 'B', to: 'E', guard: { id: 'failure-guard', description: 'failure path', evaluate: () => true as const } },
        { from: 'C', to: 'D' },
        { from: 'E', to: 'D' },
      ],
    };

    const result = applyPhaseSkips(multiBranchHsm, ['B']);

    const aTransitions = result.transitions.filter(t => t.from === 'A');
    expect(aTransitions).toHaveLength(2);

    const toC = aTransitions.find(t => t.to === 'C');
    const toE = aTransitions.find(t => t.to === 'E');
    expect(toC).toBeDefined();
    expect(toE).toBeDefined();

    expect(toC?.guard?.id).toBe('success-guard');
    expect(toE?.guard?.id).toBe('failure-guard');

    expect(result.transitions.find(t => t.from === 'B')).toBeUndefined();
  });
});
