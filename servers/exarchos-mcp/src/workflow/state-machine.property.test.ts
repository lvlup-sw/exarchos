import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import {
  executeTransition,
  getValidTransitions,
  getHSMDefinition,
  type HSMDefinition,
} from './state-machine.js';

// ─── Shared Generators ────────────────────────────────────────────────────

const WORKFLOW_TYPES = ['feature', 'debug', 'refactor'] as const;

/** Generate a random workflow type. */
const arbWorkflowType = fc.constantFrom(...WORKFLOW_TYPES);

/** Generate a valid (workflowType, phase) pair from the HSM definition. */
function arbPhaseForHSM(hsm: HSMDefinition): fc.Arbitrary<string> {
  const phases = Object.keys(hsm.states);
  return fc.constantFrom(...phases);
}

/**
 * Generate valid (phase, target) transition pairs for a given HSM.
 * Collects all non-final phases and their valid transition targets,
 * returning pairs that should succeed (ignoring guarded transitions).
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
    // Fallback: should not happen with well-defined HSMs
    return fc.constant({ fromPhase: 'ideate', targetPhase: 'plan' });
  }

  return fc.constantFrom(...pairs);
}

/**
 * Generate invalid (phase, target) pairs -- targets NOT in valid transitions.
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
    // Also exclude self-transitions (which are idempotent, not invalid)
    validTargets.add(phase);

    for (const target of allPhases) {
      if (!validTargets.has(target)) {
        pairs.push({ fromPhase: phase, targetPhase: target });
      }
    }
  }

  if (pairs.length === 0) {
    // Fallback for fully connected HSMs (unlikely)
    return fc.constant({ fromPhase: '__nonexistent__', targetPhase: '__nonexistent__' });
  }

  return fc.constantFrom(...pairs);
}

// ─── Helper: Build minimal state that satisfies all guards ──────────────

/**
 * Builds a workflow state object for a given phase that attempts to satisfy
 * guard conditions. This is a best-effort approach -- guards that check
 * complex nested state may still fail, which is acceptable for property
 * testing since we're testing structural invariants, not guard logic.
 */
function buildStateForPhase(phase: string): Record<string, unknown> {
  return {
    phase,
    _events: [],
    _history: {},
    // Satisfy common guard conditions
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

// ─── Property Tests ─────────────────────────────────────────────────────

describe('State Machine Property Tests', () => {
  describe.each(WORKFLOW_TYPES)('HSM type: %s', (workflowType) => {
    const hsm = getHSMDefinition(workflowType);

    describe('executeTransition_ValidPair_ProducesPhaseInHSMDefinition', () => {
      it('for any valid (phase, target) pair, newPhase is a key in hsm.states or result fails due to guard', () => {
        fc.assert(
          fc.property(arbValidTransitionPair(hsm), ({ fromPhase, targetPhase }) => {
            const state = buildStateForPhase(fromPhase);
            const result = executeTransition(hsm, state, targetPhase);

            // If successful, newPhase must be a valid state in the HSM
            if (result.success) {
              expect(result.newPhase).toBeDefined();
              expect(hsm.states).toHaveProperty(result.newPhase!);
            }
            // If it failed, it should have an error code (guard or circuit breaker)
            if (!result.success) {
              expect(result.errorCode).toBeDefined();
              expect(['GUARD_FAILED', 'CIRCUIT_OPEN', 'INVALID_TRANSITION']).toContain(
                result.errorCode,
              );
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
