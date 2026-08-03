// ─── P07-01 exit-proof tests — The cutover gate (Transition tasks 027, 051) ────
//
// Proves, independently, that enforcement flips ONLY behind four conditions:
//   (exit-proof b) an unexplained disagreement BLOCKS the gate;
//   (exit-proof c) fewer than 20 live attempts BLOCKS;
//   (exit-proof d) a missing phase kind BLOCKS;
//   (exit-proof e) all-allow or all-deny coverage BLOCKS;
//   (exit-proof f) a fully satisfied gate permits enforcement;
//   (event-sourced) enablement is a recorded decision — a satisfied gate yields
//                   an `approve-enforcement` rollout + an enforcement-enabled
//                   fact; an unsatisfied gate cannot be event-sourced past.

import { describe, expect, it } from 'vitest';

import type { PhaseKind } from '../phase-kind.js';
import type { ShadowDecisionRecord, ShadowProvenance } from './shadow-decision.js';
import type {
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  ContentDigestV1,
} from './types.js';
import {
  ALL_PHASE_KINDS,
  CutoverGateNotSatisfiedError,
  MINIMUM_LIVE_ATTEMPTS,
  decideRollout,
  evaluateCutoverGate,
  toEnforcementEnabledData,
  toRolloutDecisionData,
  type CutoverGateEvidence,
  type LiveShadowAttempt,
  type CutoverPolicyRef,
} from './cutover-gate.js';

// ─── Shared fixtures ───────────────────────────────────────────────────────────

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

// ── Shadow record factories ──

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

// ── Live-attempt builder: every phase kind, both outcomes, >= 20 total. ──

function fullLiveCoverage(): LiveShadowAttempt[] {
  const attempts: LiveShadowAttempt[] = [];
  for (const phaseKind of ALL_PHASE_KINDS) {
    attempts.push({ phaseKind, outcome: 'allow' });
    attempts.push({ phaseKind, outcome: 'deny' });
  }
  // Pad to the threshold while preserving coverage.
  while (attempts.length < MINIMUM_LIVE_ATTEMPTS) {
    attempts.push({ phaseKind: 'IMPLEMENT', outcome: 'allow' });
  }
  return attempts;
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
  };
}

// ─── The gate blocks on each condition independently ───────────────────────────

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

  it('(c) fewer than 20 live attempts blocks', () => {
    const short = fullLiveCoverage().slice(0, MINIMUM_LIVE_ATTEMPTS - 1);
    // slice may have dropped a phase kind / outcome; assert the threshold is
    // specifically among the unmet conditions.
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

  it('(d) a missing phase kind blocks — and names the missing kind', () => {
    const withoutMerge = fullLiveCoverage().filter(
      (a) => a.phaseKind !== 'MERGE',
    );
    // Keep the count at/over threshold so ONLY coverage is at fault.
    while (withoutMerge.length < MINIMUM_LIVE_ATTEMPTS) {
      withoutMerge.push({ phaseKind: 'IMPLEMENT', outcome: 'allow' });
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
      Array.from({ length: 4 }, () => ({ phaseKind, outcome: 'allow' as const })),
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
      Array.from({ length: 4 }, () => ({ phaseKind, outcome: 'deny' as const })),
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

  it('reports MULTIPLE unmet conditions at once', () => {
    const report = evaluateCutoverGate({
      corpusRecords: [unexplainedDisagreement()],
      liveAttempts: [{ phaseKind: 'PLAN', outcome: 'allow' }],
    });
    expect(report.satisfied).toBe(false);
    expect(new Set(report.unmet)).toEqual(
      new Set([
        'deterministic-corpus-clean',
        'live-attempt-threshold',
        'phase-kind-coverage',
        'outcome-coverage',
      ]),
    );
  });
});

// ─── Event-sourced enforcement enablement (exit-proof f + plan Wave E) ─────────

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

// ─── Phase-kind universe is complete ───────────────────────────────────────────

describe('CutoverGate_PhaseKinds', () => {
  it('covers all six phase kinds', () => {
    expect([...ALL_PHASE_KINDS].sort()).toEqual(
      ['GATHER', 'IMPLEMENT', 'MERGE', 'PLAN', 'REVIEW', 'SYNTHESIZE'].sort(),
    );
  });
});
