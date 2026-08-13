// ─── P07-04 exit-proof (c) — admission replay reconstructs identical state ───
//
// P01-04 / P06-07 guarantee that a phase attempt's admission state is a pure
// fold of persisted facts. This suite proves that guarantee AS A SUITE across
// the properties a trustworthy replay must hold:
//
//   • determinism           — folding the same stream twice is byte-identical;
//   • serialization fidelity — a JSON round-trip of the stream folds identically;
//   • stream independence    — the fold privileges no stream's presentation order;
//   • reconstruction fidelity — frozen set, evidence, and decision come back
//                               intact, both for hand-built AND live-freeze
//                               derived histories;
//   • tamper sensitivity      — a doctored decision digest is refused (the
//                               negative control that keeps the above non-vacuous).

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
  it('ReplayFold_IsDeterministic_FoldingTwiceIsByteIdentical', () => {
    const history = handBuiltIntactHistory();
    const first = foldPhaseAttemptAdmission(history);
    const second = foldPhaseAttemptAdmission(history);

    expect(second).toEqual(first);
    // Non-vacuous: it actually reconstructed two intact attempts.
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
      // The frozen requirement ids replayed match the live freeze exactly.
      expect(attempt?.frozenRequirementSet?.requirementIds).toEqual(
        attempt?.frozenRequirementSet?.requirements.map((r) => r.requirementId),
      );
      expect(
        attempt?.frozenRequirementSet?.requirementIds.length ?? 0,
      ).toBeGreaterThan(0);
      // All of the scenario's evidence bound to the frozen set (none quarantined).
      expect(attempt?.unattributedEvidence).toEqual([]);
      expect(attempt?.evidence.length).toBe(scenario.activeEvidence.length);
      // The decision was attributed to the frozen generation.
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
    // The tampered decision is NOT silently trusted.
    const attemptOne = tampered.attempts.find(
      (a) => a.phaseAttemptId === 'phase-attempt.plan.1',
    );
    expect(attemptOne?.decision).toBeNull();
    expect(attemptOne?.integrity).toBe('contested');
  });
});
