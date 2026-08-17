/**
 * Exit-proof tests for P01-03 Evidence and Admission Algebra.
 *
 * Demonstrates:
 * 1. Bare booleans cannot satisfy requirements.
 * 2. Malformed evidence subjects are rejected.
 * 3. Malformed/mismatched artifact content digests are rejected.
 * 4. Contradiction and reassessment types are exhaustive.
 * 5. Admission event vocabulary is closed and round-trips correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMISSION_EVENT_TYPES,
  ADMISSION_EVENT_TYPE_VALUES,
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  AdmissionDecisionRecordV1Schema,
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  ContradictionRecordV1Schema,
  ContradictionStatementSchema,
  ContentDigestV1Schema,
  EvidenceSubjectV1Schema,
  ReassessmentOutcomeV1Schema,
  ReassessmentRequestV1Schema,
  RequirementIdSchema,
  WaiverProvenanceV1Schema,
  type AdmissionEventType,
  type ContradictionRecordV1,
} from '../../../../src/workflow/admission/types.js';
import {
  EvidenceSubjectValidationError,
  createEvidenceSubject,
  verifyEvidenceSubject,
} from '../../../../src/workflow/admission/evidence-subject.js';
import {
  mapExternalToInternalType,
  mapInternalToExternalType,
} from '../../../../src/workflow/events.js';
import { INTERNAL_ADMISSION_EVENT_TYPES } from '../../../../src/events/schemas.js';

// ─── Shared test fixtures ────────────────────────────────────────────────────

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const AT = '2026-07-21T19:00:00.000Z';

const digest = (value = SHA256_A) =>
  ({ algorithm: 'sha256' as const, value });

const subject = {
  kind: 'task' as const,
  taskId: 'task-002',
  digest: digest(),
};

const producer = {
  producerId: 'producer.gate-runner',
  providerRef: 'provider.static-analysis',
  providerVersion: '1.3.0',
  invocationId: 'invocation-001',
} as const;

const actor = {
  principalKind: 'operator' as const,
  principalId: 'principal-001',
  role: 'release-authority',
} as const;

const authorization = {
  authorizationId: 'authorization-001',
  posture: 'shared-mutating' as const,
  capabilityIds: ['capability.issue-waiver'],
  resolverVersion: '1.0',
  resolvedAt: AT,
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

// ─── Exit proof 1: Bare booleans cannot satisfy requirements ─────────────────

describe('bare booleans cannot satisfy requirements', () => {
  it('AdmissionAlgebra_BareBoolean_CannotSatisfyRequirement', () => {
    // A bare boolean MUST NOT parse as a valid requirement
    expect(AdmissionRequirementV1Schema.safeParse(true).success).toBe(false);
    expect(AdmissionRequirementV1Schema.safeParse(false).success).toBe(false);
  });

  it('AdmissionAlgebra_BareBoolean_CannotSubstituteForEvidence', () => {
    // A bare boolean MUST NOT parse as valid evidence
    expect(AdmissionEvidenceV1Schema.safeParse(true).success).toBe(false);
    expect(AdmissionEvidenceV1Schema.safeParse(false).success).toBe(false);
  });

  it('AdmissionAlgebra_BareBoolean_CannotSubstituteForDecision', () => {
    // A bare boolean MUST NOT parse as a valid decision record
    expect(AdmissionDecisionRecordV1Schema.safeParse(true).success).toBe(false);
    expect(AdmissionDecisionRecordV1Schema.safeParse(false).success).toBe(false);
  });

  it('AdmissionAlgebra_PassedBoolean_CannotSatisfyEvidenceVerdict', () => {
    // An evidence record with verdict as a bare boolean MUST be rejected
    const evidenceWithBooleanVerdict = {
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
      kind: 'gate',
      verdict: true, // bare boolean instead of 'pass'/'fail'/'indeterminate'
    };
    expect(AdmissionEvidenceV1Schema.safeParse(evidenceWithBooleanVerdict).success).toBe(
      false,
    );
  });

  it('AdmissionAlgebra_PassedField_CannotReplaceStructuredDecision', () => {
    // An object with only {passed: true} MUST NOT parse as a decision
    expect(
      AdmissionDecisionRecordV1Schema.safeParse({ passed: true }).success,
    ).toBe(false);
    expect(
      AdmissionDecisionRecordV1Schema.safeParse({
        outcome: true,
        satisfiedRequirementIds: [],
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_BooleanOutcome_CannotReplaceStringOutcome', () => {
    // A decision record with boolean outcome MUST be rejected
    const decisionWithBooleanOutcome = {
      ...decisionBase,
      outcome: true, // boolean instead of 'allow'/'deny'/'indeterminate'
      satisfiedRequirementIds: ['requirement-001'],
      waivedRequirementIds: [],
    };
    expect(
      AdmissionDecisionRecordV1Schema.safeParse(decisionWithBooleanOutcome).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_BooleanRequirementKind_IsRejected', () => {
    // A requirement with boolean kind MUST be rejected
    const reqWithBoolKind = {
      contractVersion: '1.0',
      kind: true,
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      gateId: 'gate.static-analysis',
    };
    expect(AdmissionRequirementV1Schema.safeParse(reqWithBoolKind).success).toBe(false);
  });

  it('AdmissionAlgebra_UntypedObject_CannotSatisfyRequirement', () => {
    // An untyped object without proper discriminant MUST be rejected
    expect(
      AdmissionRequirementV1Schema.safeParse({
        contractVersion: '1.0',
        requirementId: 'requirement-001',
        phaseAttemptId: 'phase-attempt-001',
        subject,
        // missing 'kind' discriminant
      }).success,
    ).toBe(false);
  });
});

// ─── Exit proof 2: Malformed evidence subjects are rejected ──────────────────

describe('malformed evidence subjects are rejected', () => {
  it('AdmissionAlgebra_MissingSubjectKind_IsRejected', () => {
    expect(
      EvidenceSubjectV1Schema.safeParse({
        taskId: 'task-002',
        digest: digest(),
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_UnknownSubjectKind_IsRejected', () => {
    expect(
      EvidenceSubjectV1Schema.safeParse({
        kind: 'unknown-kind',
        unknownId: 'id-001',
        digest: digest(),
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_MissingSubjectId_IsRejected', () => {
    // Task subject without taskId
    expect(
      EvidenceSubjectV1Schema.safeParse({
        kind: 'task',
        digest: digest(),
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_NullSubject_IsRejected', () => {
    expect(EvidenceSubjectV1Schema.safeParse(null).success).toBe(false);
    expect(EvidenceSubjectV1Schema.safeParse(undefined).success).toBe(false);
  });

  it('AdmissionAlgebra_BooleanSubject_IsRejected', () => {
    expect(EvidenceSubjectV1Schema.safeParse(true).success).toBe(false);
    expect(EvidenceSubjectV1Schema.safeParse(false).success).toBe(false);
  });

  it('AdmissionAlgebra_SubjectWithExtraFields_IsRejected', () => {
    // Strict schemas reject extra fields
    expect(
      EvidenceSubjectV1Schema.safeParse({
        kind: 'task',
        taskId: 'task-002',
        digest: digest(),
        extraField: 'should-be-rejected',
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_BlankSubjectId_IsRejected', () => {
    expect(
      EvidenceSubjectV1Schema.safeParse({
        kind: 'task',
        taskId: '',
        digest: digest(),
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_SubjectWithPathTraversal_IsRejected', () => {
    expect(
      EvidenceSubjectV1Schema.safeParse({
        kind: 'task',
        taskId: '../escape',
        digest: digest(),
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_MalformedSubject_RaisesValidationError', () => {
    expect(() =>
      verifyEvidenceSubject(
        { kind: 'task', digest: digest() },
        { content: 'test' },
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'EvidenceSubjectValidationError',
        code: 'MISSING_SUBJECT_COMPONENT',
      }),
    );
  });

  it('AdmissionAlgebra_EverySubjectKind_RequiresMatchingIdField', () => {
    const kindsAndFields = [
      ['workflow', 'workflowId'],
      ['phase-attempt', 'phaseAttemptId'],
      ['wave', 'waveId'],
      ['task', 'taskId'],
      ['commit', 'commitId'],
      ['diff', 'diffId'],
      ['artifact', 'artifactId'],
    ] as const;

    for (const [kind, idField] of kindsAndFields) {
      // Without the ID field: fails
      const withoutId = { kind, digest: digest() };
      expect(
        EvidenceSubjectV1Schema.safeParse(withoutId).success,
        `${kind} without ${idField} should fail`,
      ).toBe(false);

      // With the ID field: succeeds
      const withId = { kind, [idField]: 'test-001', digest: digest() };
      expect(
        EvidenceSubjectV1Schema.safeParse(withId).success,
        `${kind} with ${idField} should pass`,
      ).toBe(true);
    }
  });
});

// ─── Exit proof 3: Malformed/mismatched artifact content digests ─────────────

describe('malformed artifact content digests are rejected', () => {
  it('AdmissionAlgebra_UnsupportedAlgorithm_IsRejected', () => {
    expect(
      ContentDigestV1Schema.safeParse({
        algorithm: 'md5',
        value: SHA256_A,
      }).success,
    ).toBe(false);

    expect(
      ContentDigestV1Schema.safeParse({
        algorithm: 'sha512',
        value: SHA256_A,
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_MalformedHexDigest_IsRejected', () => {
    // Uppercase hex
    expect(
      ContentDigestV1Schema.safeParse({
        algorithm: 'sha256',
        value: SHA256_A.toUpperCase(),
      }).success,
    ).toBe(false);

    // Too short
    expect(
      ContentDigestV1Schema.safeParse({
        algorithm: 'sha256',
        value: 'abc123',
      }).success,
    ).toBe(false);

    // Too long
    expect(
      ContentDigestV1Schema.safeParse({
        algorithm: 'sha256',
        value: SHA256_A + 'ff',
      }).success,
    ).toBe(false);

    // Contains non-hex characters
    expect(
      ContentDigestV1Schema.safeParse({
        algorithm: 'sha256',
        value: 'g'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_MissingDigestFields_IsRejected', () => {
    expect(ContentDigestV1Schema.safeParse({}).success).toBe(false);
    expect(
      ContentDigestV1Schema.safeParse({ algorithm: 'sha256' }).success,
    ).toBe(false);
    expect(
      ContentDigestV1Schema.safeParse({ value: SHA256_A }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_DigestMismatch_IsRejectedByVerification', () => {
    const realSubject = createEvidenceSubject(
      { kind: 'task', taskId: 'task-001' },
      { content: 'original' },
    );

    // Verification with different content fails
    expect(() =>
      verifyEvidenceSubject(realSubject, { content: 'tampered' }),
    ).toThrow(
      expect.objectContaining({
        name: 'EvidenceSubjectValidationError',
        code: 'DIGEST_MISMATCH',
      }),
    );
  });

  it('AdmissionAlgebra_TamperedDigestValue_IsRejected', () => {
    const realSubject = createEvidenceSubject(
      { kind: 'task', taskId: 'task-001' },
      { content: 'original' },
    );

    // Forge a different digest
    const tamperedSubject = {
      ...realSubject,
      digest: { algorithm: 'sha256' as const, value: SHA256_B },
    };

    expect(() =>
      verifyEvidenceSubject(tamperedSubject, { content: 'original' }),
    ).toThrow(
      expect.objectContaining({
        name: 'EvidenceSubjectValidationError',
        code: 'DIGEST_MISMATCH',
      }),
    );
  });

  it('AdmissionAlgebra_ValidDigest_VerifiesSuccessfully', () => {
    const content = { key: 'value', nested: { a: 1 } };
    const realSubject = createEvidenceSubject(
      { kind: 'artifact', artifactId: 'art-001' },
      content,
    );

    const verified = verifyEvidenceSubject(realSubject, content);
    expect(verified).toEqual(realSubject);
    expect(Object.isFrozen(verified)).toBe(true);
  });
});

// ─── Contradiction records ───────────────────────────────────────────────────

describe('contradiction records', () => {
  it('AdmissionAlgebra_ActiveEvidenceContradiction_ParsesCorrectly', () => {
    const contradiction = {
      contractVersion: '1.0',
      source: 'active-evidence',
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      policyDigest: digest(),
      evidenceIds: ['evidence-001', 'evidence-002'],
      statements: ['satisfied', 'unsatisfied'],
    };

    const parsed = ContradictionRecordV1Schema.parse(contradiction);
    expect(parsed.source).toBe('active-evidence');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.evidenceIds)).toBe(true);
  });

  it('AdmissionAlgebra_DownstreamEventContradiction_ParsesCorrectly', () => {
    const contradiction = {
      contractVersion: '1.0',
      source: 'downstream-event',
      contradictionId: 'contradiction-001',
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      policyDigest: digest(),
      evidenceIds: ['evidence-001', 'evidence-002'],
      detectedAt: AT,
    };

    const parsed = ContradictionRecordV1Schema.parse(contradiction);
    expect(parsed.source).toBe('downstream-event');
  });

  it('AdmissionAlgebra_ContradictionWithSingleEvidence_IsRejected', () => {
    // Contradictions require at least 2 evidence IDs
    const singleEvidence = {
      contractVersion: '1.0',
      source: 'active-evidence',
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      policyDigest: digest(),
      evidenceIds: ['evidence-001'],
      statements: ['satisfied', 'unsatisfied'],
    };
    expect(ContradictionRecordV1Schema.safeParse(singleEvidence).success).toBe(false);
  });

  it('AdmissionAlgebra_ContradictionStatements_AreClosed', () => {
    expect(ContradictionStatementSchema.safeParse('satisfied').success).toBe(true);
    expect(ContradictionStatementSchema.safeParse('unsatisfied').success).toBe(true);
    expect(ContradictionStatementSchema.safeParse('indeterminate').success).toBe(true);
    expect(ContradictionStatementSchema.safeParse('unknown').success).toBe(false);
    expect(ContradictionStatementSchema.safeParse(true).success).toBe(false);
  });

  it('AdmissionAlgebra_ContradictionWithBooleanSource_IsRejected', () => {
    expect(
      ContradictionRecordV1Schema.safeParse({
        contractVersion: '1.0',
        source: true,
        requirementId: 'requirement-001',
        phaseAttemptId: 'phase-attempt-001',
        subject,
        policyDigest: digest(),
        evidenceIds: ['evidence-001', 'evidence-002'],
        statements: ['satisfied', 'unsatisfied'],
      }).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_ContradictionSourceArms_AreExhaustive', () => {
    const activeEvidence: ContradictionRecordV1 = ContradictionRecordV1Schema.parse({
      contractVersion: '1.0',
      source: 'active-evidence',
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      policyDigest: digest(),
      evidenceIds: ['evidence-001', 'evidence-002'],
      statements: ['satisfied', 'unsatisfied'],
    });

    const downstream: ContradictionRecordV1 = ContradictionRecordV1Schema.parse({
      contractVersion: '1.0',
      source: 'downstream-event',
      contradictionId: 'contradiction-001',
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      policyDigest: digest(),
      evidenceIds: ['evidence-001', 'evidence-002'],
      detectedAt: AT,
    });

    // Exhaustive: every source arm produces a valid record
    const sources = [activeEvidence.source, downstream.source].sort();
    expect(sources).toEqual(['active-evidence', 'downstream-event']);
  });
});

// ─── Reassessment records ────────────────────────────────────────────────────

describe('reassessment records', () => {
  const reassessmentBase = {
    contractVersion: '1.0',
    reassessmentId: 'reassessment-001',
    operationId: 'operation-001',
    phaseAttemptId: 'phase-attempt-001',
    priorDecisionId: 'decision-001',
    policyId: 'policy-001',
    policyDigest: digest(),
    inputDigest: digest(SHA256_B),
    subject,
    evidenceIds: ['evidence-001'],
    waiverIds: [],
    requestedAt: AT,
    actor,
    authorization,
  } as const;

  it('AdmissionAlgebra_ReassessmentRequest_ParsesCorrectly', () => {
    const parsed = ReassessmentRequestV1Schema.parse(reassessmentBase);
    expect(parsed.reassessmentId).toBe('reassessment-001');
    expect(parsed.priorDecisionId).toBe('decision-001');
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('AdmissionAlgebra_ReassessmentRequest_RequiresActor', () => {
    const { actor: _actor, ...withoutActor } = reassessmentBase;
    expect(ReassessmentRequestV1Schema.safeParse(withoutActor).success).toBe(false);
  });

  it('AdmissionAlgebra_ReassessmentRequest_RequiresAuthorization', () => {
    const { authorization: _auth, ...withoutAuth } = reassessmentBase;
    expect(ReassessmentRequestV1Schema.safeParse(withoutAuth).success).toBe(false);
  });

  it('AdmissionAlgebra_ReassessmentOutcome_ParsesCorrectly', () => {
    const outcome = {
      contractVersion: '1.0',
      reassessmentId: 'reassessment-001',
      priorDecisionId: 'decision-001',
      subject,
      decision: {
        ...decisionBase,
        outcome: 'allow',
        satisfiedRequirementIds: ['requirement-001'],
        waivedRequirementIds: [],
      },
      completedAt: AT,
      actor,
      authorization,
    };

    const parsed = ReassessmentOutcomeV1Schema.parse(outcome);
    expect(parsed.reassessmentId).toBe('reassessment-001');
    expect(parsed.decision.outcome).toBe('allow');
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('AdmissionAlgebra_ReassessmentOutcome_RequiresDecision', () => {
    const outcomeWithoutDecision = {
      contractVersion: '1.0',
      reassessmentId: 'reassessment-001',
      priorDecisionId: 'decision-001',
      subject,
      completedAt: AT,
      actor,
      authorization,
    };
    expect(
      ReassessmentOutcomeV1Schema.safeParse(outcomeWithoutDecision).success,
    ).toBe(false);
  });

  it('AdmissionAlgebra_ReassessmentOutcome_RejectsBooleanDecision', () => {
    const outcomeWithBoolDecision = {
      contractVersion: '1.0',
      reassessmentId: 'reassessment-001',
      priorDecisionId: 'decision-001',
      subject,
      decision: true,
      completedAt: AT,
      actor,
      authorization,
    };
    expect(
      ReassessmentOutcomeV1Schema.safeParse(outcomeWithBoolDecision).success,
    ).toBe(false);
  });
});

// ─── Admission event vocabulary ──────────────────────────────────────────────

describe('admission event vocabulary', () => {
  it('AdmissionAlgebra_EventTypes_MatchRegisteredEventStoreTypes', () => {
    // Every admission event type constant must match a registered
    // INTERNAL_ADMISSION_EVENT_TYPES entry
    const registeredSet = new Set(INTERNAL_ADMISSION_EVENT_TYPES);
    for (const eventType of ADMISSION_EVENT_TYPE_VALUES) {
      expect(
        registeredSet.has(eventType),
        `${eventType} must be registered in INTERNAL_ADMISSION_EVENT_TYPES`,
      ).toBe(true);
    }

    // And every registered type must have a constant
    const constantSet = new Set<string>(ADMISSION_EVENT_TYPE_VALUES);
    for (const registered of INTERNAL_ADMISSION_EVENT_TYPES) {
      expect(
        constantSet.has(registered),
        `${registered} must have a constant in ADMISSION_EVENT_TYPES`,
      ).toBe(true);
    }
  });

  it('AdmissionAlgebra_EventTypes_RoundTripThroughTypeMap', () => {
    // Every admission event type must round-trip as identity through the
    // internal-to-external and external-to-internal mappings
    for (const eventType of ADMISSION_EVENT_TYPE_VALUES) {
      const external = mapInternalToExternalType(eventType);
      expect(external).toBe(eventType); // identity, not workflow.admission.*

      const internal = mapExternalToInternalType(eventType);
      expect(internal).toBe(eventType); // identity round-trip
    }
  });

  it('AdmissionAlgebra_EventTypeConstants_AreFrozen', () => {
    expect(Object.isFrozen(ADMISSION_EVENT_TYPE_VALUES)).toBe(true);
  });

  it('AdmissionAlgebra_EventTypeConstants_AreExhaustive', () => {
    // The constant object has exactly the expected keys
    const expectedKeys = [
      'REQUIREMENT_RESOLVED',
      'EVIDENCE_RECORDED',
      'TRANSITION_DECIDED',
      'WAIVER_RECORDED',
      'CONTRADICTION_RECORDED',
      'REASSESSMENT_REQUESTED',
      'REASSESSMENT_COMPLETED',
      'SHADOW_ATTEMPT',
      'DISAGREEMENT_DISPOSITION',
      'ROLLOUT_DECISION',
      'ENFORCEMENT_ENABLED',
      // #1739 — the cutover promotion path's first-readiness export fact.
      'CUTOVER_READY',
    ] as const;

    expect(Object.keys(ADMISSION_EVENT_TYPES).sort()).toEqual(
      [...expectedKeys].sort(),
    );
  });

  it('AdmissionAlgebra_EventTypes_MatchExpectedValues', () => {
    expect(ADMISSION_EVENT_TYPES.REQUIREMENT_RESOLVED).toBe(
      'admission.requirement-resolved',
    );
    expect(ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED).toBe(
      'admission.evidence-recorded',
    );
    expect(ADMISSION_EVENT_TYPES.TRANSITION_DECIDED).toBe(
      'admission.transition-decided',
    );
    expect(ADMISSION_EVENT_TYPES.WAIVER_RECORDED).toBe(
      'admission.waiver-recorded',
    );
    expect(ADMISSION_EVENT_TYPES.CONTRADICTION_RECORDED).toBe(
      'admission.contradiction-recorded',
    );
    expect(ADMISSION_EVENT_TYPES.REASSESSMENT_REQUESTED).toBe(
      'admission.reassessment-requested',
    );
    expect(ADMISSION_EVENT_TYPES.REASSESSMENT_COMPLETED).toBe(
      'admission.reassessment-completed',
    );
  });
});

// ─── Cross-cutting algebra exhaustiveness ────────────────────────────────────

describe('admission algebra exhaustiveness', () => {
  it('AdmissionAlgebra_RequirementKinds_AreExhaustive', () => {
    const kinds = ['gate-evidence', 'approval', 'corroboration'] as const;
    for (const kind of kinds) {
      const base = {
        contractVersion: '1.0',
        requirementId: `requirement-${kind}`,
        phaseAttemptId: 'phase-attempt-001',
        subject,
      };

      const specific =
        kind === 'gate-evidence'
          ? { ...base, kind, gateId: 'gate.test' }
          : kind === 'approval'
            ? { ...base, kind, approvalClass: 'approval.security', minimumApprovals: 1 }
            : {
                ...base,
                kind,
                sourceRequirementId: 'requirement-001',
                minimumIndependentSources: 2,
              };

      expect(
        AdmissionRequirementV1Schema.parse(specific).kind,
      ).toBe(kind);
    }
  });

  it('AdmissionAlgebra_EvidenceKinds_AreExhaustive', () => {
    const evidenceBase = {
      contractVersion: '1.0',
      evidenceId: 'evidence-001',
      requirementId: 'requirement-001',
      phaseAttemptId: 'phase-attempt-001',
      subject,
      producer,
      policyId: 'policy-001',
      policyDigest: digest(),
      contentDigest: digest(SHA256_B),
      createdAt: AT,
    };

    const gate = AdmissionEvidenceV1Schema.parse({
      ...evidenceBase,
      kind: 'gate',
      verdict: 'pass',
    });
    const approval = AdmissionEvidenceV1Schema.parse({
      ...evidenceBase,
      kind: 'approval',
      verdict: 'approved',
      attributedTo: actor,
    });

    expect([gate.kind, approval.kind].sort()).toEqual(['approval', 'gate']);
  });

  it('AdmissionAlgebra_DecisionOutcomes_AreExhaustive', () => {
    const outcomes = ['allow', 'deny', 'indeterminate'] as const;
    for (const outcome of outcomes) {
      const decision =
        outcome === 'allow'
          ? {
              ...decisionBase,
              outcome,
              satisfiedRequirementIds: ['r-001'],
              waivedRequirementIds: [],
            }
          : outcome === 'deny'
            ? {
                ...decisionBase,
                outcome,
                satisfiedRequirementIds: [],
                unsatisfiedRequirements: [
                  { requirementId: 'r-001', reason: 'missing' },
                ],
                remediation: [
                  {
                    action: 'run_gate',
                    requirementId: 'r-001',
                    gateId: 'gate.test',
                  },
                ],
              }
            : {
                ...decisionBase,
                outcome,
                unresolvedRequirementIds: ['r-001'],
                errors: [
                  { code: 'EVALUATOR_FAILED', message: 'provider error' },
                ],
                remediation: [
                  {
                    action: 'retry_transition',
                    phaseAttemptId: 'phase-attempt-001',
                  },
                ],
              };

      expect(AdmissionDecisionRecordV1Schema.parse(decision).outcome).toBe(
        outcome,
      );
    }
  });

  it('AdmissionAlgebra_WaiverEvents_AreExhaustive', () => {
    const common = {
      contractVersion: '1.0',
      waiverId: 'waiver-001',
      actor,
      authorization,
      recordedAt: AT,
    };

    const events = [
      {
        ...common,
        event: 'issued',
        rationale: 'time-bounded exception',
        scope: { kind: 'phase-attempt', phaseAttemptId: 'pa-001' },
        subjectDigest: digest(),
        expiresAt: '2026-07-22T19:00:00.000Z',
        waivedRequirementIds: ['requirement-001'],
        policyId: 'policy-001',
        policyDigest: digest(SHA256_B),
      },
      { ...common, event: 'revoked', reason: 'no longer required' },
      {
        ...common,
        event: 'superseded',
        supersededByWaiverId: 'waiver-002',
        reason: 'scope narrowed',
      },
    ] as const;

    const parsedEvents = events.map(
      (e) => WaiverProvenanceV1Schema.parse(e).event,
    );
    expect(parsedEvents).toEqual(['issued', 'revoked', 'superseded']);
  });

  it('AdmissionAlgebra_StableIdSchema_RejectsMalformedIdentities', () => {
    const invalid = [
      '', // blank
      '  ', // whitespace
      'has space', // spaces
      '../path', // path traversal
      '.starts-with-dot', // leading dot
      '-starts-with-hyphen', // leading hyphen
      'a'.repeat(257), // too long
    ];

    for (const id of invalid) {
      expect(
        RequirementIdSchema.safeParse(id).success,
        `"${id}" should be rejected`,
      ).toBe(false);
    }
  });
});
