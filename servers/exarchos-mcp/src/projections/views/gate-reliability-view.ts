import {
  AdmissionContradictionRecordedData,
  AdmissionEvidenceRecordedData,
  type AdmissionContradictionRecorded,
  type AdmissionEvidenceRecorded,
  type WorkflowEvent,
} from '../../events/schemas.js';
import {
  BUILTIN_GATE_PROVIDER_REGISTRY,
} from '../../orchestrate/gate-provider-registry.js';
import {
  CANONICAL_GATE_RUNNER_SOURCE_PREFIX,
} from '../../orchestrate/gate-runner.js';
import type { ContentDigestV1, EvidenceSubjectV1 } from '../../workflow/admission/types.js';
import type { ViewProjection } from './materializer.js';

export const GATE_RELIABILITY_VIEW = 'gate-reliability';

export interface GateReliabilitySource {
  readonly streamId: string;
  readonly sequence: number;
}

export interface GateVerdictProvenance {
  readonly evidenceId: string;
  readonly verdict: 'pass' | 'fail' | 'indeterminate';
  readonly observedAt: string;
  readonly source: GateReliabilitySource;
  readonly requirementId: string;
  readonly phaseAttemptId: string;
  readonly subject: EvidenceSubjectV1;
  readonly policyId: string;
  readonly policyDigest: ContentDigestV1;
  readonly contentDigest: ContentDigestV1;
  readonly producer: AdmissionEvidenceRecorded['evidence']['producer'];
}

export interface GateContradictionProvenance {
  readonly contradictionId: string;
  readonly detectedAt: string;
  readonly source: GateReliabilitySource;
  readonly evidenceIds: readonly string[];
  /** The pass verdicts treated as false positives by this fact. */
  readonly falsePositiveEvidenceIds: readonly string[];
}

export interface GateReliabilityMetric {
  readonly gateClass: string;
  /** Stable implementation identity, separate from the gate taxonomy class. */
  readonly gateIdentity: string;
  /**
   * 1 - falsePositiveRate. Null means there are no positive samples, rather
   * than pretending an unmeasured gate is healthy.
   */
  readonly value: number | null;
  /** Contract name used by the gate-reliability input described in #1646. */
  readonly fpr: number | null;
  readonly falsePositiveRate: number | null;
  /** All normalized verdict observations, including fail and indeterminate. */
  readonly sampleSize: number;
  /** Pass verdicts: the denominator of falsePositiveRate. */
  readonly positiveSampleSize: number;
  readonly falsePositiveCount: number;
  readonly verdicts: Readonly<{
    pass: number;
    fail: number;
    indeterminate: number;
  }>;
  readonly asOf: string | null;
  readonly source: GateReliabilitySource | null;
  readonly provenance: Readonly<{
    verdicts: readonly GateVerdictProvenance[];
    contradictions: readonly GateContradictionProvenance[];
  }>;
}

interface FoldEvent {
  readonly event: WorkflowEvent;
}

export interface GateReliabilityViewState {
  /** v2.12 contract: this read model has no admission or transition authority. */
  readonly diagnosticOnly: true;
  readonly gates: readonly GateReliabilityMetric[];
  /** Append-only fold inputs retained so any arrival order can be recomputed. */
  readonly _foldEvents: readonly FoldEvent[];
}

interface ObservedVerdict {
  readonly gateClass: string;
  readonly record: GateEvidenceRecord;
  readonly event: WorkflowEvent;
}

type GateEvidenceRecord = AdmissionEvidenceRecorded & Readonly<{
  evidence: Extract<AdmissionEvidenceRecorded['evidence'], { kind: 'gate' }>;
}>;

interface ObservedContradiction {
  readonly fact: AdmissionContradictionRecorded;
  readonly event: WorkflowEvent;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceOf(event: WorkflowEvent): GateReliabilitySource {
  return Object.freeze({ streamId: event.streamId, sequence: event.sequence });
}

function sourceKey(event: WorkflowEvent): string {
  return `${event.streamId}\0${String(event.sequence).padStart(16, '0')}`;
}

function gateClassFromSource(source: string | undefined): string | undefined {
  if (source === undefined || !source.startsWith(CANONICAL_GATE_RUNNER_SOURCE_PREFIX)) {
    return undefined;
  }
  const encoded = source.slice(CANONICAL_GATE_RUNNER_SOURCE_PREFIX.length);
  if (encoded.length === 0) return undefined;
  try {
    const gateClass = decodeURIComponent(encoded);
    return encodeURIComponent(gateClass) === encoded ? gateClass : undefined;
  } catch {
    return undefined;
  }
}

function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}

function subjectKey(subject: EvidenceSubjectV1): string {
  return JSON.stringify(subject);
}

function observedVerdict(event: WorkflowEvent): ObservedVerdict | undefined {
  if (event.type !== 'admission.evidence-recorded') return undefined;
  const gateClass = gateClassFromSource(event.source);
  if (gateClass === undefined) return undefined;
  const parsed = AdmissionEvidenceRecordedData.safeParse(event.data);
  if (!parsed.success || parsed.data.evidence.kind !== 'gate') return undefined;
  // The canonical runner stamps both values from the same trusted dispatch.
  if (
    event.operationId === undefined ||
    event.operationId !== parsed.data.evidence.producer.invocationId
  ) {
    return undefined;
  }
  return {
    gateClass,
    record: parsed.data as GateEvidenceRecord,
    event,
  };
}

function observedContradiction(event: WorkflowEvent): ObservedContradiction | undefined {
  if (event.type !== 'admission.contradiction-recorded') return undefined;
  const parsed = AdmissionContradictionRecordedData.safeParse(event.data);
  return parsed.success ? { fact: parsed.data, event } : undefined;
}

function contradictionMatches(
  contradiction: AdmissionContradictionRecorded,
  records: readonly AdmissionEvidenceRecorded[],
): boolean {
  const first = records[0]?.evidence;
  if (first === undefined || records.length < 2) return false;
  return records.every(({ evidence }) =>
    evidence.requirementId === first.requirementId &&
    evidence.phaseAttemptId === contradiction.phaseAttemptId &&
    evidence.policyId === contradiction.policyId &&
    digestKey(evidence.policyDigest) === digestKey(contradiction.policyDigest) &&
    subjectKey(evidence.subject) === subjectKey(contradiction.subject)
  ) && (
    contradiction.requirementId === undefined ||
    contradiction.requirementId === first.requirementId
  );
}

function emptyMetric(gateClass: string, gateIdentity: string): GateReliabilityMetric {
  return Object.freeze({
    gateClass,
    gateIdentity,
    value: null,
    fpr: null,
    falsePositiveRate: null,
    sampleSize: 0,
    positiveSampleSize: 0,
    falsePositiveCount: 0,
    verdicts: Object.freeze({ pass: 0, fail: 0, indeterminate: 0 }),
    asOf: null,
    source: null,
    provenance: Object.freeze({
      verdicts: Object.freeze([]),
      contradictions: Object.freeze([]),
    }),
  });
}

function metricKey(gateClass: string, gateIdentity: string): string {
  return `${gateClass}\0${gateIdentity}`;
}

function recompute(events: readonly FoldEvent[]): readonly GateReliabilityMetric[] {
  const ordered = events
    .map(({ event }) => event)
    .sort((left, right) => compareText(sourceKey(left), sourceKey(right)));
  const observationsByEvidenceId = new Map<string, ObservedVerdict>();
  const contradictions: ObservedContradiction[] = [];

  for (const event of ordered) {
    const verdict = observedVerdict(event);
    if (verdict !== undefined) {
      // Runner idempotency makes an evidence ID one execution. Keep the first
      // durable coordinate if a malformed imported history contains duplicates.
      if (!observationsByEvidenceId.has(verdict.record.evidence.evidenceId)) {
        observationsByEvidenceId.set(verdict.record.evidence.evidenceId, verdict);
      }
      continue;
    }
    const contradiction = observedContradiction(event);
    if (contradiction !== undefined) contradictions.push(contradiction);
  }

  const validContradictions = contradictions.flatMap((candidate) => {
    const evidenceIds = [...new Set(candidate.fact.evidenceIds)].sort(compareText);
    const observations = evidenceIds.map((id) => observationsByEvidenceId.get(id));
    if (observations.some((item) => item === undefined)) return [];
    const present = observations as ObservedVerdict[];
    return contradictionMatches(
      candidate.fact,
      present.map(({ record }) => record),
    )
      ? [{ ...candidate, evidenceIds, observations: present }]
      : [];
  });

  const keys = new Map<string, { gateClass: string; gateIdentity: string }>();
  for (const provider of BUILTIN_GATE_PROVIDER_REGISTRY.list()) {
    keys.set(metricKey(provider.gateClass, provider.providerRef), {
      gateClass: provider.gateClass,
      gateIdentity: provider.providerRef,
    });
  }
  for (const observation of observationsByEvidenceId.values()) {
    const gateIdentity = observation.record.evidence.producer.providerRef;
    keys.set(metricKey(observation.gateClass, gateIdentity), {
      gateClass: observation.gateClass,
      gateIdentity,
    });
  }

  return Object.freeze(
    [...keys.values()]
      .sort((left, right) =>
        compareText(
          metricKey(left.gateClass, left.gateIdentity),
          metricKey(right.gateClass, right.gateIdentity),
        ),
      )
      .map(({ gateClass, gateIdentity }) => {
        const observations = [...observationsByEvidenceId.values()]
          .filter((item) =>
            item.gateClass === gateClass &&
            item.record.evidence.producer.providerRef === gateIdentity
          )
          .sort((left, right) =>
            compareText(left.record.evidence.evidenceId, right.record.evidence.evidenceId),
          );
        if (observations.length === 0) return emptyMetric(gateClass, gateIdentity);

        const observationIds = new Set(
          observations.map(({ record }) => record.evidence.evidenceId),
        );
        const relevantContradictions = validContradictions
          .filter(({ evidenceIds }) => evidenceIds.some((id) => observationIds.has(id)))
          .sort((left, right) =>
            compareText(left.fact.contradictionId, right.fact.contradictionId) ||
            compareText(sourceKey(left.event), sourceKey(right.event)),
          );
        const falsePositiveIds = new Set<string>();
        for (const contradiction of relevantContradictions) {
          for (const observation of contradiction.observations) {
            const evidence = observation.record.evidence;
            if (
              evidence.kind === 'gate' &&
              evidence.verdict === 'pass' &&
              observationIds.has(evidence.evidenceId)
            ) {
              falsePositiveIds.add(evidence.evidenceId);
            }
          }
        }

        const pass = observations.filter(({ record }) => record.evidence.verdict === 'pass').length;
        const fail = observations.filter(({ record }) => record.evidence.verdict === 'fail').length;
        const indeterminate = observations.length - pass - fail;
        const falsePositiveCount = falsePositiveIds.size;
        const falsePositiveRate = pass === 0 ? null : falsePositiveCount / pass;
        const timeline = [
          ...observations.map(({ event }) => event),
          ...relevantContradictions.map(({ event }) => event),
        ].sort((left, right) =>
          compareText(left.timestamp, right.timestamp) ||
          compareText(sourceKey(left), sourceKey(right)),
        );
        // Non-empty by construction (the zero-observation case returned above),
        // but proving it to the checker keeps the module's own stance: an
        // unmeasurable gate reports `emptyMetric`, never a fabricated reading.
        const latest = timeline.at(-1);
        if (latest === undefined) return emptyMetric(gateClass, gateIdentity);

        return Object.freeze({
          gateClass,
          gateIdentity,
          value: falsePositiveRate === null ? null : 1 - falsePositiveRate,
          fpr: falsePositiveRate,
          falsePositiveRate,
          sampleSize: observations.length,
          positiveSampleSize: pass,
          falsePositiveCount,
          verdicts: Object.freeze({ pass, fail, indeterminate }),
          asOf: latest.timestamp,
          source: sourceOf(latest),
          provenance: Object.freeze({
            verdicts: Object.freeze(observations.map(({ record, event }) => {
              const evidence = record.evidence;
              return Object.freeze({
                evidenceId: evidence.evidenceId,
                verdict: evidence.verdict,
                observedAt: event.timestamp,
                source: sourceOf(event),
                requirementId: evidence.requirementId,
                phaseAttemptId: evidence.phaseAttemptId,
                subject: evidence.subject,
                policyId: evidence.policyId,
                policyDigest: evidence.policyDigest,
                contentDigest: evidence.contentDigest,
                producer: evidence.producer,
              });
            })),
            contradictions: Object.freeze(relevantContradictions.map((item) =>
              Object.freeze({
                contradictionId: item.fact.contradictionId,
                detectedAt: item.fact.detectedAt,
                source: sourceOf(item.event),
                evidenceIds: Object.freeze(item.evidenceIds),
                falsePositiveEvidenceIds: Object.freeze(
                  item.evidenceIds.filter((id) => falsePositiveIds.has(id)),
                ),
              }),
            )),
          }),
        });
      }),
  );
}

export const gateReliabilityProjection: ViewProjection<GateReliabilityViewState> = {
  init(): GateReliabilityViewState {
    return Object.freeze({
      diagnosticOnly: true,
      gates: recompute([]),
      _foldEvents: Object.freeze([]),
    });
  },

  apply(state: GateReliabilityViewState, event: WorkflowEvent): GateReliabilityViewState {
    if (
      observedVerdict(event) === undefined &&
      observedContradiction(event) === undefined
    ) {
      return state;
    }
    const key = sourceKey(event);
    if (state._foldEvents.some(({ event: prior }) => sourceKey(prior) === key)) {
      return state;
    }
    const foldEvents = Object.freeze(
      [...state._foldEvents, Object.freeze({ event })].sort((left, right) =>
        compareText(sourceKey(left.event), sourceKey(right.event)),
      ),
    );
    return Object.freeze({
      diagnosticOnly: true,
      gates: recompute(foldEvents),
      _foldEvents: foldEvents,
    });
  },
};
