import { describe, expect, it } from 'vitest';
import {
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  AdmissionDecisionRecordV1Schema,
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  EvidenceSubjectV1Schema,
  RemediationActionV1Schema,
  RequirementIdSchema,
  UnsatisfiedRequirementReasonSchema,
  WaiverProvenanceV1Schema,
  isAdmissionDecisionRecordV1,
  parseAdmissionDecisionRecordV1,
} from '../../../../src/workflow/admission/types.js';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const AT = '2026-07-21T19:00:00.000Z';

const digest = (value = SHA256_A) => ({ algorithm: 'sha256', value });

const subject = {
  kind: 'task',
  taskId: 'task-002',
  digest: digest(),
} as const;

const producer = {
  producerId: 'producer.gate-runner',
  providerRef: 'provider.static-analysis',
  providerVersion: '1.3.0',
  invocationId: 'invocation-001',
} as const;

const decisionBase = {
  contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
  decisionId: 'decision-001',
  operationId: 'operation-001',
  phaseAttemptId: 'phase-attempt-001',
  policyId: 'policy-001',
  policyVersion: '1.0',
  policyDigest: digest(),
  requirementSetDigest: digest(SHA256_B),
  inputDigest: digest(),
  evidenceIds: ['evidence-001'],
  waiverIds: [],
  decidedAt: AT,
} as const;

const remediation = {
  action: 'run_gate',
  requirementId: 'requirement-001',
  gateId: 'gate.static-analysis',
} as const;

describe('admission runtime domain', () => {
  it('AdmissionDomain_InvalidOutcome_IsRejected', () => {
    const invalidMixedOutcomes: readonly unknown[] = [
      {
        ...decisionBase,
        outcome: 'allow',
        satisfiedRequirementIds: ['requirement-001'],
        waivedRequirementIds: [],
        // A denial-only field must not be accepted on an allow record.
        unsatisfiedRequirements: [
          { requirementId: 'requirement-002', reason: 'failed' },
        ],
      },
      {
        ...decisionBase,
        outcome: 'deny',
        satisfiedRequirementIds: [],
        unsatisfiedRequirements: [
          { requirementId: 'requirement-001', reason: 'missing' },
        ],
        remediation: [remediation],
        // An indeterminate-only field must not be accepted on a deny record.
        errors: [{ code: 'EVALUATOR_FAILED', message: 'provider did not answer' }],
      },
      {
        ...decisionBase,
        outcome: 'indeterminate',
        unresolvedRequirementIds: ['requirement-001'],
        errors: [{ code: 'EVIDENCE_MALFORMED', message: 'digest is invalid' }],
        remediation: [remediation],
        // A deny-only field must not be accepted on an indeterminate record.
        unsatisfiedRequirements: [
          { requirementId: 'requirement-001', reason: 'malformed' },
        ],
      },
      {
        ...decisionBase,
        outcome: 'allow',
        satisfiedRequirementIds: ['requirement-001'],
        waivedRequirementIds: [],
        outcomeDetail: 'deny',
      },
    ];

    for (const candidate of invalidMixedOutcomes) {
      expect(AdmissionDecisionRecordV1Schema.safeParse(candidate).success).toBe(false);
      expect(isAdmissionDecisionRecordV1(candidate)).toBe(false);
      expect(() => parseAdmissionDecisionRecordV1(candidate)).toThrow();
    }

  });

  it('AdmissionDomain_DecisionOutcomes_AreExhaustiveAndImmutable', () => {
    const validOutcomes: readonly unknown[] = [
      {
        ...decisionBase,
        outcome: 'allow',
        satisfiedRequirementIds: ['requirement-001'],
        waivedRequirementIds: [],
      },
      {
        ...decisionBase,
        outcome: 'deny',
        satisfiedRequirementIds: [],
        unsatisfiedRequirements: [
          { requirementId: 'requirement-001', reason: 'contradictory' },
        ],
        remediation: [remediation],
      },
      {
        ...decisionBase,
        outcome: 'indeterminate',
        unresolvedRequirementIds: ['requirement-001'],
        errors: [{ code: 'POLICY_UNAVAILABLE', message: 'policy is unavailable' }],
        remediation: [{ action: 'retry_transition', phaseAttemptId: 'phase-attempt-001' }],
      },
    ];

    expect(
      validOutcomes.map((candidate) => parseAdmissionDecisionRecordV1(candidate).outcome),
    ).toEqual(['allow', 'deny', 'indeterminate']);

    const parsed = parseAdmissionDecisionRecordV1(validOutcomes[0]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.evidenceIds)).toBe(true);
  });

  it('AdmissionDomain_StableIds_RejectBlankOrUnstableValues', () => {
    expect(RequirementIdSchema.safeParse('requirement.review-01').success).toBe(true);

    for (const invalid of ['', '  ', 'requirement with spaces', '../requirement']) {
      expect(RequirementIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('AdmissionDomain_EvidenceSubjects_CoverEveryImmutableSubjectKind', () => {
    const subjects: readonly unknown[] = [
      { kind: 'workflow', workflowId: 'workflow-001', digest: digest() },
      {
        kind: 'phase-attempt',
        phaseAttemptId: 'phase-attempt-001',
        digest: digest(),
      },
      { kind: 'wave', waveId: 'wave-001', digest: digest() },
      subject,
      { kind: 'commit', commitId: 'commit-001', digest: digest() },
      { kind: 'diff', diffId: 'diff-001', digest: digest() },
      { kind: 'artifact', artifactId: 'artifact-001', digest: digest() },
    ];

    expect(
      subjects.map((candidate) => EvidenceSubjectV1Schema.parse(candidate).kind),
    ).toEqual([
      'workflow',
      'phase-attempt',
      'wave',
      'task',
      'commit',
      'diff',
      'artifact',
    ]);
    expect(
      EvidenceSubjectV1Schema.safeParse({
        kind: 'task',
        taskId: 'task-002',
        digest: { algorithm: 'md5', value: SHA256_A },
      }).success,
    ).toBe(false);
  });

  it('AdmissionDomain_RequirementsAndEvidence_AreClosedVersionedUnions', () => {
    const requirements: readonly unknown[] = [
      {
        contractVersion: '1.0',
        kind: 'gate-evidence',
        requirementId: 'requirement-gate',
        phaseAttemptId: 'phase-attempt-001',
        subject,
        gateId: 'gate.static-analysis',
      },
      {
        contractVersion: '1.0',
        kind: 'approval',
        requirementId: 'requirement-approval',
        phaseAttemptId: 'phase-attempt-001',
        subject,
        approvalClass: 'approval.security',
        minimumApprovals: 2,
      },
      {
        contractVersion: '1.0',
        kind: 'corroboration',
        requirementId: 'requirement-corroboration',
        phaseAttemptId: 'phase-attempt-001',
        subject,
        sourceRequirementId: 'requirement-gate',
        minimumIndependentSources: 2,
      },
    ];

    expect(
      requirements.map((candidate) => AdmissionRequirementV1Schema.parse(candidate).kind),
    ).toEqual(['gate-evidence', 'approval', 'corroboration']);

    const evidenceBase = {
      contractVersion: '1.0',
      evidenceId: 'evidence-001',
      requirementId: 'requirement-gate',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      producer,
      policyId: 'policy-001',
      policyDigest: digest(),
      contentDigest: digest(SHA256_B),
      createdAt: AT,
    } as const;

    const gateEvidence = { ...evidenceBase, kind: 'gate', verdict: 'pass' } as const;
    const evidence: readonly unknown[] = [
      gateEvidence,
      {
        ...evidenceBase,
        kind: 'approval',
        verdict: 'approved',
        attributedTo: {
          principalKind: 'operator',
          principalId: 'principal-001',
          role: 'reviewer',
        },
      },
    ];

    expect(
      evidence.map((candidate) => AdmissionEvidenceV1Schema.parse(candidate).kind),
    ).toEqual(['gate', 'approval']);
    expect(
      AdmissionEvidenceV1Schema.safeParse({
        ...gateEvidence,
        contractVersion: '2.0',
      }).success,
    ).toBe(false);
  });

  it('AdmissionDomain_RemediationActions_AreTypedAndProviderNeutral', () => {
    const actions: readonly unknown[] = [
      remediation,
      { action: 'collect_evidence', requirementId: 'requirement-001', subject },
      { action: 'classify_risk', phaseAttemptId: 'phase-attempt-001' },
      { action: 'request_approval', requirementId: 'requirement-001' },
      {
        action: 'request_waiver',
        requirementIds: ['requirement-001'],
        phaseAttemptId: 'phase-attempt-001',
      },
      { action: 'retry_transition', phaseAttemptId: 'phase-attempt-001' },
    ];

    expect(actions.map((candidate) => RemediationActionV1Schema.parse(candidate).action))
      .toEqual([
        'run_gate',
        'collect_evidence',
        'classify_risk',
        'request_approval',
        'request_waiver',
        'retry_transition',
      ]);
    expect(
      RemediationActionV1Schema.safeParse({
        action: 'run_command',
        command: 'provider-specific invocation',
      }).success,
    ).toBe(false);
  });

  it('AdmissionDomain_WaiverProvenance_IsScopedAndAttributable', () => {
    const actor = {
      principalKind: 'operator',
      principalId: 'principal-001',
      role: 'release-authority',
    } as const;
    const authorization = {
      authorizationId: 'authorization-001',
      posture: 'shared-mutating',
      capabilityIds: ['capability.issue-waiver'],
      resolverVersion: '1.0',
      resolvedAt: AT,
    } as const;
    const common = {
      contractVersion: '1.0',
      waiverId: 'waiver-001',
      actor,
      authorization,
      recordedAt: AT,
    } as const;

    const issued = {
      ...common,
      event: 'issued',
      rationale: 'time-bounded exception approved for this immutable subject',
      scope: {
        kind: 'phase-attempt',
        phaseAttemptId: 'phase-attempt-001',
      },
      subjectDigest: digest(),
      expiresAt: '2026-07-22T19:00:00.000Z',
      waivedRequirementIds: ['requirement-001'],
      policyId: 'policy-001',
      policyDigest: digest(SHA256_B),
    } as const;
    const provenance: readonly unknown[] = [
      issued,
      {
        ...common,
        event: 'revoked',
        reason: 'exception is no longer required',
      },
      {
        ...common,
        event: 'superseded',
        supersededByWaiverId: 'waiver-002',
        reason: 'scope was narrowed',
      },
    ];

    expect(
      provenance.map((candidate) => WaiverProvenanceV1Schema.parse(candidate).event),
    ).toEqual(['issued', 'revoked', 'superseded']);

    const unattributedIssue = {
      ...issued,
      actor: undefined,
    };
    expect(WaiverProvenanceV1Schema.safeParse(unattributedIssue).success).toBe(false);
  });

  it('AdmissionDomain_UnsatisfiedReason_IncludesUnauthorizedAndPersistsInDenyRecord', () => {
    // Additive P06-05: `unauthorized` is a first-class sound deny reason (it is
    // one of evaluatePolicy's PolicyDenyReasons) and MUST be persistable.
    expect(UnsatisfiedRequirementReasonSchema.safeParse('unauthorized').success).toBe(
      true,
    );
    // The pre-existing members remain accepted (no regression / narrowing).
    for (const reason of [
      'missing',
      'failed',
      'stale',
      'malformed',
      'contradictory',
      'waiver-expired',
    ]) {
      expect(UnsatisfiedRequirementReasonSchema.safeParse(reason).success).toBe(true);
    }
    // A genuinely foreign reason still fails closed.
    expect(UnsatisfiedRequirementReasonSchema.safeParse('unknown').success).toBe(false);

    // And a full deny record carrying `unauthorized` round-trips through the
    // persisted decision schema.
    const denyWithUnauthorized = {
      ...decisionBase,
      outcome: 'deny',
      satisfiedRequirementIds: [],
      unsatisfiedRequirements: [
        { requirementId: 'requirement-001', reason: 'unauthorized' },
      ],
      remediation: [remediation],
    };
    const parsed = parseAdmissionDecisionRecordV1(denyWithUnauthorized);
    expect(parsed.outcome).toBe('deny');
    if (parsed.outcome === 'deny') {
      expect(parsed.unsatisfiedRequirements[0]?.reason).toBe('unauthorized');
    }
  });
});
