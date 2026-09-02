/**
 * P06-04 exit-proof tests — Policy and waiver evaluation.
 *
 * Proves, independently:
 *   - missing / stale / contradictory / malformed / unauthorized / failed
 *     evidence each DENIES;
 *   - an indeterminate gate produces the first-class `indeterminate` verdict,
 *     distinct from deny, and a waiver never rescues it;
 *   - a waiver scoped to subject A does NOT waive subject B;
 *   - a waiver scoped to requirement R1 does NOT waive R2;
 *   - an expired waiver does not apply;
 *   - an unauthorized waiver does not apply;
 *   - a non-waivable obligation set refuses every waiver;
 *   - a VALID waiver permits admission WHILE the failed evidence stays recorded
 *     and reported (the load-bearing "no rewrite of failed evidence" invariant).
 */
import { describe, expect, it } from 'vitest';
import {
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  WaiverProvenanceV1Schema,
  type AdmissionEvidenceV1,
  type AdmissionRequirementV1,
  type WaiverProvenanceV1,
} from '../../../../src/workflow/admission/types.js';
import type { ResolvedRequirements } from '../../../../src/workflow/admission/requirement-strength.js';
import type { EvidenceContradiction } from '../../../../src/workflow/admission/select-evidence.js';
import {
  createCapabilityAuthority,
  POLICY_CAPABILITY,
  type PolicyAuthority,
} from '../../../../src/workflow/admission/policy-authority.js';
import { evaluatePolicy, type PolicyEvaluationInput } from '../../../../src/workflow/admission/policy-evaluation.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const EVAL_AT = '2026-07-21T20:00:00.000Z';
const FRESH_AT = '2026-07-21T19:45:00.000Z'; // 15 min before eval
const STALE_AT = '2026-07-21T10:00:00.000Z'; // 10 h before eval
const EXPIRES_FUTURE = '2026-07-22T20:00:00.000Z';
const EXPIRES_PAST = '2026-07-21T19:00:00.000Z';
const HORIZON_MS = 60 * 60 * 1000; // 1 hour

const digest = (value = SHA_A) => ({ algorithm: 'sha256' as const, value });
const taskSubject = (taskId = 'task-1', value = SHA_A) => ({
  kind: 'task' as const,
  taskId,
  digest: digest(value),
});

const GATE_PRODUCER = 'producer.gate-runner';
const APPROVER = 'principal.approver';
const WAIVER_GRANTOR = 'principal.release-authority';

const authority: PolicyAuthority = createCapabilityAuthority([
  { principalId: GATE_PRODUCER, capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
  { principalId: APPROVER, capabilities: [POLICY_CAPABILITY.ISSUE_APPROVAL] },
  { principalId: WAIVER_GRANTOR, capabilities: [POLICY_CAPABILITY.GRANT_WAIVER] },
]);

const WAIVABLE: ResolvedRequirements = {
  gates: [],
  minimumApprovals: 0,
  minimumCorroboratingSources: 0,
  waivable: true,
};
const NOT_WAIVABLE: ResolvedRequirements = { ...WAIVABLE, waivable: false };

interface GateOpts {
  readonly evidenceId: string;
  readonly requirementId?: string;
  readonly phaseAttemptId?: string;
  readonly subject?: unknown;
  readonly producerId?: string;
  readonly verdict?: 'pass' | 'fail' | 'indeterminate';
  readonly createdAt?: string;
}

function gate(opts: GateOpts): AdmissionEvidenceV1 {
  return AdmissionEvidenceV1Schema.parse({
    contractVersion: '1.0',
    evidenceId: opts.evidenceId,
    requirementId: opts.requirementId ?? 'req-gate',
    phaseAttemptId: opts.phaseAttemptId ?? 'pa-1',
    subject: opts.subject ?? taskSubject(),
    producer: {
      producerId: opts.producerId ?? GATE_PRODUCER,
      providerRef: 'provider.static-analysis',
      providerVersion: '1.0',
      invocationId: 'inv-1',
    },
    policyId: 'policy-1',
    policyDigest: digest(),
    contentDigest: digest(SHA_B),
    createdAt: opts.createdAt ?? FRESH_AT,
    kind: 'gate',
    verdict: opts.verdict ?? 'pass',
  });
}

interface ApprovalOpts {
  readonly evidenceId: string;
  readonly requirementId?: string;
  readonly subject?: unknown;
  readonly principalId?: string;
  readonly verdict?: 'approved' | 'rejected';
  readonly createdAt?: string;
}

function approval(opts: ApprovalOpts): AdmissionEvidenceV1 {
  return AdmissionEvidenceV1Schema.parse({
    contractVersion: '1.0',
    evidenceId: opts.evidenceId,
    requirementId: opts.requirementId ?? 'req-approval',
    phaseAttemptId: 'pa-1',
    subject: opts.subject ?? taskSubject(),
    producer: {
      producerId: 'producer.approval-desk',
      providerRef: 'provider.approval',
      providerVersion: '1.0',
      invocationId: 'inv-approval',
    },
    policyId: 'policy-1',
    policyDigest: digest(),
    contentDigest: digest(SHA_C),
    createdAt: opts.createdAt ?? FRESH_AT,
    kind: 'approval',
    verdict: opts.verdict ?? 'approved',
    attributedTo: {
      principalKind: 'operator',
      principalId: opts.principalId ?? APPROVER,
      role: 'release-approver',
    },
  });
}

function gateRequirement(
  requirementId = 'req-gate',
  subject: unknown = taskSubject(),
): AdmissionRequirementV1 {
  return AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId,
    phaseAttemptId: 'pa-1',
    subject,
    kind: 'gate-evidence',
    gateId: 'gate.static-analysis',
  });
}

function approvalRequirement(minimumApprovals = 1): AdmissionRequirementV1 {
  return AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId: 'req-approval',
    phaseAttemptId: 'pa-1',
    subject: taskSubject(),
    kind: 'approval',
    approvalClass: 'release',
    minimumApprovals,
  });
}

interface WaiverOpts {
  readonly waiverId?: string;
  readonly actorId?: string;
  readonly scope?: unknown;
  readonly expiresAt?: string;
  readonly waivedRequirementIds?: readonly string[];
}

function issuedWaiver(opts: WaiverOpts = {}): WaiverProvenanceV1 {
  return WaiverProvenanceV1Schema.parse({
    contractVersion: '1.0',
    waiverId: opts.waiverId ?? 'waiver-1',
    actor: {
      principalKind: 'operator',
      principalId: opts.actorId ?? WAIVER_GRANTOR,
      role: 'release-authority',
    },
    authorization: {
      authorizationId: 'authz-1',
      posture: 'shared-mutating',
      capabilityIds: ['capability.issue-waiver'],
      resolverVersion: '1.0',
      resolvedAt: EVAL_AT,
    },
    recordedAt: EVAL_AT,
    event: 'issued',
    rationale: 'time-bounded exception',
    scope: opts.scope ?? { kind: 'subject', subject: taskSubject() },
    subjectDigest: digest(),
    expiresAt: opts.expiresAt ?? EXPIRES_FUTURE,
    waivedRequirementIds: opts.waivedRequirementIds ?? ['req-gate'],
    policyId: 'policy-1',
    policyDigest: digest(SHA_B),
  });
}

function activeContradiction(
  requirementId: string,
  evidenceIds: readonly string[],
): EvidenceContradiction {
  return {
    source: 'active-evidence',
    requirementId,
    phaseAttemptId: 'pa-1',
    subject: taskSubject(),
    policyDigest: digest(),
    evidenceIds,
    statements: ['satisfied', 'unsatisfied'],
  } as EvidenceContradiction;
}

function baseInput(
  overrides: Partial<PolicyEvaluationInput>,
): PolicyEvaluationInput {
  return {
    requirements: [gateRequirement()],
    obligations: WAIVABLE,
    activeEvidence: [],
    authority,
    evaluatedAt: EVAL_AT,
    freshnessHorizonMs: HORIZON_MS,
    ...overrides,
  };
}

// ─── Baseline: a passing, fresh, authorized gate allows ──────────────────────

describe('PolicyEvaluation baseline', () => {
  it('PolicyEvaluation_PassingGate_Allows', () => {
    const result = evaluatePolicy(
      baseInput({ activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'pass' })] }),
    );
    expect(result.verdict).toBe('allow');
    expect(result.requirementEvaluations[0]?.status).toBe('satisfied');
    expect(result.recordedFailures).toHaveLength(0);
  });

  it('PolicyEvaluation_NoRequirements_AllowsVacuously', () => {
    const result = evaluatePolicy(baseInput({ requirements: [] }));
    expect(result.verdict).toBe('allow');
    expect(result.requirementEvaluations).toHaveLength(0);
  });
});

// ─── Every unsound input denies ──────────────────────────────────────────────

describe('PolicyEvaluation denies on unsound evidence', () => {
  it('PolicyEvaluation_MissingEvidence_Denies', () => {
    const result = evaluatePolicy(baseInput({ activeEvidence: [] }));
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status).toBe('denied');
    expect(disposition?.status === 'denied' && disposition.reason).toBe('missing');
  });

  it('PolicyEvaluation_StaleEvidence_Denies', () => {
    // A PASSING gate that is simply too old must not admit.
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'pass', createdAt: STALE_AT })],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('stale');
  });

  it('PolicyEvaluation_ContradictoryEvidence_Denies', () => {
    // Two passing gates that the selector flagged as contradictory: deny.
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [
          gate({ evidenceId: 'ev-1', verdict: 'pass' }),
          gate({ evidenceId: 'ev-2', verdict: 'pass' }),
        ],
        contradictions: [activeContradiction('req-gate', ['ev-1', 'ev-2'])],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('contradictory');
  });

  it('PolicyEvaluation_MalformedEvidence_Denies', () => {
    // Evidence tagged with the requirement id but bound to a DIFFERENT subject.
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [
          gate({ evidenceId: 'ev-1', verdict: 'pass', subject: taskSubject('task-OTHER') }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('malformed');
  });

  it('PolicyEvaluation_BadDigestEvidence_Denies', () => {
    // Same subject kind + id, but a different content digest is a malformed match.
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [
          gate({ evidenceId: 'ev-1', verdict: 'pass', subject: taskSubject('task-1', SHA_C) }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('malformed');
  });

  it('PolicyEvaluation_UnauthorizedIssuer_Denies', () => {
    // A passing, fresh, well-formed gate from a producer with NO capability.
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [
          gate({ evidenceId: 'ev-1', verdict: 'pass', producerId: 'producer.rogue' }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('unauthorized');
  });

  it('PolicyEvaluation_FailedGate_Denies', () => {
    const result = evaluatePolicy(
      baseInput({ activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'fail' })] }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('failed');
  });
});

// ─── Indeterminate is a first-class, fail-closed verdict ─────────────────────

describe('PolicyEvaluation indeterminate', () => {
  it('PolicyEvaluation_IndeterminateGate_IsIndeterminate_NotDeny', () => {
    const result = evaluatePolicy(
      baseInput({ activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'indeterminate' })] }),
    );
    expect(result.verdict).toBe('indeterminate');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status).toBe('indeterminate');
    expect(disposition?.status === 'indeterminate' && disposition.code).toBe('EVALUATOR_FAILED');
  });

  it('PolicyEvaluation_DenyDominatesIndeterminate', () => {
    // One requirement missing (sound deny), one indeterminate: deny wins.
    const result = evaluatePolicy(
      baseInput({
        requirements: [gateRequirement('req-a'), gateRequirement('req-b')],
        activeEvidence: [
          gate({ evidenceId: 'ev-b', requirementId: 'req-b', verdict: 'indeterminate' }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
  });

  it('PolicyEvaluation_Waiver_DoesNotRescueIndeterminate', () => {
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'indeterminate' })],
        waivers: [issuedWaiver({ waivedRequirementIds: ['req-gate'] })],
      }),
    );
    expect(result.verdict).toBe('indeterminate');
    expect(result.appliedWaiverIds).toHaveLength(0);
  });
});

// ─── Waiver scoping ──────────────────────────────────────────────────────────

describe('PolicyEvaluation waiver scoping', () => {
  it('PolicyEvaluation_WaiverScopedToSubjectA_DoesNotWaiveSubjectB', () => {
    // Requirement + failed evidence on subject B; waiver scoped to subject A.
    const subjectB = taskSubject('task-B');
    const result = evaluatePolicy(
      baseInput({
        requirements: [gateRequirement('req-gate', subjectB)],
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'fail', subject: subjectB })],
        waivers: [
          issuedWaiver({
            scope: { kind: 'subject', subject: taskSubject('task-A') },
            waivedRequirementIds: ['req-gate'],
          }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
    expect(result.appliedWaiverIds).toHaveLength(0);
  });

  it('PolicyEvaluation_WaiverScopedToR1_DoesNotWaiveR2', () => {
    const subjectA = taskSubject('task-A');
    const subjectB = taskSubject('task-B');
    const result = evaluatePolicy(
      baseInput({
        requirements: [
          gateRequirement('req-1', subjectA),
          gateRequirement('req-2', subjectB),
        ],
        activeEvidence: [
          gate({ evidenceId: 'ev-1', requirementId: 'req-1', verdict: 'fail', subject: subjectA }),
          gate({ evidenceId: 'ev-2', requirementId: 'req-2', verdict: 'fail', subject: subjectB }),
        ],
        waivers: [
          issuedWaiver({
            scope: { kind: 'subject', subject: subjectA },
            waivedRequirementIds: ['req-1'],
          }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
    const byId = new Map(result.requirementEvaluations.map((e) => [e.requirementId, e]));
    expect(byId.get('req-1')?.status).toBe('waived');
    expect(byId.get('req-2')?.status).toBe('denied');
  });

  it('PolicyEvaluation_ExpiredWaiver_DoesNotApply', () => {
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'fail' })],
        waivers: [issuedWaiver({ expiresAt: EXPIRES_PAST })],
      }),
    );
    expect(result.verdict).toBe('deny');
    expect(result.appliedWaiverIds).toHaveLength(0);
  });

  it('PolicyEvaluation_UnauthorizedWaiver_DoesNotApply', () => {
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'fail' })],
        waivers: [issuedWaiver({ actorId: 'principal.impostor' })],
      }),
    );
    expect(result.verdict).toBe('deny');
    expect(result.appliedWaiverIds).toHaveLength(0);
  });

  it('PolicyEvaluation_NonWaivableObligations_RefuseEveryWaiver', () => {
    const result = evaluatePolicy(
      baseInput({
        obligations: NOT_WAIVABLE,
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'fail' })],
        waivers: [issuedWaiver()],
      }),
    );
    expect(result.verdict).toBe('deny');
    expect(result.appliedWaiverIds).toHaveLength(0);
  });
});

// ─── The load-bearing invariant: a waiver never rewrites failed evidence ─────

describe('PolicyEvaluation valid waiver preserves the failure', () => {
  it('PolicyEvaluation_ValidWaiver_Allows_WhileFailureStaysRecorded', () => {
    const result = evaluatePolicy(
      baseInput({
        activeEvidence: [gate({ evidenceId: 'ev-1', verdict: 'fail' })],
        waivers: [issuedWaiver({ waiverId: 'waiver-42', waivedRequirementIds: ['req-gate'] })],
      }),
    );

    // Admission is permitted…
    expect(result.verdict).toBe('allow');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status).toBe('waived');
    expect(disposition?.status === 'waived' && disposition.waiverId).toBe('waiver-42');

    // …but the failure it waived is STILL on record, not erased.
    expect(result.recordedFailures).toHaveLength(1);
    const failure = result.recordedFailures[0];
    expect(failure?.requirementId).toBe('req-gate');
    expect(failure?.reason).toBe('failed');
    expect(failure?.waived).toBe(true);
    expect(failure?.waiverId).toBe('waiver-42');
    expect(failure?.evidenceIds).toContain('ev-1');
    expect(result.appliedWaiverIds).toEqual(['waiver-42']);
  });
});

// ─── Approvals as typed, authorized artifacts ────────────────────────────────

describe('PolicyEvaluation approvals', () => {
  it('PolicyEvaluation_AuthorizedApproval_Satisfies', () => {
    const result = evaluatePolicy(
      baseInput({
        requirements: [approvalRequirement(1)],
        activeEvidence: [approval({ evidenceId: 'ap-1', verdict: 'approved' })],
      }),
    );
    expect(result.verdict).toBe('allow');
    expect(result.requirementEvaluations[0]?.status).toBe('satisfied');
  });

  it('PolicyEvaluation_UnauthorizedApprover_Denies', () => {
    const result = evaluatePolicy(
      baseInput({
        requirements: [approvalRequirement(1)],
        activeEvidence: [
          approval({ evidenceId: 'ap-1', verdict: 'approved', principalId: 'principal.stranger' }),
        ],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('unauthorized');
  });

  it('PolicyEvaluation_InsufficientApprovals_Denies', () => {
    const result = evaluatePolicy(
      baseInput({
        requirements: [approvalRequirement(2)],
        activeEvidence: [approval({ evidenceId: 'ap-1', verdict: 'approved' })],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('missing');
  });

  it('PolicyEvaluation_RejectedApproval_Denies', () => {
    const result = evaluatePolicy(
      baseInput({
        requirements: [approvalRequirement(1)],
        activeEvidence: [approval({ evidenceId: 'ap-1', verdict: 'rejected' })],
      }),
    );
    expect(result.verdict).toBe('deny');
    const disposition = result.requirementEvaluations[0];
    expect(disposition?.status === 'denied' && disposition.reason).toBe('failed');
  });
});
