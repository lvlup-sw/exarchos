// ─── P07-04 exit-proof (c) — admission replay harness ────────────────────────
//
// Replay is the P01-04 / P06-07 guarantee that a phase attempt's admission
// state is reconstructable from persisted facts ALONE — no live policy, no
// clock, no store handle. `foldPhaseAttemptAdmission` is that reconstruction.
// This harness builds well-formed admission event streams two ways:
//
//   1. `handBuiltIntactHistory` — a multi-attempt history hand-authored against
//      the persisted schemas (the shape `phase-attempt-state.test.ts` proves
//      folds to `integrity: 'intact'`);
//   2. `historyFromScenario` — a history DERIVED from the live admission
//      contract: it freezes a real corpus scenario (`resolveRequirements` →
//      `freezeRequirements`) and persists those exact frozen requirement records
//      + the scenario's evidence + a matching decision. This ties the replay
//      proof to the same freeze the benchmark and CTK exercise, so a drift in
//      the frozen-record shape breaks replay too.
//
// Everything here is a pure function of its inputs — the property the replay
// suite asserts.

import { resolveRequirements } from '../../../../../src/workflow/admission/requirement-resolution.js';
import { freezeRequirements } from '../../../../../src/workflow/admission/freeze-requirements.js';
import { ADMISSION_RUNTIME_CONTRACT_VERSION } from '../../../../../src/workflow/admission/types.js';
import type { PhaseAttemptAdmissionFoldInput } from '../../../../../src/workflow/admission/phase-attempt-state.js';
import type { AdmissionScenario } from './admission-decision-path.js';

// ─── Shared persisted-envelope constants ─────────────────────────────────────

const AT = '2026-07-21T19:00:00.000Z';
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
const digest = (seed: string) =>
  ({ algorithm: 'sha256' as const, value: hex(seed) }) as const;

const POLICY_ID = 'policy.transition';
const POLICY_VERSION = '1.0';
const POLICY_DIGEST = digest('1');
const INPUT_DIGEST = digest('3');
const SET_DIGEST_A = digest('a');

const CALLER = {
  principalKind: 'agent' as const,
  principalId: 'principal.orchestrator',
  role: 'orchestrator',
} as const;

const AUTHORIZATION = {
  authorizationId: 'authorization.1',
  posture: 'task-isolated' as const,
  capabilityIds: ['capability.decide-transition'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;

const SUBJECT = { kind: 'task' as const, taskId: 'task.1', digest: digest('d') };

// ─── Hand-built persisted payloads (mirror the proven recipe) ────────────────

interface RequirementOptions {
  readonly phaseAttemptId?: string;
  readonly requirementSetDigest?: { algorithm: 'sha256'; value: string };
}

export function requirementResolvedEvent(
  requirementId: string,
  options: RequirementOptions = {},
): unknown {
  return {
    eventVersion: '1.0',
    resolutionId: `resolution.${requirementId}`,
    operationId: 'operation.1',
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    policyDigest: POLICY_DIGEST,
    requirementSetDigest: options.requirementSetDigest ?? SET_DIGEST_A,
    inputDigest: INPUT_DIGEST,
    resolvedAt: AT,
    requirement: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      requirementId,
      phaseAttemptId: options.phaseAttemptId ?? 'phase-attempt.plan.1',
      subject: SUBJECT,
      kind: 'gate-evidence',
      gateId: `gate.${requirementId}`,
    },
  };
}

export function evidenceRecordedEvent(
  evidenceId: string,
  requirementId: string,
  options: { readonly phaseAttemptId?: string } = {},
): unknown {
  return {
    eventVersion: '1.0',
    evidence: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      evidenceId,
      requirementId,
      phaseAttemptId: options.phaseAttemptId ?? 'phase-attempt.plan.1',
      subject: SUBJECT,
      producer: {
        producerId: 'producer.gate-runner',
        providerRef: 'provider.static-analysis',
        providerVersion: '1.3.0',
        invocationId: `invocation.${evidenceId}`,
      },
      policyId: POLICY_ID,
      policyDigest: POLICY_DIGEST,
      contentDigest: digest('c'),
      createdAt: AT,
      kind: 'gate',
      verdict: 'pass',
    },
  };
}

export function transitionDecidedEvent(
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
    subject: SUBJECT,
    decision: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      decisionId,
      operationId: 'operation.1',
      phaseAttemptId: options.phaseAttemptId ?? 'phase-attempt.plan.1',
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      policyDigest: POLICY_DIGEST,
      requirementSetDigest: options.requirementSetDigest ?? SET_DIGEST_A,
      inputDigest: INPUT_DIGEST,
      evidenceIds: options.evidenceIds ?? ['evidence.1'],
      waiverIds: [],
      decidedAt: AT,
      outcome: 'allow',
      satisfiedRequirementIds:
        options.satisfiedRequirementIds ?? ['requirement.typecheck'],
      waivedRequirementIds: [],
    },
    caller: CALLER,
    authorization: AUTHORIZATION,
  };
}

/** A complete, well-formed TWO-attempt history — reconstructs to intact. */
export function handBuiltIntactHistory(): PhaseAttemptAdmissionFoldInput {
  const ONE = 'phase-attempt.plan.1';
  const TWO = 'phase-attempt.plan.2';
  return {
    requirementEvents: [
      requirementResolvedEvent('requirement.typecheck', { phaseAttemptId: ONE }),
      requirementResolvedEvent('requirement.tests', { phaseAttemptId: ONE }),
      requirementResolvedEvent('requirement.lint', { phaseAttemptId: TWO }),
    ],
    evidenceEvents: [
      evidenceRecordedEvent('evidence.1', 'requirement.typecheck', {
        phaseAttemptId: ONE,
      }),
      evidenceRecordedEvent('evidence.2', 'requirement.tests', {
        phaseAttemptId: ONE,
      }),
      evidenceRecordedEvent('evidence.3', 'requirement.lint', {
        phaseAttemptId: TWO,
      }),
    ],
    decisionEvents: [
      transitionDecidedEvent('decision.1', {
        phaseAttemptId: ONE,
        satisfiedRequirementIds: ['requirement.typecheck', 'requirement.tests'],
        evidenceIds: ['evidence.1', 'evidence.2'],
      }),
      transitionDecidedEvent('decision.2', {
        phaseAttemptId: TWO,
        satisfiedRequirementIds: ['requirement.lint'],
        evidenceIds: ['evidence.3'],
      }),
    ],
  };
}

// ─── History derived from the LIVE admission freeze ──────────────────────────

/**
 * Build a persisted admission history from a real corpus scenario by freezing
 * its resolved requirement lattice and persisting those exact frozen records,
 * the scenario's supplied evidence, and a matching `allow` decision. The frozen
 * requirement set digest and requirement records come straight from
 * `freezeRequirements`, so the replay proof is bound to the live freeze.
 */
export function historyFromScenario(
  scenario: AdmissionScenario,
): PhaseAttemptAdmissionFoldInput {
  const resolved = resolveRequirements(scenario.requirementContext);
  const frozen = freezeRequirements({
    resolved,
    phaseAttemptId: scenario.phaseAttemptId,
    subject: scenario.subject,
    ...(scenario.approvalClass !== undefined
      ? { approvalClass: scenario.approvalClass }
      : {}),
  });

  const requirementEvents = frozen.requirements.map((requirement, index) => ({
    eventVersion: '1.0',
    resolutionId: `resolution.${scenario.name}.${index}`.replace(
      /[^A-Za-z0-9._:-]/g,
      '-',
    ),
    operationId: 'operation.1',
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    policyDigest: POLICY_DIGEST,
    requirementSetDigest: frozen.requirementSetDigest,
    inputDigest: INPUT_DIGEST,
    resolvedAt: AT,
    requirement,
  }));

  const evidenceEvents = scenario.activeEvidence.map((evidence) => ({
    eventVersion: '1.0',
    evidence,
  }));

  const decisionEvents = [
    {
      eventVersion: '1.0',
      subject: scenario.subject,
      decision: {
        contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
        decisionId: `decision.${scenario.name}`.replace(
          /[^A-Za-z0-9._:-]/g,
          '-',
        ),
        operationId: 'operation.1',
        phaseAttemptId: scenario.phaseAttemptId,
        policyId: POLICY_ID,
        policyVersion: POLICY_VERSION,
        policyDigest: POLICY_DIGEST,
        requirementSetDigest: frozen.requirementSetDigest,
        inputDigest: INPUT_DIGEST,
        evidenceIds: scenario.activeEvidence.map((e) => e.evidenceId),
        waiverIds: [],
        decidedAt: AT,
        outcome: 'allow',
        satisfiedRequirementIds: frozen.requirements.map((r) => r.requirementId),
        waivedRequirementIds: [],
      },
      caller: CALLER,
      authorization: AUTHORIZATION,
    },
  ];

  return { requirementEvents, evidenceEvents, decisionEvents };
}

// ─── Serialization + permutation utilities for the replay properties ─────────

/** Round-trip a history through JSON — the persisted-stream boundary. */
export function serializeHistory(history: PhaseAttemptAdmissionFoldInput): string {
  return JSON.stringify(history);
}

export function deserializeHistory(json: string): PhaseAttemptAdmissionFoldInput {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('replay: serialized history must be an object');
  }
  return parsed as PhaseAttemptAdmissionFoldInput;
}

/**
 * Re-key the fold input object so the three streams are presented in a
 * different property order. The fold processes streams in a fixed internal
 * order, so this must not change reconstruction — the "cross-stream order does
 * not privilege any stream" property.
 */
export function reorderStreams(
  history: PhaseAttemptAdmissionFoldInput,
): PhaseAttemptAdmissionFoldInput {
  const reordered: PhaseAttemptAdmissionFoldInput = {};
  return {
    ...reordered,
    ...(history.decisionEvents !== undefined
      ? { decisionEvents: history.decisionEvents }
      : {}),
    ...(history.evidenceEvents !== undefined
      ? { evidenceEvents: history.evidenceEvents }
      : {}),
    ...(history.requirementEvents !== undefined
      ? { requirementEvents: history.requirementEvents }
      : {}),
  };
}

/**
 * Tamper with the first decision's requirement-set digest. A faithful replay
 * MUST refuse to attribute this decision to the frozen set — it is the negative
 * control that proves the intact assertions are not vacuous.
 */
export function tamperDecisionDigest(
  history: PhaseAttemptAdmissionFoldInput,
): PhaseAttemptAdmissionFoldInput {
  const decisions = [...(history.decisionEvents ?? [])];
  const first = decisions[0];
  if (first === null || typeof first !== 'object') {
    throw new Error('replay: history has no decision to tamper');
  }
  const record = first as {
    readonly decision: { readonly requirementSetDigest: unknown };
  };
  const tampered = {
    ...record,
    decision: {
      ...record.decision,
      requirementSetDigest: digest('f'),
    },
  };
  decisions[0] = tampered;
  return { ...history, decisionEvents: decisions };
}
