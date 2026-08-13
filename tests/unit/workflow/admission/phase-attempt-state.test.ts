/**
 * Exit-proof tests for P01-04 — phase attempts and frozen state.
 *
 * Exit proof: replay reconstructs the same active attempt, requirements,
 * evidence, and decision WITHOUT current policy or external I/O.
 *
 * The tests below establish that as three separable facts:
 *   1. the fold is a pure function of persisted payloads (identical replays,
 *      untouched inputs, no policy/clock/store handle in its signature);
 *   2. a later policy edit cannot retroactively change a frozen attempt;
 *   3. malformed or unreconcilable persisted facts are QUARANTINED — never
 *      silently dropped, never silently trusted.
 */
import { describe, expect, it } from 'vitest';

import {
  foldPhaseAttemptAdmission,
  selectPhaseAttempt,
  type PhaseAttemptAdmissionFoldInput,
} from '../../../../src/workflow/admission/phase-attempt-state.js';
import { ADMISSION_RUNTIME_CONTRACT_VERSION } from '../../../../src/workflow/admission/types.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AT = '2026-07-21T19:00:00.000Z';
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

const digest = (seed: string) =>
  ({ algorithm: 'sha256' as const, value: hex(seed) });

const POLICY_DIGEST_V1 = digest('1');
const POLICY_DIGEST_V2 = digest('2');
const INPUT_DIGEST = digest('3');
const SET_DIGEST_A = digest('a');
const SET_DIGEST_B = digest('b');
const CONTENT_DIGEST = digest('c');

const ATTEMPT_ONE = 'phase-attempt.plan.1';
const ATTEMPT_TWO = 'phase-attempt.plan.2';

const subject = (taskId: string) =>
  ({ kind: 'task' as const, taskId, digest: digest('d') });

const caller = {
  principalKind: 'agent' as const,
  principalId: 'principal.orchestrator',
  role: 'orchestrator',
} as const;

const authorization = {
  authorizationId: 'authorization.1',
  posture: 'task-isolated' as const,
  capabilityIds: ['capability.decide-transition'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;

interface RequirementOptions {
  readonly phaseAttemptId?: string;
  readonly requirementSetDigest?: { algorithm: 'sha256'; value: string };
  readonly policyVersion?: string;
  readonly policyDigest?: { algorithm: 'sha256'; value: string };
  readonly gateId?: string;
  readonly resolutionId?: string;
}

function requirementResolved(
  requirementId: string,
  options: RequirementOptions = {},
): unknown {
  return {
    eventVersion: '1.0',
    resolutionId: options.resolutionId ?? `resolution.${requirementId}`,
    operationId: 'operation.1',
    policyId: 'policy.transition',
    policyVersion: options.policyVersion ?? '1.0',
    policyDigest: options.policyDigest ?? POLICY_DIGEST_V1,
    requirementSetDigest: options.requirementSetDigest ?? SET_DIGEST_A,
    inputDigest: INPUT_DIGEST,
    resolvedAt: AT,
    requirement: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      requirementId,
      phaseAttemptId: options.phaseAttemptId ?? ATTEMPT_ONE,
      subject: subject('task.1'),
      kind: 'gate-evidence',
      gateId: options.gateId ?? `gate.${requirementId}`,
    },
  };
}

function evidenceRecorded(
  evidenceId: string,
  requirementId: string,
  options: { readonly phaseAttemptId?: string; readonly verdict?: 'pass' | 'fail' } = {},
): unknown {
  return {
    eventVersion: '1.0',
    evidence: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      evidenceId,
      requirementId,
      phaseAttemptId: options.phaseAttemptId ?? ATTEMPT_ONE,
      subject: subject('task.1'),
      producer: {
        producerId: 'producer.gate-runner',
        providerRef: 'provider.static-analysis',
        providerVersion: '1.3.0',
        invocationId: `invocation.${evidenceId}`,
      },
      policyId: 'policy.transition',
      policyDigest: POLICY_DIGEST_V1,
      contentDigest: CONTENT_DIGEST,
      createdAt: AT,
      kind: 'gate',
      verdict: options.verdict ?? 'pass',
    },
  };
}

function transitionDecided(
  decisionId: string,
  options: {
    readonly phaseAttemptId?: string;
    readonly requirementSetDigest?: { algorithm: 'sha256'; value: string };
    readonly satisfiedRequirementIds?: readonly string[];
    readonly evidenceIds?: readonly string[];
  } = {},
): unknown {
  return {
    eventVersion: '1.0',
    subject: subject('task.1'),
    decision: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      decisionId,
      operationId: 'operation.1',
      phaseAttemptId: options.phaseAttemptId ?? ATTEMPT_ONE,
      policyId: 'policy.transition',
      policyVersion: '1.0',
      policyDigest: POLICY_DIGEST_V1,
      requirementSetDigest: options.requirementSetDigest ?? SET_DIGEST_A,
      inputDigest: INPUT_DIGEST,
      evidenceIds: options.evidenceIds ?? ['evidence.1'],
      waiverIds: [],
      decidedAt: AT,
      outcome: 'allow',
      satisfiedRequirementIds: options.satisfiedRequirementIds ?? ['requirement.typecheck'],
      waivedRequirementIds: [],
    },
    caller,
    authorization,
  };
}

/** A complete, well-formed single-attempt history. */
function intactHistory(): PhaseAttemptAdmissionFoldInput {
  return {
    requirementEvents: [
      requirementResolved('requirement.typecheck'),
      requirementResolved('requirement.tests'),
    ],
    evidenceEvents: [
      evidenceRecorded('evidence.1', 'requirement.typecheck'),
      evidenceRecorded('evidence.2', 'requirement.tests'),
    ],
    decisionEvents: [
      transitionDecided('decision.1', {
        satisfiedRequirementIds: ['requirement.typecheck', 'requirement.tests'],
        evidenceIds: ['evidence.1', 'evidence.2'],
      }),
    ],
  };
}

// ─── Exit proof 1: replay reconstructs identical frozen state ────────────────

describe('replay reconstructs the same attempt, requirements, evidence, decision', () => {
  it('PhaseAttemptFold_Replay_ReconstructsIdenticalFrozenState', () => {
    const history = intactHistory();

    const first = foldPhaseAttemptAdmission(history);
    const second = foldPhaseAttemptAdmission(history);

    expect(second).toEqual(first);
    expect(first.integrity).toBe('intact');
    expect(first.diagnostics).toEqual([]);
    expect(first.attempts).toHaveLength(1);

    const attempt = first.attempts[0];
    expect(attempt?.phaseAttemptId).toBe(ATTEMPT_ONE);
    expect(attempt?.integrity).toBe('intact');
    expect(attempt?.frozenRequirementSet?.requirementIds).toEqual([
      'requirement.typecheck',
      'requirement.tests',
    ]);
    expect(attempt?.frozenRequirementSet?.requirementSetDigest).toEqual(SET_DIGEST_A);
    expect(attempt?.evidence.map((record) => record.evidenceId)).toEqual([
      'evidence.1',
      'evidence.2',
    ]);
    expect(attempt?.decision?.decisionId).toBe('decision.1');
    expect(attempt?.unattributedEvidence).toEqual([]);
  });

  it('PhaseAttemptFold_ReplayIsPure_NeverMutatesPersistedHistories', () => {
    const requirementEvents = [requirementResolved('requirement.typecheck')];
    const evidenceEvents = [evidenceRecorded('evidence.1', 'requirement.typecheck')];
    const decisionEvents = [transitionDecided('decision.1')];
    const snapshot = JSON.stringify({
      requirementEvents,
      evidenceEvents,
      decisionEvents,
    });

    const fold = foldPhaseAttemptAdmission({
      requirementEvents,
      evidenceEvents,
      decisionEvents,
    });

    expect(
      JSON.stringify({ requirementEvents, evidenceEvents, decisionEvents }),
    ).toBe(snapshot);
    // Guard against a vacuous pass: the fold must actually have reconstructed
    // something from those untouched inputs.
    expect(fold.attempts[0]?.decision?.decisionId).toBe('decision.1');
  });

  it('PhaseAttemptFold_CrossStreamOrder_DoesNotChangeReconstruction', () => {
    // Evidence persisted before its requirement resolution still binds: the
    // fold attributes in a second pass, so no stream ordering is privileged.
    const forward = foldPhaseAttemptAdmission({
      requirementEvents: [requirementResolved('requirement.typecheck')],
      evidenceEvents: [evidenceRecorded('evidence.1', 'requirement.typecheck')],
      decisionEvents: [transitionDecided('decision.1')],
    });
    const reversed = foldPhaseAttemptAdmission({
      decisionEvents: [transitionDecided('decision.1')],
      evidenceEvents: [evidenceRecorded('evidence.1', 'requirement.typecheck')],
      requirementEvents: [requirementResolved('requirement.typecheck')],
    });

    expect(reversed).toEqual(forward);
    expect(forward.attempts[0]?.evidence).toHaveLength(1);
  });

  it('PhaseAttemptFold_EmptyHistory_ReconstructsNoAttempts', () => {
    expect(foldPhaseAttemptAdmission({})).toEqual({
      attempts: [],
      diagnostics: [],
      integrity: 'intact',
    });
  });
});

// ─── Exit proof 2: frozen against current policy ─────────────────────────────

describe('frozen requirement sets ignore current policy', () => {
  it('FreezeRequirements_PolicyChange_PreservesSnapshot', () => {
    const frozenAtEntry = [
      requirementResolved('requirement.typecheck'),
      requirementResolved('requirement.tests'),
    ];
    const before = foldPhaseAttemptAdmission({ requirementEvents: frozenAtEntry });

    // A later policy revision freezes a DIFFERENT set for a NEW attempt. The
    // historical attempt's reconstruction is byte-identical regardless.
    const after = foldPhaseAttemptAdmission({
      requirementEvents: [
        ...frozenAtEntry,
        requirementResolved('requirement.security-review', {
          phaseAttemptId: ATTEMPT_TWO,
          requirementSetDigest: SET_DIGEST_B,
          policyVersion: '2.0',
          policyDigest: POLICY_DIGEST_V2,
        }),
      ],
    });

    expect(after.attempts[0]).toEqual(before.attempts[0]);
    expect(after.attempts[0]?.frozenRequirementSet?.policyVersion).toBe('1.0');
    expect(after.attempts[0]?.frozenRequirementSet?.policyDigest).toEqual(
      POLICY_DIGEST_V1,
    );
    expect(after.attempts[1]?.frozenRequirementSet?.policyVersion).toBe('2.0');
    expect(after.integrity).toBe('intact');
  });

  it('PhaseAttemptFold_Reentry_KeepsPerAttemptStateIndependent', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [
        requirementResolved('requirement.typecheck'),
        requirementResolved('requirement.typecheck', {
          phaseAttemptId: ATTEMPT_TWO,
          requirementSetDigest: SET_DIGEST_B,
        }),
      ],
      evidenceEvents: [
        evidenceRecorded('evidence.1', 'requirement.typecheck', { verdict: 'fail' }),
        evidenceRecorded('evidence.2', 'requirement.typecheck', {
          phaseAttemptId: ATTEMPT_TWO,
        }),
      ],
      decisionEvents: [
        transitionDecided('decision.2', {
          phaseAttemptId: ATTEMPT_TWO,
          requirementSetDigest: SET_DIGEST_B,
          evidenceIds: ['evidence.2'],
        }),
      ],
    });

    expect(fold.integrity).toBe('intact');
    expect(fold.attempts.map((attempt) => attempt.phaseAttemptId)).toEqual([
      ATTEMPT_ONE,
      ATTEMPT_TWO,
    ]);

    const first = selectPhaseAttempt(fold, ATTEMPT_ONE);
    const second = selectPhaseAttempt(fold, ATTEMPT_TWO);
    expect(first?.evidence.map((record) => record.evidenceId)).toEqual(['evidence.1']);
    expect(first?.decision).toBeNull();
    expect(second?.evidence.map((record) => record.evidenceId)).toEqual(['evidence.2']);
    expect(second?.decision?.decisionId).toBe('decision.2');
    expect(second?.frozenRequirementSet?.requirementSetDigest).toEqual(SET_DIGEST_B);
  });

  it('PhaseAttemptFold_RefreezeWithinAttempt_KeepsSupersededGenerationAuditable', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [
        requirementResolved('requirement.typecheck'),
        requirementResolved('requirement.security-review', {
          requirementSetDigest: SET_DIGEST_B,
          policyVersion: '2.0',
          policyDigest: POLICY_DIGEST_V2,
        }),
      ],
    });

    const attempt = fold.attempts[0];
    expect(attempt?.requirementSetHistory).toHaveLength(2);
    expect(
      attempt?.requirementSetHistory.map((set) => set.requirementSetDigest.value),
    ).toEqual([SET_DIGEST_A.value, SET_DIGEST_B.value]);
    expect(attempt?.frozenRequirementSet?.requirementIds).toEqual([
      'requirement.security-review',
    ]);
  });

  it('PhaseAttemptFold_IdempotentDuplicateResolution_CollapsesWithoutContest', () => {
    const duplicate = requirementResolved('requirement.typecheck');
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [duplicate, requirementResolved('requirement.typecheck')],
    });

    expect(fold.integrity).toBe('intact');
    expect(fold.attempts[0]?.frozenRequirementSet?.requirements).toHaveLength(1);
  });
});

// ─── Exit proof 3: malformed persisted facts are quarantined ─────────────────

describe('malformed persisted facts are quarantined, never dropped or trusted', () => {
  it('PhaseAttemptFold_MalformedRequirementResolution_IsQuarantinedAndContests', () => {
    const malformed = {
      ...(requirementResolved('requirement.tests') as Record<string, unknown>),
      requirementSetDigest: { algorithm: 'md5', value: 'nope' },
    };

    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [requirementResolved('requirement.typecheck'), malformed],
    });

    expect(fold.integrity).toBe('contested');
    expect(fold.diagnostics).toEqual([
      {
        code: 'MALFORMED_REQUIREMENT_RESOLUTION',
        message:
          'requirement resolution does not satisfy the persisted admission proof schema',
        phaseAttemptId: ATTEMPT_ONE,
        requirementId: 'requirement.tests',
      },
    ]);
    // Quarantined: it never enters the trusted frozen set.
    expect(fold.attempts[0]?.frozenRequirementSet?.requirementIds).toEqual([
      'requirement.typecheck',
    ]);
    expect(fold.attempts[0]?.integrity).toBe('contested');
  });

  it('PhaseAttemptFold_MalformedEvidence_IsQuarantinedAndContests', () => {
    const malformed = {
      eventVersion: '1.0',
      evidence: {
        evidenceId: 'evidence.broken',
        requirementId: 'requirement.typecheck',
        phaseAttemptId: ATTEMPT_ONE,
        // A bare boolean cannot stand in for a gate verdict.
        verdict: true,
      },
    };

    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [requirementResolved('requirement.typecheck')],
      evidenceEvents: [malformed],
    });

    expect(fold.integrity).toBe('contested');
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_EVIDENCE_RECORD',
        phaseAttemptId: ATTEMPT_ONE,
        evidenceId: 'evidence.broken',
      }),
    ]);
    expect(fold.attempts[0]?.evidence).toEqual([]);
    expect(fold.attempts[0]?.integrity).toBe('contested');
  });

  it('PhaseAttemptFold_MalformedDecision_IsQuarantinedAndLeavesNoActiveDecision', () => {
    const malformed = {
      eventVersion: '1.0',
      subject: subject('task.1'),
      decision: {
        ...((transitionDecided('decision.broken') as Record<string, unknown>)
          .decision as Record<string, unknown>),
        // `allow` records may not carry deny-only fields (strict union arms).
        unsatisfiedRequirements: [
          { requirementId: 'requirement.typecheck', reason: 'failed' },
        ],
      },
      caller,
      authorization,
    };

    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [requirementResolved('requirement.typecheck')],
      decisionEvents: [malformed],
    });

    expect(fold.integrity).toBe('contested');
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_TRANSITION_DECISION',
        phaseAttemptId: ATTEMPT_ONE,
        decisionId: 'decision.broken',
      }),
    ]);
    expect(fold.attempts[0]?.decision).toBeNull();
    expect(fold.attempts[0]?.decisionHistory).toEqual([]);
  });

  it('PhaseAttemptFold_UnattributableMalformedFact_StillContestsTheFold', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [undefined, 'not-an-event', { requirement: true }],
    });

    expect(fold.attempts).toEqual([]);
    expect(fold.integrity).toBe('contested');
    expect(fold.diagnostics).toHaveLength(3);
    for (const item of fold.diagnostics) {
      expect(item.code).toBe('MALFORMED_REQUIREMENT_RESOLUTION');
      expect(item.phaseAttemptId).toBeUndefined();
    }
  });

  it('PhaseAttemptFold_DecisionWithoutFrozenRequirementSet_IsNeverActive', () => {
    // Task 019: an entry cannot become actionable without resolved requirements.
    const fold = foldPhaseAttemptAdmission({
      decisionEvents: [transitionDecided('decision.1')],
    });

    expect(fold.attempts[0]?.frozenRequirementSet).toBeNull();
    expect(fold.attempts[0]?.decision).toBeNull();
    expect(fold.attempts[0]?.decisionHistory.map((d) => d.decisionId)).toEqual([
      'decision.1',
    ]);
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'DECISION_REQUIREMENT_SET_MISMATCH',
        decisionId: 'decision.1',
      }),
    ]);
    expect(fold.integrity).toBe('contested');
  });

  it('PhaseAttemptFold_DecisionAgainstSupersededSet_IsNeverActive', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [
        requirementResolved('requirement.typecheck'),
        requirementResolved('requirement.security-review', {
          requirementSetDigest: SET_DIGEST_B,
        }),
      ],
      decisionEvents: [transitionDecided('decision.stale')],
    });

    expect(fold.attempts[0]?.decision).toBeNull();
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'DECISION_REQUIREMENT_SET_MISMATCH',
        decisionId: 'decision.stale',
      }),
    ]);
  });

  it('PhaseAttemptFold_EvidenceOutsideFrozenSet_IsQuarantined', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [requirementResolved('requirement.typecheck')],
      evidenceEvents: [
        evidenceRecorded('evidence.1', 'requirement.typecheck'),
        evidenceRecorded('evidence.rogue', 'requirement.not-frozen'),
      ],
    });

    expect(fold.attempts[0]?.evidence.map((r) => r.evidenceId)).toEqual(['evidence.1']);
    expect(fold.attempts[0]?.unattributedEvidence.map((r) => r.evidenceId)).toEqual([
      'evidence.rogue',
    ]);
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'EVIDENCE_OUTSIDE_FROZEN_REQUIREMENT_SET',
        evidenceId: 'evidence.rogue',
        requirementId: 'requirement.not-frozen',
      }),
    ]);
    expect(fold.attempts[0]?.integrity).toBe('contested');
  });

  it('PhaseAttemptFold_ContradictoryRequirementResolution_ContestsAndKeepsFirst', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [
        requirementResolved('requirement.typecheck', { gateId: 'gate.original' }),
        requirementResolved('requirement.typecheck', { gateId: 'gate.rewritten' }),
      ],
    });

    expect(fold.integrity).toBe('contested');
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CONTRADICTORY_REQUIREMENT_RESOLUTION',
        requirementId: 'requirement.typecheck',
        phaseAttemptId: ATTEMPT_ONE,
      }),
    ]);
    const requirements = fold.attempts[0]?.frozenRequirementSet?.requirements ?? [];
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.kind).toBe('gate-evidence');
    expect(
      requirements[0]?.kind === 'gate-evidence' ? requirements[0].gateId : null,
    ).toBe('gate.original');
  });

  it('PhaseAttemptFold_InconsistentSetProvenance_ContestsTheAttempt', () => {
    const fold = foldPhaseAttemptAdmission({
      requirementEvents: [
        requirementResolved('requirement.typecheck'),
        // Same set digest, different policy identity — the set is not coherent.
        requirementResolved('requirement.tests', { policyDigest: POLICY_DIGEST_V2 }),
      ],
    });

    expect(fold.integrity).toBe('contested');
    expect(fold.diagnostics).toEqual([
      expect.objectContaining({
        code: 'INCONSISTENT_REQUIREMENT_SET_PROVENANCE',
        requirementId: 'requirement.tests',
      }),
    ]);
    expect(fold.attempts[0]?.integrity).toBe('contested');
  });
});

// ─── Parse, don't cast ───────────────────────────────────────────────────────

describe('attempt selection parses identity instead of trusting it', () => {
  it('PhaseAttemptSelect_UnvalidatedIdentity_SelectsNothing', () => {
    const fold = foldPhaseAttemptAdmission(intactHistory());

    expect(selectPhaseAttempt(fold, ATTEMPT_ONE)?.phaseAttemptId).toBe(ATTEMPT_ONE);
    // Values that cannot be a branded phase-attempt id never select an attempt.
    expect(selectPhaseAttempt(fold, '')).toBeNull();
    expect(selectPhaseAttempt(fold, '  phase-attempt.plan.1  ')).toBeNull();
    expect(selectPhaseAttempt(fold, '../../etc/passwd')).toBeNull();
    expect(selectPhaseAttempt(fold, undefined)).toBeNull();
    expect(selectPhaseAttempt(fold, 42)).toBeNull();
    expect(selectPhaseAttempt(fold, { phaseAttemptId: ATTEMPT_ONE })).toBeNull();
    expect(selectPhaseAttempt(fold, 'phase-attempt.plan.unknown')).toBeNull();
  });
});

// ─── Projection integration: the canonical workflow-state fold ───────────────

function event(sequence: number, type: string, data: unknown): WorkflowEvent {
  return {
    streamId: 'feature-p01-04',
    sequence,
    timestamp: AT,
    type,
    schemaVersion: '1.0',
    ...(data === undefined || data === null || typeof data !== 'object'
      ? {}
      : { data: { ...data } }),
  };
}

describe('WorkflowProjection replay reconstructs the active attempt', () => {
  const log: readonly WorkflowEvent[] = [
    event(1, 'workflow.started', {
      featureId: 'feature-p01-04',
      workflowType: 'feature',
      phaseAttemptId: ATTEMPT_ONE,
    }),
    event(2, 'admission.requirement-resolved', requirementResolved('requirement.typecheck')),
    event(3, 'admission.evidence-recorded', evidenceRecorded('evidence.1', 'requirement.typecheck')),
    event(4, 'admission.transition-decided', transitionDecided('decision.1')),
    event(5, 'workflow.transition', { to: 'plan-review', phaseAttemptId: ATTEMPT_TWO }),
    event(
      6,
      'admission.requirement-resolved',
      requirementResolved('requirement.security-review', {
        phaseAttemptId: ATTEMPT_TWO,
        requirementSetDigest: SET_DIGEST_B,
        policyVersion: '2.0',
        policyDigest: POLICY_DIGEST_V2,
      }),
    ),
    event(
      7,
      'admission.evidence-recorded',
      evidenceRecorded('evidence.2', 'requirement.security-review', {
        phaseAttemptId: ATTEMPT_TWO,
      }),
    ),
  ];

  it('WorkflowProjection_Replay_MatchesLiveState', () => {
    const first = log.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );
    const second = log.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );

    expect(second.admissionProof).toEqual(first.admissionProof);
    expect(second.phaseAttemptId).toBe(first.phaseAttemptId);

    // The incremental projection fold agrees with a from-zero fold of the
    // same persisted payloads — one reconstruction, not two.
    const direct = foldPhaseAttemptAdmission({
      requirementEvents: first.admissionProof.requirementHistory,
      evidenceEvents: first.admissionProof.evidenceHistory,
      decisionEvents: first.admissionProof.decisionHistory,
    });
    expect(first.admissionProof.phaseAttempts).toEqual(direct.attempts);
    expect(first.admissionProof.phaseAttemptIntegrity).toBe('intact');
    expect(first.admissionProof.phaseAttemptDiagnostics).toEqual([]);

    // …and the agreed reconstruction is the non-trivial one the log describes,
    // so an empty fold on both sides cannot satisfy this test.
    expect(
      first.admissionProof.phaseAttempts.map((attempt) => attempt.phaseAttemptId),
    ).toEqual([ATTEMPT_ONE, ATTEMPT_TWO]);
    expect(
      first.admissionProof.phaseAttempts.map((attempt) => [
        attempt.frozenRequirementSet?.requirementIds,
        attempt.evidence.map((record) => record.evidenceId),
        attempt.decision?.decisionId ?? null,
      ]),
    ).toEqual([
      [['requirement.typecheck'], ['evidence.1'], 'decision.1'],
      [['requirement.security-review'], ['evidence.2'], null],
    ]);
  });

  it('WorkflowProjection_Reentry_ReconstructsActiveAttemptRequirementsAndDecision', () => {
    const view = log.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );

    // The active attempt is the one the lifecycle events froze, and it is a
    // DIFFERENT identity from the initial entry.
    expect(view.phaseAttemptId).toBe(ATTEMPT_TWO);
    expect(ATTEMPT_TWO).not.toBe(ATTEMPT_ONE);

    const fold = {
      attempts: view.admissionProof.phaseAttempts,
      diagnostics: view.admissionProof.phaseAttemptDiagnostics,
      integrity: view.admissionProof.phaseAttemptIntegrity,
    };

    const active = selectPhaseAttempt(fold, view.phaseAttemptId);
    expect(active?.phaseAttemptId).toBe(ATTEMPT_TWO);
    expect(active?.frozenRequirementSet?.requirementIds).toEqual([
      'requirement.security-review',
    ]);
    expect(active?.evidence.map((record) => record.evidenceId)).toEqual(['evidence.2']);
    expect(active?.decision).toBeNull();

    // The superseded attempt keeps its own frozen set, evidence, and decision.
    const previous = selectPhaseAttempt(fold, ATTEMPT_ONE);
    expect(previous?.frozenRequirementSet?.requirementIds).toEqual([
      'requirement.typecheck',
    ]);
    expect(previous?.frozenRequirementSet?.policyVersion).toBe('1.0');
    expect(previous?.evidence.map((record) => record.evidenceId)).toEqual(['evidence.1']);
    expect(previous?.decision?.decisionId).toBe('decision.1');
  });

  it('WorkflowProjection_PrefixFold_IsAPrefixOfTheFullReconstruction', () => {
    const afterFirstAttempt = log.slice(0, 4).reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );

    expect(afterFirstAttempt.admissionProof.phaseAttempts).toHaveLength(1);
    expect(afterFirstAttempt.admissionProof.phaseAttempts[0]?.decision?.decisionId).toBe(
      'decision.1',
    );

    const full = log.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );
    expect(full.admissionProof.phaseAttempts[0]).toEqual(
      afterFirstAttempt.admissionProof.phaseAttempts[0],
    );
  });

  it('WorkflowProjection_MalformedAdmissionFact_DegradesInsteadOfThrowing', () => {
    const view = [
      event(1, 'admission.requirement-resolved', requirementResolved('requirement.typecheck')),
      event(2, 'admission.requirement-resolved', { requirement: { phaseAttemptId: ATTEMPT_ONE } }),
    ].reduce(workflowStateProjection.apply, workflowStateProjection.init());

    expect(view.admissionProof.phaseAttemptIntegrity).toBe('contested');
    expect(view.admissionProof.phaseAttemptDiagnostics).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_REQUIREMENT_RESOLUTION',
        phaseAttemptId: ATTEMPT_ONE,
      }),
    ]);
    expect(
      view.admissionProof.phaseAttempts[0]?.frozenRequirementSet?.requirementIds,
    ).toEqual(['requirement.typecheck']);
  });

  it('WorkflowProjection_PreP0104State_AcceptsAttemptFactsWithoutBackfill', () => {
    const seeded = workflowStateProjection.init();
    // A state persisted before P01-04 carries the evidence slots only.
    const legacy = {
      ...seeded,
      admissionProof: {
        evidenceHistory: [],
        contradictionHistory: [],
        activeEvidence: [],
        supersessions: [],
        contradictions: [],
        diagnostics: [],
      },
    };

    const view = workflowStateProjection.apply(
      { ...seeded, ...legacy },
      event(1, 'admission.requirement-resolved', requirementResolved('requirement.typecheck')),
    );

    expect(view.admissionProof.requirementHistory).toHaveLength(1);
    expect(view.admissionProof.phaseAttempts[0]?.phaseAttemptId).toBe(ATTEMPT_ONE);
    expect(view.admissionProof.phaseAttemptIntegrity).toBe('intact');
  });
});
