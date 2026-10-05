// Tests for the cutover gate. Each condition blocks enforcement on its own. The
// conditions are a clean corpus, the live-attempt threshold, phase-kind
// coverage, outcome coverage, comparable disagreement classes, and a healthy
// observer. A satisfied gate gives an `approve-enforcement` rollout decision and
// an enforcement-enabled fact. An unsatisfied gate cannot produce an
// enforcement-enabled fact.

import { describe, expect, it } from 'vitest';

import type { PhaseKind } from '../../../../src/workflow/phase-kind.js';
import type { ShadowDecisionRecord, ShadowProvenance } from '../../../../src/workflow/admission/shadow-decision.js';
import type {
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  ContentDigestV1,
} from '../../../../src/workflow/admission/types.js';
import {
  ALL_PHASE_KINDS,
  CutoverGateNotSatisfiedError,
  MINIMUM_LIVE_ATTEMPTS,
  decideRollout,
  evaluateCutoverGate,
  isComparableShadowClass,
  readDurableShadowAttempts,
  toEnforcementEnabledData,
  toRolloutDecisionData,
  type CutoverGateEvidence,
  type DurableShadowAttemptFact,
  type LiveShadowAttempt,
  type CutoverPolicyRef,
} from '../../../../src/workflow/admission/cutover-gate.js';
import {
  ZERO_LIVE_SHADOW_HEALTH,
  liveShadowEvidenceStreamId,
  type LiveShadowHealth,
} from '../../../../src/workflow/admission/live-shadow-observer.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const AT = '2026-07-21T20:00:00.000Z';
const digest = (value = SHA_A): ContentDigestV1 => ({
  algorithm: 'sha256',
  value,
});

const caller: AttributedPrincipalV1 = {
  principalKind: 'operator',
  principalId: 'principal.cutover-operator',
  role: 'release-authority',
};
const authorization: AuthorizationSnapshotV1 = {
  authorizationId: 'authz-1',
  posture: 'shared-mutating',
  capabilityIds: ['capability.enable-enforcement'],
  resolverVersion: '1.0',
  resolvedAt: AT,
};
const provenance: ShadowProvenance = { caller, authorization };

const policy: CutoverPolicyRef = {
  policyId: 'policy-1',
  policyVersion: '1.0',
  policyDigest: digest(),
  inputDigest: digest(SHA_B),
};

function attempt(phaseKind: PhaseKind = 'IMPLEMENT'): ShadowDecisionRecord['attempt'] {
  return { workflowType: 'feature', fromPhase: 'a', toPhase: 'b', phaseKind };
}

function agreeRecord(): ShadowDecisionRecord {
  return {
    attempt: attempt(),
    legacyOutcome: 'allow',
    admission: { status: 'evaluated', verdict: 'allow' },
    disagreementClass: 'agree',
    disposition: 'agree',
    explained: true,
    reason: 'agree',
  };
}

function explainedDisagreement(): ShadowDecisionRecord {
  return {
    attempt: attempt(),
    legacyOutcome: 'allow',
    admission: { status: 'evaluated', verdict: 'deny' },
    disagreementClass: 'legacy-allow-admission-deny',
    disposition: 'explained-legacy',
    explained: true,
    reason: 'legacy defect (P06-01 DR-1)',
  };
}

function unexplainedDisagreement(): ShadowDecisionRecord {
  return {
    attempt: attempt(),
    legacyOutcome: 'deny',
    admission: { status: 'evaluated', verdict: 'allow' },
    disagreementClass: 'legacy-deny-admission-allow',
    disposition: 'unexplained',
    explained: false,
    reason: 'unexplained',
  };
}

/**
 * Live attempts that cover every phase kind and both outcomes, padded to the
 * threshold. Each attempt carries a disagreement class, which the shadow runner
 * assigns in production. Only a comparable class counts as coverage.
 */
function fullLiveCoverage(): LiveShadowAttempt[] {
  const attempts: LiveShadowAttempt[] = [];
  for (const phaseKind of ALL_PHASE_KINDS) {
    attempts.push({ phaseKind, outcome: 'allow', disagreementClass: 'agree' });
    attempts.push({
      phaseKind,
      outcome: 'deny',
      disagreementClass: 'legacy-deny-admission-allow',
    });
  }
  while (attempts.length < MINIMUM_LIVE_ATTEMPTS) {
    attempts.push({
      phaseKind: 'IMPLEMENT',
      outcome: 'allow',
      disagreementClass: 'agree',
    });
  }
  return attempts;
}

/** Durable sidecar facts mirroring {@link fullLiveCoverage}. */
function fullDurableCoverage(): DurableShadowAttemptFact[] {
  return fullLiveCoverage().map((a) => ({
    legacyOutcome: a.outcome,
    disagreementClass: a.disagreementClass,
  }));
}

/** A health reading from an observer that watched and landed its evidence. */
function healthyObserver(): LiveShadowHealth {
  const attempts = fullLiveCoverage().length;
  return {
    ...ZERO_LIVE_SHADOW_HEALTH,
    attemptsObserved: attempts,
    appendsScheduled: attempts,
    appendsSucceeded: attempts,
  };
}

/** A fully green evidence set — every condition met. */
function satisfiedEvidence(): CutoverGateEvidence {
  return {
    corpusRecords: [
      agreeRecord(),
      explainedDisagreement(),
      explainedDisagreement(),
    ],
    liveAttempts: fullLiveCoverage(),
    durableAttempts: fullDurableCoverage(),
    observerHealth: healthyObserver(),
  };
}

describe('CutoverGate_Blocking (P07-01 exit-proofs b–e)', () => {
  it('a fully satisfied gate is satisfied with no unmet conditions', () => {
    const report = evaluateCutoverGate(satisfiedEvidence());
    expect(report.satisfied).toBe(true);
    expect(report.unmet).toEqual([]);
    expect(report.conditions.every((c) => c.met)).toBe(true);
  });

  it('(b) an UNEXPLAINED disagreement blocks — only that condition is unmet', () => {
    const evidence: CutoverGateEvidence = {
      ...satisfiedEvidence(),
      corpusRecords: [
        agreeRecord(),
        explainedDisagreement(),
        unexplainedDisagreement(),
      ],
    };
    const report = evaluateCutoverGate(evidence);
    expect(report.satisfied).toBe(false);
    expect(report.unmet).toEqual(['deterministic-corpus-clean']);
    expect(report.unexplainedDisagreements).toBe(1);
  });

  it('(b) explained disagreements alone do NOT block', () => {
    const evidence: CutoverGateEvidence = {
      ...satisfiedEvidence(),
      corpusRecords: [explainedDisagreement(), explainedDisagreement()],
    };
    const report = evaluateCutoverGate(evidence);
    expect(report.unexplainedDisagreements).toBe(0);
    expect(
      report.conditions.find((c) => c.id === 'deterministic-corpus-clean')?.met,
    ).toBe(true);
    expect(report.satisfied).toBe(true);
  });

  /** The slice can drop a phase kind or an outcome, so the test checks only that the threshold is unmet. */
  it('(c) fewer than 20 live attempts blocks', () => {
    const short = fullLiveCoverage().slice(0, MINIMUM_LIVE_ATTEMPTS - 1);
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      liveAttempts: short,
    });
    expect(report.satisfied).toBe(false);
    expect(report.liveAttemptCount).toBe(MINIMUM_LIVE_ATTEMPTS - 1);
    expect(report.unmet).toContain('live-attempt-threshold');
  });

  it('(c) exactly 20 live attempts meets the threshold', () => {
    const report = evaluateCutoverGate(satisfiedEvidence());
    expect(report.liveAttemptCount).toBeGreaterThanOrEqual(MINIMUM_LIVE_ATTEMPTS);
    expect(
      report.conditions.find((c) => c.id === 'live-attempt-threshold')?.met,
    ).toBe(true);
  });

  /** The test pads the attempts back to the threshold, so the threshold stays met. */
  it('(d) a missing phase kind blocks — and names the missing kind', () => {
    const withoutMerge = fullLiveCoverage().filter(
      (a) => a.phaseKind !== 'MERGE',
    );
    while (withoutMerge.length < MINIMUM_LIVE_ATTEMPTS) {
      withoutMerge.push({
        phaseKind: 'IMPLEMENT',
        outcome: 'allow',
        disagreementClass: 'agree',
      });
    }
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      liveAttempts: withoutMerge,
    });
    expect(report.satisfied).toBe(false);
    expect(report.unmet).toContain('phase-kind-coverage');
    expect(report.missingPhaseKinds).toEqual(['MERGE']);
  });

  it('(e) all-allow coverage blocks (deny path unproven)', () => {
    const allAllow: LiveShadowAttempt[] = ALL_PHASE_KINDS.flatMap((phaseKind) =>
      Array.from({ length: 4 }, () => ({
        phaseKind,
        outcome: 'allow' as const,
        disagreementClass: 'agree' as const,
      })),
    );
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      liveAttempts: allAllow,
    });
    expect(report.satisfied).toBe(false);
    expect(report.unmet).toContain('outcome-coverage');
    expect(report.hasAllowOutcome).toBe(true);
    expect(report.hasDenyOutcome).toBe(false);
  });

  it('(e) all-deny coverage blocks (allow path unproven)', () => {
    const allDeny: LiveShadowAttempt[] = ALL_PHASE_KINDS.flatMap((phaseKind) =>
      Array.from({ length: 4 }, () => ({
        phaseKind,
        outcome: 'deny' as const,
        disagreementClass: 'agree' as const,
      })),
    );
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      liveAttempts: allDeny,
    });
    expect(report.satisfied).toBe(false);
    expect(report.unmet).toContain('outcome-coverage');
    expect(report.hasDenyOutcome).toBe(true);
    expect(report.hasAllowOutcome).toBe(false);
  });

  /** With no durable evidence and a zero-health observer, the class and observer conditions also fail. */
  it('reports MULTIPLE unmet conditions at once', () => {
    const report = evaluateCutoverGate({
      corpusRecords: [unexplainedDisagreement()],
      liveAttempts: [
        { phaseKind: 'PLAN', outcome: 'allow', disagreementClass: 'agree' },
      ],
      durableAttempts: [],
      observerHealth: ZERO_LIVE_SHADOW_HEALTH,
    });
    expect(report.satisfied).toBe(false);
    expect(new Set(report.unmet)).toEqual(
      new Set([
        'deterministic-corpus-clean',
        'live-attempt-threshold',
        'phase-kind-coverage',
        'outcome-coverage',
        'live-disagreement-class',
        'live-observer-health',
      ]),
    );
  });
});

describe('CutoverGate_EnforcementEnablement (P07-01 exit-proof f)', () => {
  it('(f) a satisfied gate approves enforcement and records an enablement fact', () => {
    const report = evaluateCutoverGate(satisfiedEvidence());
    expect(report.satisfied).toBe(true);
    expect(decideRollout(report)).toBe('approve-enforcement');

    const rollout = toRolloutDecisionData({
      report,
      rolloutDecisionId: 'ro-1',
      operationId: 'op-1',
      policy,
      evidenceIds: [],
      shadowEvidenceDigest: digest(SHA_B),
      decidedAt: AT,
      provenance,
    });
    expect(rollout.outcome).toBe('approve-enforcement');

    const enablement = toEnforcementEnabledData({
      report,
      enablementId: 'en-1',
      operationId: 'op-1',
      rolloutDecisionId: 'ro-1',
      policy,
      enabledAt: AT,
      provenance,
    });
    expect(enablement.rolloutDecisionId).toBe('ro-1');
    expect(enablement.enablementId).toBe('en-1');
  });

  it('an unsatisfied gate records continue-shadow, not approval', () => {
    const report = evaluateCutoverGate({
      corpusRecords: [unexplainedDisagreement()],
      liveAttempts: fullLiveCoverage(),
      durableAttempts: fullDurableCoverage(),
      observerHealth: healthyObserver(),
    });
    expect(report.satisfied).toBe(false);
    expect(decideRollout(report)).toBe('continue-shadow');

    const rollout = toRolloutDecisionData({
      report,
      rolloutDecisionId: 'ro-2',
      operationId: 'op-2',
      policy,
      evidenceIds: [],
      shadowEvidenceDigest: digest(SHA_B),
      decidedAt: AT,
      provenance,
    });
    expect(rollout.outcome).toBe('continue-shadow');
  });

  it('enforcement enablement CANNOT be event-sourced past an unsatisfied gate', () => {
    const report = evaluateCutoverGate({
      corpusRecords: [unexplainedDisagreement()],
      liveAttempts: [],
      durableAttempts: [],
      observerHealth: ZERO_LIVE_SHADOW_HEALTH,
    });
    expect(() =>
      toEnforcementEnabledData({
        report,
        enablementId: 'en-x',
        operationId: 'op-x',
        rolloutDecisionId: 'ro-x',
        policy,
        enabledAt: AT,
        provenance,
      }),
    ).toThrow(CutoverGateNotSatisfiedError);
  });
});

describe('CutoverGate_PhaseKinds', () => {
  it('covers all six phase kinds', () => {
    expect([...ALL_PHASE_KINDS].sort()).toEqual(
      ['GATHER', 'IMPLEMENT', 'MERGE', 'PLAN', 'REVIEW', 'SYNTHESIZE'].sort(),
    );
  });
});

/**
 * Tests for the `live-disagreement-class` condition with hand-written attempts.
 * The end-to-end proof, with attempts whose adjudication really throws, is in
 * `live-shadow-observer.test.ts`.
 */
describe('CutoverGate_DisagreementClass (DR-23 bullet 2)', () => {
  /** `shadow-error` has no verdict and `admission-indeterminate` has no answer, so neither is a comparison. */
  it('classifies which classes may be spent as coverage', () => {
    expect(isComparableShadowClass('agree')).toBe(true);
    expect(isComparableShadowClass('legacy-allow-admission-deny')).toBe(true);
    expect(isComparableShadowClass('legacy-deny-admission-allow')).toBe(true);
    expect(isComparableShadowClass('shadow-error')).toBe(false);
    expect(isComparableShadowClass('admission-indeterminate')).toBe(false);
  });

  /** The adjudication of one extra attempt threw. The other attempts still meet coverage and the threshold. */
  it('a single non-comparable live attempt blocks — and ONLY that condition', () => {
    const attempts = fullLiveCoverage();
    attempts.push({
      phaseKind: 'IMPLEMENT',
      outcome: 'allow',
      disagreementClass: 'shadow-error',
    });
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      liveAttempts: attempts,
    });
    expect(report.unmet).toEqual(['live-disagreement-class']);
    expect(report.nonComparableLiveAttemptCount).toBe(1);
    expect(report.liveDisagreementClasses['shadow-error']).toBe(1);
  });

  it('non-comparable attempts are not counted towards the threshold or coverage', () => {
    const errored: LiveShadowAttempt[] = fullLiveCoverage().map((a) => ({
      ...a,
      disagreementClass: 'shadow-error' as const,
    }));
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      liveAttempts: errored,
      durableAttempts: errored.map((a) => ({
        legacyOutcome: a.outcome,
        disagreementClass: 'admission-indeterminate' as const,
      })),
    });
    expect(report.liveAttemptCount).toBeGreaterThanOrEqual(MINIMUM_LIVE_ATTEMPTS);
    expect(report.comparableLiveAttemptCount).toBe(0);
    expect(report.missingPhaseKinds).toEqual([...ALL_PHASE_KINDS]);
    expect(report.hasAllowOutcome).toBe(false);
    expect(report.hasDenyOutcome).toBe(false);
    expect(new Set(report.unmet)).toEqual(
      new Set([
        'live-attempt-threshold',
        'phase-kind-coverage',
        'outcome-coverage',
        'live-disagreement-class',
      ]),
    );
  });

  it('an EMPTY durable substrate blocks even when memory looks perfect', () => {
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      durableAttempts: [],
    });
    expect(report.unmet).toEqual(['live-disagreement-class']);
    expect(
      report.conditions.find((c) => c.id === 'live-disagreement-class')?.detail,
    ).toContain('never ran');
  });

  it('a non-comparable DURABLE fact blocks even when the in-memory attempts are clean', () => {
    const durable = fullDurableCoverage();
    durable.push({
      legacyOutcome: 'allow',
      disagreementClass: 'admission-indeterminate',
    });
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      durableAttempts: durable,
    });
    expect(report.unmet).toEqual(['live-disagreement-class']);
    expect(report.nonComparableDurableAttemptCount).toBe(1);
  });
});

describe('CutoverGate_ObserverHealth (DR-23 bullet 3)', () => {
  it('a DEAD observer blocks — observed attempts, nothing durable landed', () => {
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      observerHealth: {
        ...ZERO_LIVE_SHADOW_HEALTH,
        attemptsObserved: 20,
        appendsScheduled: 20,
        appendsFailed: 20,
      },
    });
    expect(report.observerStatus).toBe('dead');
    expect(report.unmet).toEqual(['live-observer-health']);
  });

  it('a LOSSY observer blocks — some evidence landed, some was dropped', () => {
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      observerHealth: {
        ...healthyObserver(),
        appendsFailed: 3,
      },
    });
    expect(report.observerStatus).toBe('degraded');
    expect(report.unmet).toEqual(['live-observer-health']);
  });

  it('an observer that never watched is UNOBSERVED, not healthy', () => {
    const report = evaluateCutoverGate({
      ...satisfiedEvidence(),
      observerHealth: ZERO_LIVE_SHADOW_HEALTH,
    });
    expect(report.observerStatus).toBe('unobserved');
    expect(report.unmet).toEqual(['live-observer-health']);
  });
});

describe('CutoverGate_DurableReader (DR-23 — INV-1 substrate)', () => {
  function shadowEvent(
    legacyOutcome: 'allow' | 'deny',
    outcome: 'allow' | 'deny' | 'indeterminate',
  ): { type: string; data: unknown } {
    const base = {
      eventVersion: '1.0',
      shadowAttemptId: 'shadow-attempt:1',
      operationId: 'op-1',
      phaseAttemptId: 'pa-1',
      legacyOutcome,
      subject: { kind: 'phase-attempt', phaseAttemptId: 'pa-1', digest: digest() },
      evidenceSetDigest: digest(),
      decision: {
        contractVersion: '1.0',
        decisionId: 'shadow-decision:1',
        operationId: 'op-1',
        phaseAttemptId: 'pa-1',
        policyId: 'policy.legacy-state-translation',
        policyVersion: '1.0',
        policyDigest: digest(),
        requirementSetDigest: digest(),
        inputDigest: digest(),
        evidenceIds: [],
        waiverIds: [],
        decidedAt: AT,
        ...(outcome === 'allow'
          ? { outcome, satisfiedRequirementIds: [], waivedRequirementIds: [] }
          : outcome === 'deny'
            ? {
                outcome,
                satisfiedRequirementIds: [],
                unsatisfiedRequirements: [
                  { requirementId: 'route:x', reason: 'failed' },
                ],
                remediation: [
                  { action: 'retry_transition', phaseAttemptId: 'pa-1' },
                ],
              }
            : {
                outcome,
                unresolvedRequirementIds: ['route:x'],
                errors: [{ code: 'EVALUATOR_FAILED', message: 'threw' }],
                remediation: [
                  { action: 'retry_transition', phaseAttemptId: 'pa-1' },
                ],
              }),
      },
      attemptedAt: AT,
      caller,
      authorization,
    };
    return { type: 'admission.shadow-attempt', data: base };
  }

  it('reads the SIDECAR stream and derives the class from the persisted pair', async () => {
    const seen: string[] = [];
    const reader = {
      async query(streamId: string) {
        seen.push(streamId);
        return [
          shadowEvent('allow', 'allow'),
          shadowEvent('allow', 'deny'),
          shadowEvent('deny', 'indeterminate'),
        ];
      },
    };
    const facts = await readDurableShadowAttempts(reader, ['feat-1']);

    expect(seen).toEqual([liveShadowEvidenceStreamId('feat-1')]);
    expect(seen[0]).not.toBe('feat-1');
    expect(facts.map((f) => f.disagreementClass)).toEqual([
      'agree',
      'legacy-allow-admission-deny',
      'admission-indeterminate',
    ]);
  });

  it('DROPS an unreadable event rather than defaulting it to `agree`', async () => {
    const reader = {
      async query() {
        return [
          shadowEvent('allow', 'allow'),
          { type: 'admission.shadow-attempt', data: { nonsense: true } },
        ];
      },
    };
    const facts: readonly DurableShadowAttemptFact[] =
      await readDurableShadowAttempts(reader, ['feat-1']);
    expect(facts.length).toBe(1);
    expect(facts[0]?.disagreementClass).toBe('agree');
  });
});
