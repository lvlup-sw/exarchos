import { describe, expect, it } from 'vitest';
import { declared, none, type ActionContract } from '../../src/registry/action-contract.js';
import {
  createActionAdmissionSnapshot,
  evaluateActionAdmission,
} from '../../src/workflow/admission/action-admission.js';
import { POLICY_CAPABILITY } from '../../src/workflow/admission/policy-authority.js';
import { BOTTOM_REQUIREMENTS } from '../../src/workflow/admission/requirement-strength.js';
import { resolveActionIdRequirements } from '../../src/workflow/admission/requirement-resolution.js';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const AT = '2026-07-21T19:00:00.000Z';
const STALE_AT = '2026-07-21T16:00:00.000Z';

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
  capabilityIds: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE, 'mcp:exarchos'],
  resolverVersion: '1.0',
  resolvedAt: AT,
};

const gateEvidence = {
  contractVersion: '1.0' as const,
  evidenceId: 'evidence-001',
  requirementId: 'check_static_analysis',
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

function contractOf(overrides: Partial<ActionContract> = {}): ActionContract {
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

const REQUIRES_STATIC = declared({
  family: 'ladder' as const,
  gate: 'check_static_analysis' as const,
});

describe('action admission evaluation', () => {
  it('EvaluateActionAdmission_Satisfied_Allows', () => {
    const snapshot = createActionAdmissionSnapshot(trustedInput());
    const first = evaluateActionAdmission(
      'workflow.get',
      snapshot,
      contractOf({ requires: REQUIRES_STATIC }),
    );
    const second = evaluateActionAdmission(
      'workflow.get',
      trustedInput(),
      contractOf({ requires: REQUIRES_STATIC }),
    );

    expect(first.verdict).toBe('allow');
    expect(second.verdict).toBe('allow');
    expect(first.digest).toEqual(snapshot.digest);
    expect(second.digest).toEqual(first.digest);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('EvaluateActionAdmission_MissingInput_IsIndeterminate', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      { actionId: 'workflow.get', target: 'completed' },
      contractOf(),
    );
    expect(result.verdict).toBe('indeterminate');
    expect(result.digest.algorithm).toBe('sha256');
    expect(result.digest.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it('EvaluateActionAdmission_MissingCapability_Denies', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      trustedInput(),
      contractOf({ needs: declared('fs:write') }),
    );
    expect(result.verdict).toBe('deny');
  });

  it('EvaluateActionAdmission_TransitionRequires_IsNone', () => {
    const transitionRequires = none(
      'phase verbs defer edge obligations to the HSM transition guard',
    );
    const resolved = resolveActionIdRequirements(transitionRequires);
    expect(resolved).toEqual(BOTTOM_REQUIREMENTS);
    expect(resolved.gates).toEqual([]);

    const result = evaluateActionAdmission(
      'workflow.transition',
      trustedInput({
        actionId: 'workflow.transition',
        evidence: [],
      }),
      contractOf({ requires: transitionRequires }),
    );
    expect(result.verdict).toBe('allow');
  });

  it('EvaluateActionAdmission_SharedIrAlone_DoesNotBypassRequires', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      trustedInput({ evidence: [] }),
      contractOf({ requires: REQUIRES_STATIC }),
    );
    expect(result.verdict).toBe('deny');
  });

  it('EvaluateActionAdmission_DoesNotSelectTransitionTarget', () => {
    const withTarget = evaluateActionAdmission(
      'workflow.transition',
      trustedInput({
        actionId: 'workflow.transition',
        evidence: [],
        target: 'completed',
        payload: { target: 'completed' },
      }),
      contractOf({
        requires: none('phase verbs defer edge obligations to the HSM transition guard'),
      }),
    );
    const withoutTarget = evaluateActionAdmission(
      'workflow.transition',
      trustedInput({ actionId: 'workflow.transition', evidence: [] }),
      contractOf({
        requires: none('phase verbs defer edge obligations to the HSM transition guard'),
      }),
    );

    expect(withTarget).not.toHaveProperty('target');
    expect(withoutTarget).not.toHaveProperty('target');
    expect(withTarget.verdict).toBe(withoutTarget.verdict);
    expect(withTarget.digest).toEqual(withoutTarget.digest);
    expect(createActionAdmissionSnapshot(trustedInput({ target: 'review' }))).not.toHaveProperty(
      'target',
    );
  });

  it('EvaluateActionAdmission_Contradiction_DoesNotAllow', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      trustedInput({
        evidence: [
          gateEvidence,
          { ...gateEvidence, evidenceId: 'evidence-002', verdict: 'fail' },
        ],
      }),
      contractOf({ requires: REQUIRES_STATIC }),
    );
    expect(result.verdict).not.toBe('allow');
    expect(result.verdict).toBe('deny');
  });

  it('EvaluateActionAdmission_SnapshotStaleEvidence_DoesNotAllow', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      trustedInput({
        evidence: [{ ...gateEvidence, createdAt: STALE_AT }],
      }),
      contractOf({ requires: REQUIRES_STATIC }),
    );
    expect(result.verdict).not.toBe('allow');
    expect(result.verdict).toBe('deny');
  });

  it('EvaluateActionAdmission_UnauthorizedEvidence_DoesNotAllow', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      trustedInput({
        authorization: {
          ...authorization,
          capabilityIds: ['mcp:exarchos'],
        },
      }),
      contractOf({ requires: REQUIRES_STATIC }),
    );
    expect(result.verdict).not.toBe('allow');
    expect(result.verdict).toBe('deny');
  });

  it('EvaluateActionAdmission_WaiverMissingPhaseAttempt_IsIndeterminate', () => {
    const result = evaluateActionAdmission(
      'workflow.get',
      trustedInput({
        evidence: [],
        hsmFacts: { phase: 'plan' },
      }),
      contractOf({ requires: REQUIRES_STATIC }),
    );
    expect(result.verdict).toBe('indeterminate');
    expect(result.verdict).not.toBe('allow');
  });
});
