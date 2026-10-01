// The production `DurableShadowEvidenceReader` over one local store. It finds
// the `<featureId>/admission-shadow` sidecar streams through `listStreams()`,
// with no raw SQL. It folds the `admission.shadow-attempt` rows into
// gate facts and pairs each attempt with its latest disposition row. Then
// {@link assembleCutoverGateEvidence} gives both to `evaluateCutoverGate`.
//
// An empty store gives no evidence, never clean evidence. The fold drops a row
// that fails schema validation. It never defaults that row to `agree`, because
// unreadable evidence is not evidence.

import { createHash } from 'node:crypto';

import {
  AdmissionDisagreementDispositionData,
  AdmissionEvidenceRecordedData,
  AdmissionShadowAttemptData,
} from '../../events/schemas.js';
import {
  evaluateCutoverGate,
  type CutoverGateEvidence,
  type CutoverGateReport,
  type DurableShadowAttemptFact,
  type DurableShadowEvidenceReader,
  type LiveShadowAttempt,
} from './cutover-gate.js';
import {
  LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT,
  type LiveShadowHealth,
} from './live-shadow-observer.js';
import {
  classifyShadowOutcome,
  isDisagreement,
  type DisagreementDisposition,
  type ShadowDispositionView,
} from './shadow-decision.js';
import {
  ADMISSION_EVENT_TYPES,
  ContentDigestV1Schema,
  type ContentDigestV1,
  type EvidenceArtifactReferenceV1,
  type EvidenceSubjectV1,
} from './types.js';

/**
 * The read slice of one local store: the query contract of the gate plus stream
 * enumeration. `EventStore` satisfies it structurally, so this module issues no
 * raw SQL.
 */
export interface ShadowEvidenceSource extends DurableShadowEvidenceReader {
  listStreams(): string[];
}

/** The `/`-suffixed sidecar marker every shadow evidence stream ends with. */
const SIDECAR_SUFFIX = `/${LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT}`;

/**
 * Enumerate the featureIds that own a `<featureId>/admission-shadow` sidecar
 * stream in this store. The result is sorted. An empty store gives `[]`.
 */
export function listShadowEvidenceFeatureIds(
  source: Pick<ShadowEvidenceSource, 'listStreams'>,
): readonly string[] {
  const seen = new Set<string>();
  for (const streamId of source.listStreams()) {
    if (!streamId.endsWith(SIDECAR_SUFFIX)) continue;
    const featureId = streamId.slice(0, -SIDECAR_SUFFIX.length);
    if (featureId.length === 0) continue;
    seen.add(featureId);
  }
  return [...seen].sort();
}

/** The folded reading of one store's durable shadow substrate. */
export interface DurableShadowEvidence {
  /** Feature ids that own a sidecar evidence stream (sorted). */
  readonly featureIds: readonly string[];
  /** The gate's `durableAttempts` substrate — one fact per readable row. */
  readonly attempts: readonly DurableShadowAttemptFact[];
  /**
   * The view that `summarizeShadowDecisions` folds: each attempt with its latest
   * recorded disposition. An agreement carries the `agree` sentinel. A
   * disagreement with no disposition row is `unexplained`, and it blocks the
   * gate until a human records an `admission.disagreement-disposition`.
   */
  readonly decisions: readonly ShadowDispositionView[];
  /** Count per disposition across {@link decisions}. Every key is always present. */
  readonly dispositionTally: Readonly<Record<DisagreementDisposition, number>>;
}

/**
 * Read and fold the durable shadow evidence for every sidecar stream in the
 * store. Each stream gets two typed queries, dispositions and then attempts,
 * matched on `shadowAttemptId`. The latest disposition row wins, because stream
 * order is append order. The tally holds every key, also for an empty store.
 */
export async function readDurableShadowEvidence(
  source: ShadowEvidenceSource,
): Promise<DurableShadowEvidence> {
  const featureIds = listShadowEvidenceFeatureIds(source);

  const attempts: DurableShadowAttemptFact[] = [];
  const decisions: ShadowDispositionView[] = [];
  const tally: Record<DisagreementDisposition, number> = {
    'agree': 0,
    'explained-legacy': 0,
    'explained-admission': 0,
    'accepted-risk': 0,
    'unexplained': 0,
  };

  for (const featureId of featureIds) {
    const streamId = `${featureId}${SIDECAR_SUFFIX}`;

    const dispositionRows = await source.query(streamId, {
      type: ADMISSION_EVENT_TYPES.DISAGREEMENT_DISPOSITION,
    });
    const latestDisposition = new Map<string, DisagreementDisposition>();
    for (const row of dispositionRows) {
      if (row.type !== ADMISSION_EVENT_TYPES.DISAGREEMENT_DISPOSITION) continue;
      const parsed = AdmissionDisagreementDispositionData.safeParse(row.data);
      if (!parsed.success) continue;
      latestDisposition.set(parsed.data.shadowAttemptId, parsed.data.disposition);
    }

    const attemptRows = await source.query(streamId, {
      type: ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT,
    });
    for (const row of attemptRows) {
      if (row.type !== ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT) continue;
      const parsed = AdmissionShadowAttemptData.safeParse(row.data);
      if (!parsed.success) continue;

      const disagreementClass = classifyShadowOutcome(parsed.data.legacyOutcome, {
        status: 'evaluated',
        verdict: parsed.data.decision.outcome,
      });
      attempts.push({
        legacyOutcome: parsed.data.legacyOutcome,
        disagreementClass,
      });

      const disposition: DisagreementDisposition = isDisagreement(disagreementClass)
        ? latestDisposition.get(parsed.data.shadowAttemptId) ?? 'unexplained'
        : 'agree';
      decisions.push({ disagreementClass, disposition });
      tally[disposition] += 1;
    }
  }

  const dispositionTally: Readonly<Record<DisagreementDisposition, number>> =
    Object.freeze({
      'agree': tally.agree,
      'explained-legacy': tally['explained-legacy'],
      'explained-admission': tally['explained-admission'],
      'accepted-risk': tally['accepted-risk'],
      'unexplained': tally.unexplained,
    });

  return { featureIds, attempts, decisions, dispositionTally };
}

/** The process-local (non-durable) inputs the six-condition model also weighs. */
export interface LiveCutoverInputs {
  readonly liveAttempts: readonly LiveShadowAttempt[];
  readonly observerHealth: LiveShadowHealth;
}

/** The assembled evidence plus the durable fold it was built from. */
export interface AssembledCutoverEvidence {
  readonly evidence: CutoverGateEvidence;
  readonly durable: DurableShadowEvidence;
}

/**
 * Assemble the full {@link CutoverGateEvidence} from the durable fold of one
 * store and the live inputs of the caller. The durable `decisions` fill the
 * `corpusRecords` slot. Thus an undisposed durable disagreement makes the
 * `deterministic-corpus-clean` condition fail.
 */
export async function assembleCutoverGateEvidence(
  source: ShadowEvidenceSource,
  live: LiveCutoverInputs,
): Promise<AssembledCutoverEvidence> {
  const durable = await readDurableShadowEvidence(source);
  return {
    durable,
    evidence: {
      corpusRecords: durable.decisions,
      liveAttempts: live.liveAttempts,
      durableAttempts: durable.attempts,
      observerHealth: live.observerHealth,
    },
  };
}

/** Assemble the evidence and evaluate the gate in one step. */
export async function assessDurableCutoverReadiness(
  source: ShadowEvidenceSource,
  live: LiveCutoverInputs,
): Promise<{ report: CutoverGateReport; durable: DurableShadowEvidence }> {
  const { evidence, durable } = await assembleCutoverGateEvidence(source, live);
  return { report: evaluateCutoverGate(evidence), durable };
}

/** Deterministic sha256 content digest of a UTF-8 string. */
export function contentDigestOf(value: string): ContentDigestV1 {
  return ContentDigestV1Schema.parse({
    algorithm: 'sha256',
    value: createHash('sha256').update(value, 'utf8').digest('hex'),
  });
}

/**
 * The store slice a postcondition check needs: one stream, optionally narrowed
 * to an event type and the dispatch that wrote it. `EventStore.query` satisfies
 * this structurally.
 */
export interface PersistedEvidenceSource {
  query(
    streamId: string,
    filters?: { type?: string | undefined; operationId?: string | undefined },
  ): Promise<
    readonly {
      readonly type: string;
      readonly operationId?: string | undefined;
      readonly data?: unknown;
    }[]
  >;
}

/** What a durable-evidence ensure asks the reader to find. */
export interface PersistedEvidenceQuery {
  readonly streamId: string;
  readonly operationId: string;
  readonly evidenceType: string;
}

/** One persisted evidence row that matched the asked type on this operation. */
export interface PersistedEvidenceObservation {
  readonly evidenceType: string;
  readonly operationId: string;
  /**
   * What the row is proof about, so a caller does not re-read the row. A
   * `kind: 'artifact'` subject names the thing under proof, not a blob. Custody
   * keys on `artifactRefs` alone, never on `subject.kind`.
   */
  readonly subject: EvidenceSubjectV1;
  /** Blobs the row names. It is empty when the row names none, never undefined. */
  readonly artifactRefs: readonly EvidenceArtifactReferenceV1[];
}

/**
 * Read persisted evidence records for one operation-scoped ensure.
 *
 * Only committed `admission.evidence-recorded` rows count. The envelope must
 * carry this operationId, and the evidence kind of the payload must match the
 * asked type. The reader drops an unreadable payload because it is not
 * evidence. That drop also covers a bad artifact reference, because the same
 * `safeParse` validates the reference.
 */
export async function readPersistedEvidence(
  source: PersistedEvidenceSource,
  query: PersistedEvidenceQuery,
): Promise<readonly PersistedEvidenceObservation[]> {
  const rows = await source.query(query.streamId, {
    type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    operationId: query.operationId,
  });
  const observed: PersistedEvidenceObservation[] = [];
  for (const row of rows) {
    if (row.type !== ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED) continue;
    if (row.operationId !== query.operationId) continue;
    const parsed = AdmissionEvidenceRecordedData.safeParse(row.data);
    if (!parsed.success) continue;
    if (parsed.data.evidence.kind !== query.evidenceType) continue;
    observed.push({
      evidenceType: parsed.data.evidence.kind,
      operationId: query.operationId,
      subject: parsed.data.evidence.subject,
      artifactRefs: parsed.data.evidence.artifactRefs ?? [],
    });
  }
  return observed;
}
