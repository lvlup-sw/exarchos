import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import {
  executeTransition,
  getValidTransitions,
  getHSMDefinition,
  type HSMDefinition,
} from '../../../src/workflow/state-machine.js';

const WORKFLOW_TYPES = ['feature', 'debug', 'refactor'] as const;

/** Generate a random workflow type. */
const arbWorkflowType = fc.constantFrom(...WORKFLOW_TYPES);

/** Generate a valid (workflowType, phase) pair from the HSM definition. */
function arbPhaseForHSM(hsm: HSMDefinition): fc.Arbitrary<string> {
  const phases = Object.keys(hsm.states);
  return fc.constantFrom(...phases);
}

/**
 * Generate (phase, target) pairs from the targets that `getValidTransitions` returns.
 * Guarded targets are in the set, so a pair can fail its guard.
 */
function arbValidTransitionPair(
  hsm: HSMDefinition,
): fc.Arbitrary<{ fromPhase: string; targetPhase: string }> {
  const pairs: Array<{ fromPhase: string; targetPhase: string }> = [];

  for (const phase of Object.keys(hsm.states)) {
    const targets = getValidTransitions(hsm, phase);
    for (const target of targets) {
      pairs.push({ fromPhase: phase, targetPhase: target.phase });
    }
  }

  if (pairs.length === 0) {
    return fc.constant({ fromPhase: 'ideate', targetPhase: 'plan' });
  }

  return fc.constantFrom(...pairs);
}

/**
 * Generate (phase, target) pairs where the target is not a valid transition.
 * Self-transitions are excluded because they are idempotent, not invalid.
 */
function arbInvalidTransitionPair(
  hsm: HSMDefinition,
): fc.Arbitrary<{ fromPhase: string; targetPhase: string }> {
  const allPhases = Object.keys(hsm.states);
  const pairs: Array<{ fromPhase: string; targetPhase: string }> = [];

  for (const phase of allPhases) {
    const validTargets = new Set(
      getValidTransitions(hsm, phase).map((t) => t.phase),
    );
    validTargets.add(phase);

    for (const target of allPhases) {
      if (!validTargets.has(target)) {
        pairs.push({ fromPhase: phase, targetPhase: target });
      }
    }
  }

  if (pairs.length === 0) {
    return fc.constant({ fromPhase: '__nonexistent__', targetPhase: '__nonexistent__' });
  }

  return fc.constantFrom(...pairs);
}

/**
 * Build a state for a phase that satisfies the common guard conditions.
 * Some guards can still fail. The properties test structure, not guard logic.
 */
function buildStateForPhase(phase: string): Record<string, unknown> {
  return {
    phase,
    _events: [],
    _history: {},
    artifacts: {
      design: '/path/to/design.md',
      plan: '/path/to/plan.md',
    },
    planReview: { status: 'approved' },
    tasks: { task1: { status: 'complete' } },
    reviews: { review1: { status: 'approved' } },
    prUrl: 'https://github.com/test/pr/1',
    validation: {
      mergeVerified: true,
      docsUpdated: true,
      goalsVerified: true,
    },
    triage: { verdict: 'thorough' },
    track: 'thorough',
    rca: { document: '/path/to/rca.md' },
    fixDesign: { document: '/path/to/fix-design.md' },
    implementation: { complete: true },
    scopeAssessment: { complete: true },
    selectedTrack: 'polish',
    humanUnblocked: true,
    mergeVerified: true,
  };
}

describe('State Machine Property Tests', () => {
  describe.each(WORKFLOW_TYPES)('HSM type: %s', (workflowType) => {
    const hsm = getHSMDefinition(workflowType);

    describe('executeTransition_ValidPair_ProducesPhaseInHSMDefinition', () => {
      /** A failure can come from a guard, an open circuit breaker, or a fault in the gate-set resolver. */
      it('for any valid (phase, target) pair, newPhase is a key in hsm.states or result fails due to guard', () => {
        fc.assert(
          fc.property(arbValidTransitionPair(hsm), ({ fromPhase, targetPhase }) => {
            const state = buildStateForPhase(fromPhase);
            const result = executeTransition(hsm, state, targetPhase);

            if (result.success) {
              expect(result.newPhase).toBeDefined();
              expect(hsm.states).toHaveProperty(result.newPhase!);
            }
            if (!result.success) {
              expect(result.errorCode).toBeDefined();
              expect([
                'GUARD_FAILED',
                'CIRCUIT_OPEN',
                'INVALID_TRANSITION',
                'PHASE_BLOCKED',
              ]).toContain(result.errorCode);
            }
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('executeTransition_InvalidTarget_NeverSucceeds', () => {
      it('for any phase with a target NOT in its valid transitions, result.success === false', () => {
        fc.assert(
          fc.property(arbInvalidTransitionPair(hsm), ({ fromPhase, targetPhase }) => {
            const state = buildStateForPhase(fromPhase);
            const result = executeTransition(hsm, state, targetPhase);

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('INVALID_TRANSITION');
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('executeTransition_Determinism_SameInputSameOutput', () => {
      it('calling executeTransition twice with identical args produces identical TransitionResult', () => {
        fc.assert(
          fc.property(arbPhaseForHSM(hsm), arbPhaseForHSM(hsm), (fromPhase, targetPhase) => {
            const state = buildStateForPhase(fromPhase);

            const result1 = executeTransition(hsm, state, targetPhase);
            const result2 = executeTransition(hsm, state, targetPhase);

            expect(result1).toEqual(result2);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
