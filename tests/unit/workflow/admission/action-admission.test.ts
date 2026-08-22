import { describe, expect, it } from 'vitest';
import {
  ActionAdmissionSnapshotError,
  createActionAdmissionSnapshot,
} from '../../../../src/workflow/admission/action-admission.js';
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
  capabilityIds: ['capability.issue-waiver'],
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
