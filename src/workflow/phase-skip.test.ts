import { describe, it, expect } from 'vitest';
import { applyPhaseSkips } from './phase-skip.js';
import type { HSMDefinition, State, Transition } from './state-machine.js';

describe('applyPhaseSkips', () => {
  // Minimal test HSM: A → B → C → D(final)
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
    // A should now go directly to C, B transitions removed
    const aTransition = result.transitions.find(t => t.from === 'A');
    expect(aTransition?.to).toBe('C');
    expect(result.transitions.find(t => t.from === 'B')).toBeUndefined();
  });

  it('applyPhaseSkips_SkipMultiplePhases_ReroutesAll', () => {
    const result = applyPhaseSkips(testHsm, ['B', 'C']);
    // A should now go directly to D
    const aTransition = result.transitions.find(t => t.from === 'A');
    expect(aTransition?.to).toBe('D');
  });

  it('applyPhaseSkips_SkippedPhaseGuard_InheritedByPredecessor', () => {
    // B→C has a guard. If B is skipped, A→C should inherit that guard
    const result = applyPhaseSkips(testHsm, ['B']);
    const aTransition = result.transitions.find(t => t.from === 'A');
    expect(aTransition?.guard?.id).toBe('b-to-c-guard');
  });

  it('applyPhaseSkips_InitialPhase_RejectedWithError', () => {
    // First state in the HSM (A) has no incoming transitions, so it's the initial phase
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
    // Child transitions should also be removed
    expect(result.transitions.find(t => t.from === 'delegate')).toBeUndefined();
  });

  it('applyPhaseSkips_PredecessorGuardPreserved_WhenSkippedHasNoGuard', () => {
    // When the skipped phase's outgoing transition has no guard,
    // the predecessor's existing guard should be preserved
    const hsmWithGuardOnPredecessor: HSMDefinition = {
      id: 'test-guard-preserve',
      states: {
        X: { id: 'X', type: 'atomic' as const },
        Y: { id: 'Y', type: 'atomic' as const },
        Z: { id: 'Z', type: 'final' as const },
      },
      transitions: [
        { from: 'X', to: 'Y', guard: { id: 'x-guard', description: 'predecessor guard', evaluate: () => true as const } },
        { from: 'Y', to: 'Z' }, // no guard on outgoing
      ],
    };

    const result = applyPhaseSkips(hsmWithGuardOnPredecessor, ['Y']);
    const xTransition = result.transitions.find(t => t.from === 'X');
    expect(xTransition?.to).toBe('Z');
    // Should keep the predecessor's guard since skipped phase has no outgoing guard
    expect(xTransition?.guard?.id).toBe('x-guard');
  });

  it('applyPhaseSkips_DoesNotMutateOriginalHSM', () => {
    const originalTransitionCount = testHsm.transitions.length;
    applyPhaseSkips(testHsm, ['B']);
    expect(testHsm.transitions).toHaveLength(originalTransitionCount);
  });

  it('applyPhaseSkips_MultiBranch_AllOutgoingTransitionsPreserved', () => {
    // HSM where B has two outgoing transitions (e.g., success and failure paths)
    // A → B, B → C (success), B → E (failure), C → D(final), E → D(final)
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

    // A should now have transitions to both C and E
    const aTransitions = result.transitions.filter(t => t.from === 'A');
    expect(aTransitions).toHaveLength(2);

    const toC = aTransitions.find(t => t.to === 'C');
    const toE = aTransitions.find(t => t.to === 'E');
    expect(toC).toBeDefined();
    expect(toE).toBeDefined();

    // Guards should be inherited from the skipped phase's outgoing transitions
    expect(toC?.guard?.id).toBe('success-guard');
    expect(toE?.guard?.id).toBe('failure-guard');

    // No transitions from B should remain
    expect(result.transitions.find(t => t.from === 'B')).toBeUndefined();
  });
});
