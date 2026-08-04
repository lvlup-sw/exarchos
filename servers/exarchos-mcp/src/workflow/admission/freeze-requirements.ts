// ─── P06-05 / Transition task 019 — freeze the obligation lattice ────────────
//
// The open seam P06-04 flagged: the pure obligation lattice
// ({@link ResolvedRequirements}, from P06-03's `resolveRequirements`) is NOT the
// persisted requirement-record shape (`AdmissionRequirementV1[]`) that the
// phase-attempt fold replays and that `evaluatePolicy` evaluates. This module
// closes that seam by PROJECTING the lattice element into frozen, immutable,
// content-addressed requirement records with stable ids, a bound subject, and a
// `requirementSetDigest` naming the whole generation.
//
// Determinism is the load-bearing property: freezing the SAME obligations for
// the SAME phase attempt + subject yields byte-identical records and the SAME
// `requirementSetDigest`. Every id is derived from the requirement's semantic
// content (never a clock or a counter), so a re-freeze is a no-op in identity —
// exactly what an append-only fold needs to collapse duplicate resolutions.
//
// The projection is TOTAL and MONOTONE-PRESERVING: a stronger obligation
// lattice element (more gates, higher floors, not-waivable) projects to an
// at-least-as-large requirement set. It never invents an obligation the lattice
// did not carry, and never drops one it did.
//
// Pure: no I/O, no clock, no config reads.

import { createHash } from 'node:crypto';

import type { ResolvedGate } from '../phase-kind.js';
import {
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  AdmissionRequirementV1Schema,
  ApprovalClassSchema,
  type AdmissionRequirementV1,
  type ApprovalClass,
  type ContentDigestV1,
  type EvidenceSubjectV1,
  type PhaseAttemptId,
} from './types.js';
import type { ResolvedRequirements } from './requirement-strength.js';
import {
  BOTTOM_REQUIREMENTS,
  deepFreezeRequirements,
  equalRequirements,
  joinRequirements,
  type FrozenResolvedRequirements,
} from './requirement-strength.js';

/**
 * The persisted-record floor for the number of independent corroborating
 * sources. The obligation lattice records any positive integer, but a
 * {@link AdmissionRequirementV1} `corroboration` record is only meaningful at
 * two or more sources (a single "corroborating" source corroborates nothing).
 * A positive lattice value therefore floors here, mirroring the note in
 * `requirement-strength.ts`.
 */
export const CORROBORATION_RECORD_FLOOR = 2 as const;

/**
 * The approval class used when the caller does not supply one. Approval classes
 * are opaque, provider-neutral tokens; this default keeps the projection total
 * for a policy floor that demands approvals without naming a class.
 */
export const DEFAULT_APPROVAL_CLASS: ApprovalClass =
  ApprovalClassSchema.parse('admission.approval');

export interface FreezeRequirementsInput {
  /** The resolved obligation lattice element to project (from `resolveRequirements`). */
  readonly resolved: ResolvedRequirements;
  /** The phase attempt these obligations bind to. */
  readonly phaseAttemptId: PhaseAttemptId;
  /** The immutable, content-addressed subject the obligations are about. */
  readonly subject: EvidenceSubjectV1;
  /** Approval class for the approval obligation. Defaults to {@link DEFAULT_APPROVAL_CLASS}. */
  readonly approvalClass?: ApprovalClass;
}

export interface FrozenRequirementSetProjection {
  /**
   * The frozen requirement records, in canonical construction order
   * (gate obligations in canonical gate order, then approval, then
   * corroboration). Each id appears at most once.
   */
  readonly requirements: readonly AdmissionRequirementV1[];
  /** The digest of the complete set — the generation identity the fold groups by. */
  readonly requirementSetDigest: ContentDigestV1;
}

// ─── Canonical serialization (sorted keys, JSON leaves only) ─────────────────

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

/**
 * Deterministic JSON serialization with lexicographically sorted object keys.
 * The inputs are validated plain records with primitive leaves, so this total
 * traversal is sufficient for stable content-addressing (no cycles, no dates,
 * no class instances reach here).
 */
function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
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

function stableId(prefix: string, discriminant: CanonicalJson): string {
  // Prefix keeps the leading character a letter (StableIdValueSchema requires
  // the first char in [A-Za-z0-9]) and names the id's role; the hex body makes
  // the id both stable and regex-safe (`[a-f0-9]`).
  return `${prefix}-${sha256Hex(canonicalJson(discriminant)).slice(0, 40)}`;
}

/** The canonical, subject-independent identity of a resolved gate. */
function gateDiscriminant(gate: ResolvedGate): CanonicalJson {
  return { family: gate.family, gate: gate.gate };
}

// ─── Projection ──────────────────────────────────────────────────────────────

interface Binding {
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly subjectIdentity: CanonicalJson;
}

function subjectIdentity(subject: EvidenceSubjectV1): CanonicalJson {
  // The subject as canonical JSON: its kind, its variant id, and its digest.
  return subject as unknown as CanonicalJson;
}

function projectGate(gate: ResolvedGate, binding: Binding): AdmissionRequirementV1 {
  const discriminant = {
    kind: 'gate-evidence',
    gate: gateDiscriminant(gate),
    phaseAttemptId: binding.phaseAttemptId,
    subject: binding.subjectIdentity,
  } as const;
  return AdmissionRequirementV1Schema.parse({
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    kind: 'gate-evidence',
    requirementId: stableId('req.gate', discriminant),
    phaseAttemptId: binding.phaseAttemptId,
    subject: binding.subject,
    gateId: stableId('gate', gateDiscriminant(gate)),
  });
}

function projectApproval(
  minimumApprovals: number,
  approvalClass: ApprovalClass,
  binding: Binding,
): AdmissionRequirementV1 {
  const discriminant = {
    kind: 'approval',
    approvalClass,
    minimumApprovals,
    phaseAttemptId: binding.phaseAttemptId,
    subject: binding.subjectIdentity,
  } as const;
  return AdmissionRequirementV1Schema.parse({
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    kind: 'approval',
    requirementId: stableId('req.approval', discriminant),
    phaseAttemptId: binding.phaseAttemptId,
    subject: binding.subject,
    approvalClass,
    minimumApprovals,
  });
}

function projectCorroboration(
  minimumIndependentSources: number,
  binding: Binding,
): AdmissionRequirementV1 {
  // The id is derived WITHOUT `sourceRequirementId` to break the self-reference
  // cycle: this corroboration obligation is satisfied by N independent evidence
  // items bound to its OWN id, so `sourceRequirementId` equals `requirementId`.
  const discriminant = {
    kind: 'corroboration',
    minimumIndependentSources,
    phaseAttemptId: binding.phaseAttemptId,
    subject: binding.subjectIdentity,
  } as const;
  const requirementId = stableId('req.corroboration', discriminant);
  return AdmissionRequirementV1Schema.parse({
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    kind: 'corroboration',
    requirementId,
    phaseAttemptId: binding.phaseAttemptId,
    subject: binding.subject,
    sourceRequirementId: requirementId,
    minimumIndependentSources,
  });
}

/**
 * Project a resolved obligation lattice element into the frozen, persisted
 * requirement records the runtime evaluates and replays.
 *
 * Total, pure, deterministic: the same obligations + binding always yield the
 * same records and the same {@link FrozenRequirementSetProjection.requirementSetDigest}.
 */
export function freezeRequirements(
  input: FreezeRequirementsInput,
): FrozenRequirementSetProjection {
  const binding: Binding = {
    phaseAttemptId: input.phaseAttemptId,
    subject: input.subject,
    subjectIdentity: subjectIdentity(input.subject),
  };
  const approvalClass = input.approvalClass ?? DEFAULT_APPROVAL_CLASS;

  const requirements: AdmissionRequirementV1[] = [];

  for (const gate of input.resolved.gates) {
    requirements.push(projectGate(gate, binding));
  }

  if (input.resolved.minimumApprovals > 0) {
    requirements.push(
      projectApproval(input.resolved.minimumApprovals, approvalClass, binding),
    );
  }

  if (input.resolved.minimumCorroboratingSources > 0) {
    const sources = Math.max(
      CORROBORATION_RECORD_FLOOR,
      input.resolved.minimumCorroboratingSources,
    );
    requirements.push(projectCorroboration(sources, binding));
  }

  const requirementSetDigest: ContentDigestV1 = Object.freeze({
    algorithm: 'sha256' as const,
    value: sha256Hex(canonicalJson(requirements as unknown as CanonicalJson)),
  });

  return Object.freeze({
    requirements: Object.freeze(requirements),
    requirementSetDigest,
  });
}

// ─── DR-10 (T-15): the frozen record is the authority ────────────────────────
//
// A frozen requirement set is not a cache of a resolution — it IS the
// resolution, named by content. DR-10's third acceptance criterion is that a
// LATER attempt reads that record back instead of re-resolving from whatever
// the workflow state happens to say now: re-resolution is exactly how a weaker
// tier stamped after the freeze could retroactively lower an in-flight phase's
// obligations.
//
// Read-back is therefore a JOIN against the frozen record, never a replacement:
//   - a weaker (or equal) re-resolution is ABSORBED — the frozen set and its
//     digest come back byte-identical, so replaying the log and re-resolving
//     live agree;
//   - a strictly stronger re-resolution RAISES the set, because monotonicity
//     runs one way only and new danger information must still be able to add
//     obligations.

/**
 * A frozen record read back as the authority for a later resolution.
 * `authority: 'frozen'` means the re-resolution added nothing and the original
 * generation stands; `'raised'` means it was strictly stronger and a NEW
 * generation was minted.
 */
export interface FrozenRequirementAuthority extends FrozenRequirementSetProjection {
  readonly authority: 'frozen' | 'raised';
  /** The obligation lattice element the returned records were projected from. */
  readonly resolved: FrozenResolvedRequirements;
}

export interface FrozenRequirementAuthorityInput {
  /** The obligations recorded at the freeze point (read back, not re-derived). */
  readonly frozen: ResolvedRequirements;
  /** What a later attempt resolves today — a proposal, not the authority. */
  readonly reresolved: ResolvedRequirements;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly approvalClass?: ApprovalClass;
}

/**
 * Re-freeze under the authority of an already-frozen set.
 *
 * Deterministic and content-addressed like {@link freezeRequirements}: when the
 * re-resolution is not stronger, the returned records and
 * `requirementSetDigest` are exactly those of a fresh freeze of `frozen`, so a
 * later weaker attempt cannot mint a competing generation.
 */
export function reconcileFrozenRequirements(
  input: FrozenRequirementAuthorityInput,
): FrozenRequirementAuthority {
  const effective = joinRequirements(input.frozen, input.reresolved);
  const projection = freezeRequirements({
    resolved: effective,
    phaseAttemptId: input.phaseAttemptId,
    subject: input.subject,
    ...(input.approvalClass !== undefined ? { approvalClass: input.approvalClass } : {}),
  });
  return Object.freeze({
    ...projection,
    resolved: effective,
    authority: equalRequirements(effective, input.frozen) ? 'frozen' : 'raised',
  });
}

const RESOLVED_GATE_FAMILIES: ReadonlySet<string> = new Set([
  'ladder',
  'plan',
  'review',
  'synthesis',
]);

function parseFrozenGate(raw: unknown): ResolvedGate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { family?: unknown; gate?: unknown };
  if (typeof record.family !== 'string' || typeof record.gate !== 'string') return null;
  if (!RESOLVED_GATE_FAMILIES.has(record.family) || record.gate.length === 0) {
    return null;
  }
  // The family discriminant is validated above; the per-family gate vocabulary
  // is owned by phase-kind.ts / review-contract.ts and is an open string there,
  // so the cast re-attaches the discriminant rather than widening anything.
  return { family: record.family, gate: record.gate } as ResolvedGate;
}

/**
 * Read a frozen `phase.entered` gate list back as an ORDERED sequence, without
 * re-resolving anything.
 *
 * Order is preserved because gate order is evaluation order — the lattice's
 * canonical set form (see {@link readFrozenRequirements}) deliberately sorts,
 * which is right for set comparison and wrong for the event payload.
 *
 * Fail-closed and total: any unreadable entry yields `null` — "we could not
 * read the frozen sequence" — rather than a partial one. A partial sequence
 * would be a silently WEAKER authority, which is the failure mode this whole
 * read-back path exists to prevent.
 */
export function readFrozenGateSequence(
  gates: readonly unknown[] | undefined,
): readonly ResolvedGate[] | null {
  if (gates === undefined) return null;
  const parsed: ResolvedGate[] = [];
  for (const raw of gates) {
    const gate = parseFrozenGate(raw);
    if (gate === null) return null;
    parsed.push(gate);
  }
  return Object.freeze(parsed);
}

/**
 * Reconstruct the obligation lattice element a frozen `phase.entered` record
 * carries, WITHOUT re-resolving anything.
 *
 * Fail-closed and total: a record with any unreadable gate yields `null` — "we
 * could not read the frozen set" — rather than a partial set. A partial set
 * would be a silently WEAKER authority, which is the failure mode this whole
 * read-back path exists to prevent; `null` tells the caller it holds no
 * authority and must fall back to a full resolution.
 */
export function readFrozenRequirements(
  gates: readonly unknown[] | undefined,
): FrozenResolvedRequirements | null {
  const sequence = readFrozenGateSequence(gates);
  if (sequence === null) return null;
  return deepFreezeRequirements({ ...BOTTOM_REQUIREMENTS, gates: sequence });
}
