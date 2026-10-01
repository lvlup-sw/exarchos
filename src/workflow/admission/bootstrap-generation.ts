/**
 * Event-sourced requirement generations, shared by bootstrap (`bootstrap-attempts.ts`) and reassessment (`reassessment.ts`).
 * Both freeze a requirement generation for a phase attempt by appending `admission.requirement-resolved` facts.
 * Neither rewrites a past event or stamps a `.state.json`.
 *
 * The same inputs always give byte-identical events, because every id comes from content.
 * The fold collapses a repeated append, so a second bootstrap cannot fork an attempt into two generations.
 * The module is pure. The caller supplies the trusted `resolvedAt` instant.
 */

import { createHash } from 'node:crypto';

import type {
  DecideOnceStoredEvent,
  EventInput,
} from '../../events/atomic-appender.js';
import { AdmissionRequirementResolvedData } from '../../events/schemas.js';
import {
  foldPhaseAttemptAdmission,
  type PhaseAttemptAdmissionFold,
} from './phase-attempt-state.js';
import {
  ADMISSION_EVENT_TYPES,
  type ContentDigestV1,
  type EvidenceSubjectV1,
  type OperationId,
  type PhaseAttemptId,
  type PolicyId,
} from './types.js';
import type { FrozenRequirementSetProjection } from './freeze-requirements.js';

/** A JSON value that `canonicalJson` serializes with sorted keys. */
type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, CanonicalJson>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function subjectIdentity(subject: EvidenceSubjectV1): CanonicalJson {
  return subject as unknown as CanonicalJson;
}

/**
 * The policy identity that a requirement generation is frozen under.
 * Every fact in one generation carries the same values. A disagreement makes the fold contest the attempt.
 */
export interface GenerationProvenance {
  readonly operationId: OperationId;
  readonly policyId: PolicyId;
  /** The EXPLICIT policy version this generation is resolved under. */
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  /** Trusted RFC3339 resolution instant — never `Date.now()`. */
  readonly resolvedAt: string;
}

/** The deterministic digest of the resolution inputs of a generation: the frozen set, its binding, and its policy. */
export function generationInputDigest(
  frozen: FrozenRequirementSetProjection,
  phaseAttemptId: PhaseAttemptId,
  subject: EvidenceSubjectV1,
  provenance: GenerationProvenance,
): ContentDigestV1 {
  const value = sha256Hex(
    canonicalJson({
      requirementSetDigest: frozen.requirementSetDigest.value,
      policyId: provenance.policyId,
      policyVersion: provenance.policyVersion,
      policyDigest: provenance.policyDigest.value,
      phaseAttemptId,
      subject: subjectIdentity(subject),
    }),
  );
  return { algorithm: 'sha256', value };
}

/**
 * Project a frozen requirement set into the `admission.requirement-resolved` events of one generation.
 * Each requirement gets one event. All events share `requirementSetDigest` and `inputDigest`, so the fold groups them.
 */
export function buildRequirementResolvedEvents(
  frozen: FrozenRequirementSetProjection,
  phaseAttemptId: PhaseAttemptId,
  subject: EvidenceSubjectV1,
  provenance: GenerationProvenance,
): readonly EventInput[] {
  const inputDigest = generationInputDigest(
    frozen,
    phaseAttemptId,
    subject,
    provenance,
  );
  return frozen.requirements.map((requirement) => {
    const resolutionId = `resolution.${sha256Hex(
      canonicalJson({
        requirementId: requirement.requirementId,
        requirementSetDigest: frozen.requirementSetDigest.value,
        inputDigest: inputDigest.value,
      }),
    ).slice(0, 40)}`;
    const data = AdmissionRequirementResolvedData.parse({
      eventVersion: '1.0',
      resolutionId,
      operationId: provenance.operationId,
      policyId: provenance.policyId,
      policyVersion: provenance.policyVersion,
      policyDigest: provenance.policyDigest,
      requirementSetDigest: frozen.requirementSetDigest,
      inputDigest,
      resolvedAt: provenance.resolvedAt,
      requirement,
    });
    return {
      type: ADMISSION_EVENT_TYPES.REQUIREMENT_RESOLVED,
      data: data as unknown as Record<string, unknown>,
      operationId: provenance.operationId,
    };
  });
}

/**
 * Fold the admission facts of a stream into per-attempt frozen state with `foldPhaseAttemptAdmission`.
 * A malformed historical fact sets integrity to `'contested'`. The fold does not throw.
 */
export function foldAdmissionStream(
  events: readonly DecideOnceStoredEvent[],
): PhaseAttemptAdmissionFold {
  const requirementEvents: unknown[] = [];
  const evidenceEvents: unknown[] = [];
  const decisionEvents: unknown[] = [];
  for (const event of events) {
    switch (event.type) {
      case ADMISSION_EVENT_TYPES.REQUIREMENT_RESOLVED:
        requirementEvents.push(event.data);
        break;
      case ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED:
        evidenceEvents.push(event.data);
        break;
      case ADMISSION_EVENT_TYPES.TRANSITION_DECIDED:
        decisionEvents.push(event.data);
        break;
      default:
        break;
    }
  }
  return foldPhaseAttemptAdmission({
    requirementEvents,
    evidenceEvents,
    decisionEvents,
  });
}

/** Stable key for a content digest, the same key that the attempt fold uses. */
export function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}
