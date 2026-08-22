// ─── #1739 — the production DurableShadowEvidenceReader ──────────────────────
//
// The cutover gate (`cutover-gate.ts`) reads its durable substrate through the
// narrow `DurableShadowEvidenceReader` slice, but until #1739 nothing in
// production ENUMERATED the sidecar streams that substrate lives in — every
// caller had to already know the featureIds. This module closes that gap over
// ONE local store:
//
//   1. enumerate every `<featureId>/admission-shadow` sidecar stream through
//      the store's `streams` registry (`listStreams`, R-1) — no raw SQL;
//   2. fold the `admission.shadow-attempt` rows into the
//      {@link DurableShadowAttemptFact} shape the gate's `durableAttempts`
//      condition weighs, AND — keyed by `shadowAttemptId` — pair them with
//      their LATEST `admission.disagreement-disposition` row into the
//      {@link ShadowDispositionView} shape `summarizeShadowDecisions` folds;
//   3. hand both to `evaluateCutoverGate` via
//      {@link assembleCutoverGateEvidence}.
//
// INV-1 discipline: an EMPTY store yields NO evidence, never clean
// evidence — the fold returns zero attempts, and the gate's
// `live-disagreement-class` condition independently refuses "no durable
// shadow-attempt evidence". A persisted row that fails schema validation is
// DROPPED, mirroring `readDurableShadowAttempts`: unreadable evidence is not
// evidence, and defaulting it to `agree` would be the same vacuity elsewhere.

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
import { ADMISSION_EVENT_TYPES, ContentDigestV1Schema, type ContentDigestV1 } from './types.js';

// ─── Source slice ─────────────────────────────────────────────────────────────

/**
 * The read slice of one local store this module needs: the gate's query
 * contract PLUS stream enumeration. `EventStore` satisfies it structurally —
 * `listStreams()` reads the `streams` registry table (R-1), so no consumer
 * here ever issues raw SQL.
 */
export interface ShadowEvidenceSource extends DurableShadowEvidenceReader {
  listStreams(): string[];
}

/** The `/`-suffixed sidecar marker every shadow evidence stream ends with. */
const SIDECAR_SUFFIX = `/${LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT}`;

/**
 * Enumerate the featureIds that own a `<featureId>/admission-shadow` sidecar
 * stream in this store. Sorted for determinism; an empty store yields `[]`.
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

// ─── Durable fold ─────────────────────────────────────────────────────────────

/** The folded reading of one store's durable shadow substrate. */
export interface DurableShadowEvidence {
  /** Feature ids that own a sidecar evidence stream (sorted). */
  readonly featureIds: readonly string[];
  /** The gate's `durableAttempts` substrate — one fact per readable row. */
  readonly attempts: readonly DurableShadowAttemptFact[];
  /**
   * The disposition-bearing view `summarizeShadowDecisions` folds: each
   * attempt paired with its LATEST recorded disposition. An agreement carries
   * the `agree` sentinel; a disagreement with NO disposition row is
   * conservatively `unexplained` (it blocks the gate until a human disposes it
   * via the registered `admission.disagreement-disposition` handler).
   */
  readonly decisions: readonly ShadowDispositionView[];
  /** Count per disposition across {@link decisions}; every key always present. */
  readonly dispositionTally: Readonly<Record<DisagreementDisposition, number>>;
}

/**
 * Read and fold the durable shadow evidence for every sidecar stream in the
 * store. One pass per stream, two typed queries each — attempts first, then
 * dispositions — matched on `shadowAttemptId` with the LATEST disposition row
 * winning (stream order is append order, so a later human re-disposition
 * supersedes the observer's conservative `unexplained` default).
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
    /** shadowAttemptId → latest recorded disposition. */
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

  // A TOTAL record, mirroring the gate's class tallies: every key is present
  // even when the store was empty. Rebuilt literally (no cast) from the
  // accumulator, which the type system already proves total.
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

// ─── Gate-evidence assembly ───────────────────────────────────────────────────

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
 * Assemble the full {@link CutoverGateEvidence} from ONE store's durable fold
 * plus the caller's live inputs. The durable `decisions` occupy the
 * disposition-bearing `corpusRecords` slot, so an undisposed durable
 * disagreement drives `deterministic-corpus-clean` red — the gate cannot be
 * argued past an unexplained live disagreement.
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

/** Assemble and evaluate in one step — the shape both #1739 consumers share. */
export async function assessDurableCutoverReadiness(
  source: ShadowEvidenceSource,
  live: LiveCutoverInputs,
): Promise<{ report: CutoverGateReport; durable: DurableShadowEvidence }> {
  const { evidence, durable } = await assembleCutoverGateEvidence(source, live);
  return { report: evaluateCutoverGate(evidence), durable };
}

// ─── Digest helper ────────────────────────────────────────────────────────────

/** Deterministic sha256 content digest of a UTF-8 string (shared by #1739). */
export function contentDigestOf(value: string): ContentDigestV1 {
  return ContentDigestV1Schema.parse({
    algorithm: 'sha256',
    value: createHash('sha256').update(value, 'utf8').digest('hex'),
  });
}

// ─── Persisted action-evidence observation ───────────────────────────────────

/**
 * The store slice a postcondition check needs: one stream, optionally narrowed
 * to an event type and the dispatch that wrote it. `EventStore.query` satisfies
 * this structurally.
 */
export interface PersistedEvidenceSource {
  query(
    streamId: string,
    filters?: { type?: string; operationId?: string },
  ): Promise<
    readonly {
      readonly type: string;
      readonly operationId?: string;
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
}

/**
 * Read persisted evidence records for one operation-scoped ensure.
 *
 * Only committed `admission.evidence-recorded` rows count. The envelope must
 * carry this operationId, and the payload's evidence kind must match the
 * asked type. An unreadable payload is dropped — it is not evidence.
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
    });
  }
  return observed;
}
