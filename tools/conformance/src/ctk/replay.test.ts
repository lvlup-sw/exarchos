/**
 * The admission state of a phase attempt is a pure fold of persisted facts. This
 * suite proves the properties that a replay must hold:
 *
 * - Determinism: two folds of the same stream are byte-identical.
 * - Serialization: a JSON round trip of the stream folds identically.
 * - Stream independence: the fold does not depend on stream presentation order.
 * - Reconstruction: the frozen set, evidence and decision come back intact, for
 *   hand-built and live-freeze histories.
 * - Tamper detection: the fold refuses a changed decision digest. This negative
 *   control keeps the other checks meaningful.
 */

import { describe, it, expect } from 'vitest';

import { foldPhaseAttemptAdmission } from '../../../../src/workflow/admission/phase-attempt-state.js';
import {
  cleanAllowScenarios,
} from './__fixtures__/admission-scenario-corpus.js';
import {
  handBuiltIntactHistory,
  historyFromScenario,
  serializeHistory,
  deserializeHistory,
  reorderStreams,
  tamperDecisionDigest,
} from './__fixtures__/replay-harness.js';

describe('admission replay reconstructs identical state (exit-proof c)', () => {
  /** The integrity and attempt-count checks prove that the fold reconstructs real state. */
  it('ReplayFold_IsDeterministic_FoldingTwiceIsByteIdentical', () => {
    const history = handBuiltIntactHistory();
    const first = foldPhaseAttemptAdmission(history);
    const second = foldPhaseAttemptAdmission(history);

    expect(second).toEqual(first);
    expect(first.integrity).toBe('intact');
    expect(first.attempts).toHaveLength(2);
  });

  it('ReplayFold_SurvivesJsonRoundTrip_Identically', () => {
    const history = handBuiltIntactHistory();
    const direct = foldPhaseAttemptAdmission(history);
    const roundTripped = foldPhaseAttemptAdmission(
      deserializeHistory(serializeHistory(history)),
    );

    expect(roundTripped).toEqual(direct);
    expect(roundTripped.integrity).toBe('intact');
  });

  it('ReplayFold_IsInvariantTo_StreamPresentationOrder', () => {
    const history = handBuiltIntactHistory();
    const canonical = foldPhaseAttemptAdmission(history);
    const reordered = foldPhaseAttemptAdmission(reorderStreams(history));

    expect(reordered).toEqual(canonical);
  });

  it('ReplayFold_ReconstructsFrozenSet_Evidence_AndDecision', () => {
    const ONE = 'phase-attempt.plan.1';
    const fold = foldPhaseAttemptAdmission(handBuiltIntactHistory());

    expect(fold.integrity).toBe('intact');
    expect(fold.diagnostics).toEqual([]);

    const attempt = fold.attempts.find((a) => a.phaseAttemptId === ONE);
    expect(attempt, 'attempt one reconstructed').toBeDefined();
    expect(attempt?.integrity).toBe('intact');
    expect(attempt?.frozenRequirementSet?.requirementIds).toEqual([
      'requirement.typecheck',
      'requirement.tests',
    ]);
    expect(attempt?.evidence.map((e) => e.evidenceId)).toEqual([
      'evidence.1',
      'evidence.2',
    ]);
    expect(attempt?.unattributedEvidence).toEqual([]);
    expect(attempt?.decision?.decisionId).toBe('decision.1');
  });

  /**
   * For each clean scenario, the replayed frozen ids agree with the frozen
   * requirements. All evidence binds to the frozen set, so the fold quarantines no
   * evidence, and the fold attributes a decision.
   */
  it('ReplayFold_FromLiveFreeze_ReconstructsIntactState_ForEveryCleanScenario', () => {
    expect(cleanAllowScenarios.length).toBeGreaterThan(0);

    for (const scenario of cleanAllowScenarios) {
      const history = historyFromScenario(scenario);
      const fold = foldPhaseAttemptAdmission(history);

      expect(fold.integrity, `intact for ${scenario.name}`).toBe('intact');
      expect(fold.diagnostics, `no diagnostics for ${scenario.name}`).toEqual(
        [],
      );
      expect(fold.attempts, `one attempt for ${scenario.name}`).toHaveLength(1);

      const attempt = fold.attempts[0];
      expect(attempt?.phaseAttemptId).toBe(scenario.phaseAttemptId);
      expect(attempt?.frozenRequirementSet?.requirementIds).toEqual(
        attempt?.frozenRequirementSet?.requirements.map((r) => r.requirementId),
      );
      expect(
        attempt?.frozenRequirementSet?.requirementIds.length ?? 0,
      ).toBeGreaterThan(0);
      expect(attempt?.unattributedEvidence).toEqual([]);
      expect(attempt?.evidence.length).toBe(scenario.activeEvidence.length);
      expect(attempt?.decision).not.toBeNull();
    }
  });

  it('ReplayFold_FromLiveFreeze_IsDeterministic_AcrossReplays', () => {
    for (const scenario of cleanAllowScenarios) {
      const history = historyFromScenario(scenario);
      const a = foldPhaseAttemptAdmission(history);
      const b = foldPhaseAttemptAdmission(
        deserializeHistory(serializeHistory(history)),
      );
      expect(b, `deterministic replay for ${scenario.name}`).toEqual(a);
    }
  });

  /** The fold marks a tampered decision as contested and does not attribute it. */
  it('ReplayFold_DetectsTamperedDecisionDigest_AndRefusesAttribution', () => {
    const clean = foldPhaseAttemptAdmission(handBuiltIntactHistory());
    expect(clean.integrity).toBe('intact');

    const tampered = foldPhaseAttemptAdmission(
      tamperDecisionDigest(handBuiltIntactHistory()),
    );

    expect(tampered.integrity).toBe('contested');
    expect(
      tampered.diagnostics.some(
        (d) => d.code === 'DECISION_REQUIREMENT_SET_MISMATCH',
      ),
      'a decision-mismatch diagnostic is raised',
    ).toBe(true);
    const attemptOne = tampered.attempts.find(
      (a) => a.phaseAttemptId === 'phase-attempt.plan.1',
    );
    expect(attemptOne?.decision).toBeNull();
    expect(attemptOne?.integrity).toBe('contested');
  });
});
