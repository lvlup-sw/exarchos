// Tests for the durable shadow evidence reader. The reader folds each
// `<featureId>/admission-shadow` sidecar stream and ignores other streams. An
// empty store reads as no evidence, which leaves gate conditions unmet. Each
// durable disagreement takes its latest `admission.disagreement-disposition`
// row, and a disagreement with no row is `unexplained`.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../../../src/events/store.js';
import {
  ALL_PHASE_KINDS,
  MINIMUM_LIVE_ATTEMPTS,
  evaluateCutoverGate,
  type LiveShadowAttempt,
} from '../../../../src/workflow/admission/cutover-gate.js';
import {
  assembleCutoverGateEvidence,
  listShadowEvidenceFeatureIds,
  readDurableShadowEvidence,
  readPersistedEvidence,
  type PersistedEvidenceSource,
  type ShadowEvidenceSource,
} from '../../../../src/workflow/admission/evidence-reader.js';
import { ADMISSION_EVENT_TYPES } from '../../../../src/workflow/admission/types.js';
import type { LiveShadowHealth } from '../../../../src/workflow/admission/live-shadow-observer.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const AT = '2026-07-21T20:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const digest = () => ({ algorithm: 'sha256' as const, value: SHA_A });

const caller = {
  principalKind: 'service' as const,
  principalId: 'exarchos.live-shadow-observer',
  role: 'shadow-observer',
};
const authorization = {
  authorizationId: 'live-shadow-observer:process',
  posture: 'read-only' as const,
  capabilityIds: ['admission:shadow-observe'],
  resolverVersion: '1.0',
  resolvedAt: AT,
};

/** A schema-valid `admission.shadow-attempt` event row. */
function shadowAttemptEvent(
  shadowAttemptId: string,
  legacyOutcome: 'allow' | 'deny',
  outcome: 'allow' | 'deny' | 'indeterminate',
): { type: string; data: Record<string, unknown> } {
  return {
    type: 'admission.shadow-attempt',
    data: {
      eventVersion: '1.0',
      shadowAttemptId,
      operationId: 'op-1',
      phaseAttemptId: 'pa-1',
      legacyOutcome,
      subject: { kind: 'phase-attempt', phaseAttemptId: 'pa-1', digest: digest() },
      evidenceSetDigest: digest(),
      decision: {
        contractVersion: '1.0',
        decisionId: `shadow-decision:${shadowAttemptId}`,
        operationId: 'op-1',
        phaseAttemptId: 'pa-1',
        policyId: 'policy.legacy-state-translation',
        policyVersion: '1.0',
        policyDigest: digest(),
        requirementSetDigest: digest(),
        inputDigest: digest(),
        evidenceIds: [],
        waiverIds: [],
        decidedAt: AT,
        ...(outcome === 'allow'
          ? { outcome, satisfiedRequirementIds: [], waivedRequirementIds: [] }
          : outcome === 'deny'
            ? {
                outcome,
                satisfiedRequirementIds: [],
                unsatisfiedRequirements: [
                  { requirementId: 'route:x', reason: 'failed' },
                ],
                remediation: [
                  { action: 'retry_transition', phaseAttemptId: 'pa-1' },
                ],
              }
            : {
                outcome,
                unresolvedRequirementIds: ['route:x'],
                errors: [{ code: 'EVALUATOR_FAILED', message: 'threw' }],
                remediation: [
                  { action: 'retry_transition', phaseAttemptId: 'pa-1' },
                ],
              }),
      },
      attemptedAt: AT,
      caller,
      authorization,
    },
  };
}

/** A schema-valid `admission.disagreement-disposition` event row. */
function dispositionEvent(
  shadowAttemptId: string,
  disposition:
    | 'explained-legacy'
    | 'explained-admission'
    | 'accepted-risk'
    | 'unexplained',
): { type: string; data: Record<string, unknown> } {
  return {
    type: 'admission.disagreement-disposition',
    data: {
      eventVersion: '1.0',
      dispositionId: `disagreement-disposition:${shadowAttemptId}:${disposition}`,
      shadowAttemptId,
      disposition,
      rationale: 'test disposition',
      recordedAt: AT,
      caller,
      authorization,
    },
  };
}

/** A fake single-store source over a map of stream → rows. */
function fakeSource(
  streams: Record<string, readonly { type: string; data: Record<string, unknown> }[]>,
): ShadowEvidenceSource {
  return {
    listStreams: () => Object.keys(streams),
    query: async (streamId, filters) =>
      (streams[streamId] ?? []).filter(
        (row) => filters?.type === undefined || row.type === filters.type,
      ),
  };
}

/** Comparable live attempts covering every phase kind and both outcomes. */
function satisfiableLiveAttempts(): readonly LiveShadowAttempt[] {
  const attempts: LiveShadowAttempt[] = [];
  for (const phaseKind of ALL_PHASE_KINDS) {
    attempts.push(
      { phaseKind, outcome: 'allow', disagreementClass: 'agree' },
      { phaseKind, outcome: 'deny', disagreementClass: 'agree' },
    );
  }
  while (attempts.length < MINIMUM_LIVE_ATTEMPTS) {
    attempts.push({
      phaseKind: 'IMPLEMENT',
      outcome: 'allow',
      disagreementClass: 'agree',
    });
  }
  return attempts;
}

function healthyObserver(): LiveShadowHealth {
  const observed = satisfiableLiveAttempts().length;
  return {
    attemptsObserved: observed,
    appendsScheduled: observed,
    appendsSucceeded: observed,
    appendsFailed: 0,
    streamUnresolved: 0,
    observationsThrew: 0,
  };
}

describe('EvidenceReader — sidecar enumeration and fold', () => {
  /** The decoy disagreement on the feature stream does not count, because only sidecar streams contribute evidence. */
  it('EvidenceReader_MultipleSidecarStreams_FoldsAllComparableAttempts', async () => {
    const source = fakeSource({
      'feat-a/admission-shadow': [
        shadowAttemptEvent('shadow-attempt:a1', 'allow', 'allow'),
        shadowAttemptEvent('shadow-attempt:a2', 'deny', 'deny'),
      ],
      'feat-b/admission-shadow': [
        shadowAttemptEvent('shadow-attempt:b1', 'allow', 'allow'),
      ],
      'feat-a': [shadowAttemptEvent('shadow-attempt:decoy', 'allow', 'deny')],
      'exarchos-doctor': [],
    });

    expect(listShadowEvidenceFeatureIds(source)).toEqual(['feat-a', 'feat-b']);

    const durable = await readDurableShadowEvidence(source);
    expect(durable.featureIds).toEqual(['feat-a', 'feat-b']);
    expect(durable.attempts.map((a) => a.disagreementClass)).toEqual([
      'agree',
      'agree',
      'agree',
    ]);
    expect(durable.dispositionTally.agree).toBe(3);
    expect(durable.dispositionTally.unexplained).toBe(0);
  });

  it('EvidenceReader_UnreadableRow_IsDroppedNotDefaulted', async () => {
    const source = fakeSource({
      'feat-a/admission-shadow': [
        shadowAttemptEvent('shadow-attempt:a1', 'allow', 'allow'),
        { type: 'admission.shadow-attempt', data: { nonsense: true } },
      ],
    });
    const durable = await readDurableShadowEvidence(source);
    expect(durable.attempts).toHaveLength(1);
  });

  /**
   * A disagreement with no disposition row folds as unexplained, and the later
   * of two rows wins. The unexplained disagreement blocks the corpus condition
   * even when each live condition is met.
   */
  it('EvidenceReader_UndisposedDisagreement_FoldsAsUnexplained_LatestDispositionWins', async () => {
    const source = fakeSource({
      'feat-a/admission-shadow': [
        shadowAttemptEvent('shadow-attempt:d1', 'allow', 'deny'),
        shadowAttemptEvent('shadow-attempt:d2', 'deny', 'allow'),
        dispositionEvent('shadow-attempt:d2', 'unexplained'),
        dispositionEvent('shadow-attempt:d2', 'explained-legacy'),
      ],
    });
    const durable = await readDurableShadowEvidence(source);
    expect(durable.dispositionTally.unexplained).toBe(1);
    expect(durable.dispositionTally['explained-legacy']).toBe(1);

    const { evidence } = await assembleCutoverGateEvidence(source, {
      liveAttempts: satisfiableLiveAttempts(),
      observerHealth: healthyObserver(),
    });
    const report = evaluateCutoverGate(evidence);
    expect(report.satisfied).toBe(false);
    expect(report.unmet).toContain('deterministic-corpus-clean');
  });
});

describe('EvidenceReader — empty store semantics', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'exarchos-evidence-reader-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  /**
   * With no durable evidence, "no disagreements" and "the observer never ran"
   * look the same. So an empty store must block even when each live condition
   * is met.
   */
  it('EvidenceReader_EmptyStore_ReportsNoEvidenceNotCleanEvidence', async () => {
    const durable = await readDurableShadowEvidence(eventStore);
    expect(durable.featureIds).toEqual([]);
    expect(durable.attempts).toEqual([]);
    expect(durable.decisions).toEqual([]);

    const { evidence } = await assembleCutoverGateEvidence(eventStore, {
      liveAttempts: satisfiableLiveAttempts(),
      observerHealth: healthyObserver(),
    });
    const report = evaluateCutoverGate(evidence);
    expect(report.satisfied).toBe(false);
    expect(report.unmet).toContain('live-disagreement-class');
    expect(report.durableAttemptCount).toBe(0);
  });
});

const GATE_DIGEST = { algorithm: 'sha256' as const, value: 'b'.repeat(64) };

/** A schema-valid `admission.evidence-recorded` row, with an overridable subject. */
function gateEvidenceRow(
  operationId: string,
  options?: {
    readonly subject?: Record<string, unknown>;
    readonly artifactRefs?: readonly unknown[];
  },
): { type: string; operationId: string; data: Record<string, unknown> } {
  return {
    type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    operationId,
    data: {
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        evidenceId: `evidence.${operationId}`,
        requirementId: 'requirement.typecheck',
        phaseAttemptId: 'phase-attempt.1',
        subject: options?.subject ?? { kind: 'task', taskId: 'task.1', digest: GATE_DIGEST },
        producer: {
          producerId: 'producer.gate-runner',
          providerRef: 'provider.static-analysis',
          providerVersion: '1.3.0',
          invocationId: `invocation.${operationId}`,
        },
        policyId: 'policy.transition',
        policyDigest: GATE_DIGEST,
        contentDigest: GATE_DIGEST,
        createdAt: '2026-08-22T00:00:00.000Z',
        kind: 'gate',
        verdict: 'pass',
        ...(options?.artifactRefs === undefined ? {} : { artifactRefs: options.artifactRefs }),
      },
    },
  };
}

/** A single-stream `PersistedEvidenceSource` over a fixed row set. */
function persistedSource(
  rows: readonly { type: string; operationId: string; data: Record<string, unknown> }[],
): PersistedEvidenceSource {
  return {
    query: async (_streamId, filters) =>
      rows.filter(
        (row) =>
          (filters?.type === undefined || row.type === filters.type) &&
          (filters?.operationId === undefined || row.operationId === filters.operationId),
      ),
  };
}

const ARTIFACT_REF = {
  contractVersion: '1.0' as const,
  subject: { kind: 'artifact' as const, artifactId: 'artifact.report-1', digest: GATE_DIGEST },
  mediaType: 'application/json',
  byteLength: 42,
};

describe('readPersistedEvidence — the observation the durable-evidence ensure reads', () => {
  /** The list is empty, not undefined, so a caller that checks `.length` gets one answer for an omitted field and an empty array. */
  it('EvidenceReader_RowWithNoArtifactRefs_ObservesEmptyList', async () => {
    const source = persistedSource([gateEvidenceRow('op-1')]);

    const observed = await readPersistedEvidence(source, {
      streamId: 'feature-x',
      operationId: 'op-1',
      evidenceType: 'gate',
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.artifactRefs).toEqual([]);
  });

  it('EvidenceReader_RowWithArtifactRefs_CarriesThemAndTheSubject', async () => {
    const subject = { kind: 'task' as const, taskId: 'task.report', digest: GATE_DIGEST };
    const source = persistedSource([
      gateEvidenceRow('op-2', { subject, artifactRefs: [ARTIFACT_REF] }),
    ]);

    const observed = await readPersistedEvidence(source, {
      streamId: 'feature-x',
      operationId: 'op-2',
      evidenceType: 'gate',
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.subject).toEqual(subject);
    expect(observed[0]?.artifactRefs).toEqual([ARTIFACT_REF]);
  });

  /**
   * `EvidenceArtifactReferenceV1Schema` needs an artifact-kind subject. A task
   * subject fails the row-level `safeParse`, so the reader drops the row like
   * any unreadable payload.
   */
  it('EvidenceReader_RowWhoseReferenceNamesANonArtifactSubject_IsDropped', async () => {
    const malformedRef = {
      ...ARTIFACT_REF,
      subject: { kind: 'task', taskId: 'task.wrong-kind', digest: GATE_DIGEST },
    };
    const source = persistedSource([
      gateEvidenceRow('op-3', { artifactRefs: [malformedRef] }),
    ]);

    const observed = await readPersistedEvidence(source, {
      streamId: 'feature-x',
      operationId: 'op-3',
      evidenceType: 'gate',
    });

    expect(observed).toEqual([]);
  });
});
