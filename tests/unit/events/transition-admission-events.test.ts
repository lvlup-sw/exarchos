import { describe, expect, it } from 'vitest';
import { buildValidatedEvent } from '../../../src/events/event-factory.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  EventTypes,
  INTERNAL_ADMISSION_EVENT_TYPES,
} from '../../../src/events/schemas.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const AT = '2026-07-21T20:00:00.000Z';
const digest = (value = SHA_A) => ({ algorithm: 'sha256', value });

const subject = {
  kind: 'task',
  taskId: 'task-003',
  digest: digest(),
} as const;

const caller = {
  principalKind: 'operator',
  principalId: 'principal.release',
  role: 'release-authority',
} as const;

const authorization = {
  authorizationId: 'authorization-003',
  posture: 'shared-mutating',
  capabilityIds: ['capability.admission'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;

const requirement = {
  contractVersion: '1.0',
  kind: 'gate-evidence',
  requirementId: 'requirement-003',
  phaseAttemptId: 'phase-attempt-003',
  subject,
  gateId: 'gate.typecheck',
} as const;

const evidence = {
  contractVersion: '1.0',
  kind: 'gate',
  evidenceId: 'evidence-003',
  requirementId: 'requirement-003',
  phaseAttemptId: 'phase-attempt-003',
  subject,
  producer: {
    producerId: 'producer.gate-runner',
    providerRef: 'provider.typecheck',
    providerVersion: '1.0',
    invocationId: 'invocation-003',
  },
  policyId: 'policy-003',
  policyDigest: digest(),
  contentDigest: digest(SHA_B),
  createdAt: AT,
  verdict: 'pass',
} as const;

const decision = {
  contractVersion: '1.0',
  decisionId: 'decision-003',
  operationId: 'operation-003',
  phaseAttemptId: 'phase-attempt-003',
  policyId: 'policy-003',
  policyVersion: '1.0',
  policyDigest: digest(),
  requirementSetDigest: digest(SHA_B),
  inputDigest: digest(),
  evidenceIds: ['evidence-003'],
  waiverIds: [],
  decidedAt: AT,
  outcome: 'allow',
  satisfiedRequirementIds: ['requirement-003'],
  waivedRequirementIds: [],
} as const;

const provenance = { caller, authorization } as const;

const validEvents = {
  'admission.requirement-resolved': {
    eventVersion: '1.0',
    resolutionId: 'resolution-003',
    operationId: 'operation-003',
    policyId: 'policy-003',
    policyVersion: '1.0',
    policyDigest: digest(),
    requirementSetDigest: digest(SHA_B),
    inputDigest: digest(),
    resolvedAt: AT,
    requirement,
  },
  'admission.evidence-recorded': {
    eventVersion: '1.0',
    evidence,
  },
  'admission.transition-decided': {
    eventVersion: '1.0',
    subject,
    decision,
    ...provenance,
  },
  'admission.waiver-recorded': {
    eventVersion: '1.0',
    provenance: {
      contractVersion: '1.0',
      waiverId: 'waiver-003',
      event: 'issued',
      actor: caller,
      authorization,
      recordedAt: AT,
      rationale: 'A bounded, attributable exception.',
      scope: { kind: 'phase-attempt', phaseAttemptId: 'phase-attempt-003' },
      subjectDigest: digest(),
      expiresAt: '2026-07-22T20:00:00.000Z',
      waivedRequirementIds: ['requirement-003'],
      policyId: 'policy-003',
      policyDigest: digest(SHA_B),
    },
  },
  'admission.contradiction-recorded': {
    eventVersion: '1.0',
    contradictionId: 'contradiction-003',
    phaseAttemptId: 'phase-attempt-003',
    policyId: 'policy-003',
    policyDigest: digest(),
    subject,
    evidenceIds: ['evidence-003', 'evidence-004'],
    evidenceSetDigest: digest(SHA_B),
    detectedAt: AT,
  },
  'admission.reassessment-requested': {
    eventVersion: '1.0',
    reassessmentId: 'reassessment-003',
    operationId: 'operation-reassessment-003',
    phaseAttemptId: 'phase-attempt-003',
    priorDecisionId: 'decision-002',
    policyId: 'policy-003',
    policyVersion: '1.0',
    policyDigest: digest(),
    inputDigest: digest(SHA_B),
    subject,
    evidenceIds: ['evidence-003'],
    waiverIds: [],
    requestedAt: AT,
    ...provenance,
  },
  'admission.reassessment-completed': {
    eventVersion: '1.0',
    reassessmentId: 'reassessment-003',
    priorDecisionId: 'decision-002',
    subject,
    decision,
    completedAt: AT,
    ...provenance,
  },
  'admission.shadow-attempt': {
    eventVersion: '1.0',
    shadowAttemptId: 'shadow-attempt-003',
    operationId: 'operation-shadow-003',
    phaseAttemptId: 'phase-attempt-003',
    legacyOutcome: 'allow',
    subject,
    evidenceSetDigest: digest(SHA_B),
    decision,
    attemptedAt: AT,
    ...provenance,
  },
  'admission.disagreement-disposition': {
    eventVersion: '1.0',
    dispositionId: 'disposition-003',
    shadowAttemptId: 'shadow-attempt-003',
    disposition: 'explained-legacy',
    rationale: 'The legacy guard did not require persisted evidence.',
    recordedAt: AT,
    ...provenance,
  },
  'admission.rollout-decision': {
    eventVersion: '1.0',
    rolloutDecisionId: 'rollout-003',
    operationId: 'operation-rollout-003',
    outcome: 'continue-shadow',
    policyId: 'policy-003',
    policyVersion: '1.0',
    policyDigest: digest(),
    inputDigest: digest(SHA_B),
    evidenceIds: ['evidence-003'],
    shadowEvidenceDigest: digest(),
    decidedAt: AT,
    ...provenance,
  },
  'admission.enforcement-enabled': {
    eventVersion: '1.0',
    enablementId: 'enablement-003',
    operationId: 'operation-rollout-003',
    rolloutDecisionId: 'rollout-003',
    policyId: 'policy-003',
    policyVersion: '1.0',
    policyDigest: digest(),
    inputDigest: digest(SHA_B),
    enabledAt: AT,
    ...provenance,
  },
  'admission.cutover-ready': {
    eventVersion: '1.0',
    readinessId: `cutover-ready:${SHA_A}`,
    reportPath: '/tmp/state/admission/cutover-readiness.json',
    reportDigest: digest(),
    comparableLiveAttemptCount: 24,
    durableAttemptCount: 24,
    observerStatus: 'healthy',
    recordedAt: AT,
    ...provenance,
  },
} as const;

describe('internal transition admission event schemas', () => {
  it('AdmissionEvents_AllPayloads_RoundTripThroughRealRegistry', () => {
    expect(Object.keys(validEvents)).toEqual(INTERNAL_ADMISSION_EVENT_TYPES);

    for (const [type, payload] of Object.entries(validEvents)) {
      expect(EventTypes).toContain(type);
      // Admission events with a REAL automatic producer today. Everything else
      // is still 'planned' (schema landed, producer not yet wired).
      //   - admission.evidence-recorded: canonical gate runner (v2.12).
      //   - admission.shadow-attempt / admission.disagreement-disposition:
      //     the live shadow observer, on every guarded transition (DR-23/T-31).
      //   - admission.rollout-decision / admission.enforcement-enabled: the
      //     `cutover_decide` typed handler (#1739 — verbs/gates/cutover-readiness.ts).
      //   - admission.cutover-ready: the observer's durable-append auto-export
      //     hook (#1739 — workflow/admission/cutover-auto-export.ts).
      const autoEmitted = new Set([
        'admission.evidence-recorded',
        'admission.shadow-attempt',
        'admission.disagreement-disposition',
        'admission.rollout-decision',
        'admission.enforcement-enabled',
        'admission.cutover-ready',
      ]);
      const expectedSource = autoEmitted.has(type) ? 'auto' : 'planned';
      expect(EVENT_EMISSION_REGISTRY[type as keyof typeof EVENT_EMISSION_REGISTRY])
        .toBe(expectedSource);

      const schema = EVENT_DATA_SCHEMAS[type as keyof typeof EVENT_DATA_SCHEMAS];
      expect(schema, `missing schema for ${type}`).toBeDefined();
      const parsed = schema!.parse(JSON.parse(JSON.stringify(payload)));
      expect(parsed).toEqual(payload);

      expect(() =>
        buildValidatedEvent('phase-gate-v212-proof-substrate', 1, {
          type,
          data: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
        }),
      ).not.toThrow();
    }
  });

  it('AdmissionEvents_MalformedPayload_IsRejected', () => {
    const mixedDecision = {
      ...validEvents['admission.transition-decided'],
      decision: {
        ...decision,
        unsatisfiedRequirements: [
          { requirementId: 'requirement-004', reason: 'failed' },
        ],
      },
    };
    const forgedProvenance = {
      ...validEvents['admission.reassessment-requested'],
      issuerRole: 'self-asserted-admin',
    };

    const malformed: ReadonlyArray<readonly [keyof typeof validEvents, unknown]> = [
      [
        'admission.requirement-resolved',
        { ...validEvents['admission.requirement-resolved'], inputDigest: undefined },
      ],
      [
        'admission.evidence-recorded',
        {
          eventVersion: '1.0',
          evidence: { ...evidence, contentDigest: undefined },
        },
      ],
      ['admission.transition-decided', mixedDecision],
      [
        'admission.contradiction-recorded',
        {
          ...validEvents['admission.contradiction-recorded'],
          contradictionId: '../forged',
        },
      ],
      ['admission.reassessment-requested', forgedProvenance],
      [
        'admission.rollout-decision',
        { ...validEvents['admission.rollout-decision'], eventVersion: '2.0' },
      ],
    ];

    for (const [type, payload] of malformed) {
      const schema = EVENT_DATA_SCHEMAS[type];
      expect(schema, `missing schema for ${type}`).toBeDefined();
      expect(schema!.safeParse(payload).success, `${type} accepted malformed payload`)
        .toBe(false);
    }
  });
});
