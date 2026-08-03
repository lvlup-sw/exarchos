// ─── P06-07 / Transition task 050 — event-sourced requirement generations ────
//
// Shared substrate for bootstrap (`bootstrap-attempts.ts`) and reassessment
// (`reassessment.ts`). Both establish a *frozen requirement generation* for a
// phase attempt by APPENDING `admission.requirement-resolved` facts — never by
// rewriting a past event or retro-stamping a `.state.json`. This module owns the
// projection from a {@link FrozenRequirementSetProjection} (produced by P06-05's
// `freezeRequirements`) into the append-only event payloads, plus the stream
// fold that reconstructs prior attempt state.
//
// Determinism is load-bearing: the same frozen set + the same generation
// provenance always projects to BYTE-IDENTICAL events (ids are content-derived,
// never a clock or counter). So appending the same generation twice yields
// duplicate-but-identical `admission.requirement-resolved` facts, which the
// P01-04 fold legitimately collapses — a re-bootstrap can never fork an attempt
// into two generations.
//
// Pure: no I/O, no clock, no config reads. The trusted `resolvedAt` instant is
// a caller input, never `Date.now()`.

import { createHash } from 'node:crypto';

import type {
  DecideOnceStoredEvent,
  EventInput,
} from '../../event-store/atomic-appender.js';
import { AdmissionRequirementResolvedData } from '../../event-store/schemas.js';
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

// ─── Canonical serialization (sorted keys, JSON leaves only) ─────────────────

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

// ─── Generation provenance ───────────────────────────────────────────────────

/**
 * The immutable policy identity a requirement generation is frozen under. Every
 * `admission.requirement-resolved` fact in one generation carries the same
 * values, so the P01-04 fold sees one consistent generation provenance (a
 * disagreement would contest the attempt).
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

/**
 * The deterministic input-digest naming a frozen generation's resolution
 * inputs. Derived purely from the frozen set identity, its binding, and the
 * policy it was resolved under, so re-deriving it for the same inputs is stable.
 */
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
 * Project a frozen requirement set into the append-only
 * `admission.requirement-resolved` events that establish one generation.
 *
 * One event per requirement, all sharing the generation's `requirementSetDigest`
 * and `inputDigest` (so the fold groups them into a single generation). Every id
 * is content-derived, so the projection is deterministic and a re-append is a
 * byte-identical no-op the fold collapses.
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

// ─── Stream fold (P01-04) ─────────────────────────────────────────────────────

/**
 * Fold the admission facts on a stream snapshot into per-attempt frozen state,
 * reusing the P01-04 fold verbatim. Total: a malformed historical fact degrades
 * integrity to `'contested'`, it never throws.
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

/** Stable key for a content digest, matching the P01-04 fold's `digestKey`. */
export function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}
