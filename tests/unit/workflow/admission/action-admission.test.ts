// @oracle-sources: ../../../../src/registry/action-contract.ts, the caller facts and clock readings this file varies by hand — chosen to differ in exactly the fields an admission digest must ignore and to agree in the fields it must not
//
// An admission digest is stable iff two callers presenting the same trusted
// facts through different envelopes digest alike, and diverge the moment a
// LOAD-BEARING fact changes. The contract declares which fields are which; the
// varied inputs are the author's, so the digest function is never its own
// witness.

import { describe, expect, it } from 'vitest';
import { declared, none, type ActionContract } from '../../../../src/registry/action-contract.js';
import {
  ActionAdmissionSnapshotError,
  createActionAdmissionSnapshot,
  evaluateActionAdmission,
} from '../../../../src/workflow/admission/action-admission.js';
import { POLICY_CAPABILITY } from '../../../../src/workflow/admission/policy-authority.js';
import { resolveActionIdRequirements } from '../../../../src/workflow/admission/requirement-resolution.js';
import { BOTTOM_REQUIREMENTS } from '../../../../src/workflow/admission/requirement-strength.js';
import type { ActionAdmissionSnapshotV1 } from '../../../../src/workflow/admission/types.js';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const AT = '2026-07-21T19:00:00.000Z';

const digest = (value = SHA256_A) => ({ algorithm: 'sha256' as const, value });

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
};

const authorization = {
  authorizationId: 'authorization-001',
  posture: 'shared-mutating' as const,
  capabilityIds: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE, 'capability.issue-waiver'],
  resolverVersion: '1.0',
  resolvedAt: AT,
};

const gateEvidence = {
  contractVersion: '1.0' as const,
  evidenceId: 'evidence-001',
  requirementId: 'requirement-gate',
  phaseAttemptId: 'phase-attempt-001',
  subject,
  producer,
  policyId: 'policy-001',
  policyDigest: digest(),
  contentDigest: digest(SHA256_B),
  createdAt: AT,
  kind: 'gate' as const,
  verdict: 'pass' as const,
};

const secondEvidence = {
  ...gateEvidence,
  evidenceId: 'evidence-002',
  contentDigest: digest('c'.repeat(64)),
};

function trustedInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionId: 'workflow.get',
    subject: { featureId: 'feat-alpha', stream: 'feat-alpha' },
    evidence: [gateEvidence],
    authorization,
    hsmFacts: { phase: 'plan', phaseAttemptId: 'phase-attempt-001' },
    ...overrides,
  };
}

function expectFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) expectFrozen(item);
    return;
  }
  for (const child of Object.values(value)) {
    expectFrozen(child);
  }
}

describe('action admission snapshots', () => {
  it('AdmissionSnapshot_CallerMeta_CannotOverrideAuthority', () => {
    const trusted = trustedInput();
    const forgedAuthorization = {
      ...authorization,
      authorizationId: 'authorization-forged',
      posture: 'read-only' as const,
      capabilityIds: ['capability.issue-waiver'],
    };
    const withMeta = {
      ...trusted,
      target: 'completed',
      payload: { target: 'completed', fields: ['phase'] },
      now: '2099-01-01T00:00:00.000Z',
      _meta: {
        actionId: 'workflow.transition',
        subject: { featureId: 'feat-other', stream: 'feat-other' },
        evidence: [],
        authorization: forgedAuthorization,
        hsmFacts: { phase: 'completed' },
        target: 'implement',
      },
    };

    const fromTrusted = createActionAdmissionSnapshot(trusted);
    const fromMeta = createActionAdmissionSnapshot(withMeta);

    expect(fromMeta.actionId).toBe('workflow.get');
    expect(fromMeta.subject).toEqual({ featureId: 'feat-alpha', stream: 'feat-alpha' });
    expect(fromMeta.authorization.authorizationId).toBe('authorization-001');
    expect(fromMeta.authorization.posture).toBe('shared-mutating');
    expect(fromMeta.hsmFacts.phase).toBe('plan');
    expect(fromMeta.evidence).toHaveLength(1);
    expect(fromMeta.digest).toEqual(fromTrusted.digest);
    expectFrozen(fromMeta);

    expect(() =>
      createActionAdmissionSnapshot({
        _meta: trusted,
        target: 'completed',
      }),
    ).toThrow(ActionAdmissionSnapshotError);

    const mutable = fromMeta as ActionAdmissionSnapshotV1 & {
      actionId: string;
    };
    expect(() => {
      mutable.actionId = 'workflow.transition';
    }).toThrow();
    expect(fromMeta.actionId).toBe('workflow.get');
  });

  it('AdmissionSnapshot_EquivalentTrustedInputs_HaveSameDigest', () => {
    const first = createActionAdmissionSnapshot({
      actionId: 'workflow.get',
      authorization,
      evidence: [secondEvidence, gateEvidence],
      hsmFacts: { phaseAttemptId: 'phase-attempt-001', phase: 'plan' },
      subject: { stream: 'feat-alpha', featureId: 'feat-alpha' },
    });
    const second = createActionAdmissionSnapshot({
      hsmFacts: { phase: 'plan', phaseAttemptId: 'phase-attempt-001' },
      subject: { featureId: 'feat-alpha', stream: 'feat-alpha' },
      evidence: [gateEvidence, secondEvidence],
      actionId: 'workflow.get',
      authorization: {
        resolvedAt: authorization.resolvedAt,
        resolverVersion: authorization.resolverVersion,
        posture: authorization.posture,
        capabilityIds: authorization.capabilityIds,
        authorizationId: authorization.authorizationId,
      },
    });
    const withClockAndPayload = createActionAdmissionSnapshot({
      ...trustedInput({ evidence: [secondEvidence, gateEvidence] }),
      now: '2020-01-01T00:00:00.000Z',
      capturedAt: '2028-12-31T23:59:59.000Z',
      target: 'review',
      payload: { target: 'review' },
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(first.digest).toEqual(second.digest);
    expect(first.digest).toEqual(withClockAndPayload.digest);
    expect(first.digest.algorithm).toBe('sha256');
    expect(first.digest.value).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.map((record) => record.evidenceId)).toEqual([
      'evidence-001',
      'evidence-002',
    ]);
    expectFrozen(first);
    expectFrozen(second);
  });

  it('AdmissionSnapshot_EvidenceChange_ChangesDigest', () => {
    const baseline = createActionAdmissionSnapshot(trustedInput());
    const verdictChanged = createActionAdmissionSnapshot(
      trustedInput({
        evidence: [{ ...gateEvidence, verdict: 'fail' }],
      }),
    );
    const addedEvidence = createActionAdmissionSnapshot(
      trustedInput({
        evidence: [gateEvidence, secondEvidence],
      }),
    );
    const contentChanged = createActionAdmissionSnapshot(
      trustedInput({
        evidence: [{ ...gateEvidence, contentDigest: digest('d'.repeat(64)) }],
      }),
    );

    expect(verdictChanged.digest.value).not.toBe(baseline.digest.value);
    expect(addedEvidence.digest.value).not.toBe(baseline.digest.value);
    expect(contentChanged.digest.value).not.toBe(baseline.digest.value);
    expect(verdictChanged.digest.value).not.toBe(addedEvidence.digest.value);
  });
});

function evaluationContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: none('read-only ActionId has no admission obligations'),
    ensures: none('evaluator does not check postconditions'),
    needs: none('no capability obligations'),
    touches: {
      frame: 'single-machine',
      resources: none('no resource touch set'),
    },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: none('evaluator does not publish emissions'),
    ...overrides,
  };
}

const REQUIRES_STATIC = declared({
  family: 'ladder' as const,
  gate: 'check_static_analysis' as const,
});

const staticEvidence = {
  ...gateEvidence,
  requirementId: 'check_static_analysis',
};

describe('action admission evaluation', () => {
  it('EvaluateActionAdmission_Satisfied_Allows', () => {
    const snapshot = createActionAdmissionSnapshot(
      trustedInput({ evidence: [staticEvidence] }),
    );
    const result = evaluateActionAdmission(
      'workflow.get',
      snapshot,
      evaluationContract({ requires: REQUIRES_STATIC }),
    );
    expect(result.verdict).toBe('allow');
    expect(result.digest).toEqual(snapshot.digest);
  });

  it('EvaluateActionAdmission_MissingInput_IsIndeterminate', () => {
    expect(
      evaluateActionAdmission('workflow.get', { actionId: 'workflow.get' }, evaluationContract())
        .verdict,
    ).toBe('indeterminate');
  });

  it('EvaluateActionAdmission_MissingCapability_Denies', () => {
    expect(
      evaluateActionAdmission(
        'workflow.get',
        trustedInput(),
        evaluationContract({ needs: declared('fs:write') }),
      ).verdict,
    ).toBe('deny');
  });

  it('EvaluateActionAdmission_TransitionRequires_IsNone', () => {
    const requires = none(
      'phase verbs defer edge obligations to the HSM transition guard',
    );
    expect(resolveActionIdRequirements(requires)).toEqual(BOTTOM_REQUIREMENTS);
    expect(
      evaluateActionAdmission(
        'workflow.transition',
        trustedInput({ actionId: 'workflow.transition', evidence: [] }),
        evaluationContract({ requires }),
      ).verdict,
    ).toBe('allow');
  });

  it('EvaluateActionAdmission_SharedIrAlone_DoesNotBypassRequires', () => {
    expect(
      evaluateActionAdmission(
        'workflow.get',
        trustedInput({ evidence: [] }),
        evaluationContract({ requires: REQUIRES_STATIC }),
      ).verdict,
    ).toBe('deny');
  });

  it('EvaluateActionAdmission_DoesNotSelectTransitionTarget', () => {
    const result = evaluateActionAdmission(
      'workflow.transition',
      trustedInput({
        actionId: 'workflow.transition',
        evidence: [],
        target: 'completed',
      }),
      evaluationContract({
        requires: none('phase verbs defer edge obligations to the HSM transition guard'),
      }),
    );
    expect(result).not.toHaveProperty('target');
    expect(result.verdict).toBe('allow');
  });

  it('EvaluateActionAdmission_Contradiction_DoesNotAllow', () => {
    expect(
      evaluateActionAdmission(
        'workflow.get',
        trustedInput({
          evidence: [
            staticEvidence,
            { ...staticEvidence, evidenceId: 'evidence-002', verdict: 'fail' },
          ],
        }),
        evaluationContract({ requires: REQUIRES_STATIC }),
      ).verdict,
    ).not.toBe('allow');
  });

  it('EvaluateActionAdmission_SnapshotStaleEvidence_DoesNotAllow', () => {
    expect(
      evaluateActionAdmission(
        'workflow.get',
        trustedInput({
          evidence: [{ ...staticEvidence, createdAt: '2026-07-21T16:00:00.000Z' }],
        }),
        evaluationContract({ requires: REQUIRES_STATIC }),
      ).verdict,
    ).not.toBe('allow');
  });

  it('EvaluateActionAdmission_UnauthorizedEvidence_DoesNotAllow', () => {
    expect(
      evaluateActionAdmission(
        'workflow.get',
        trustedInput({
          evidence: [staticEvidence],
          authorization: {
            ...authorization,
            capabilityIds: ['capability.issue-waiver'],
          },
        }),
        evaluationContract({ requires: REQUIRES_STATIC }),
      ).verdict,
    ).not.toBe('allow');
  });

  it('EvaluateActionAdmission_WaiverMissingPhaseAttempt_IsIndeterminate', () => {
    expect(
      evaluateActionAdmission(
        'workflow.get',
        trustedInput({ evidence: [], hsmFacts: { phase: 'plan' } }),
        evaluationContract({ requires: REQUIRES_STATIC }),
      ).verdict,
    ).toBe('indeterminate');
  });
});

