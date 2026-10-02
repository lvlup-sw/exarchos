/**
 * Freeze the obligation lattice into persisted requirement records.
 *
 * The lattice from `resolveRequirements` is not the `AdmissionRequirementV1[]` shape
 * that the phase-attempt fold replays and `evaluatePolicy` evaluates. This module
 * projects it into frozen records with content-derived ids, a bound subject, and a
 * `requirementSetDigest`. The same obligations, phase attempt, and subject always
 * give identical records and the same digest. The module is pure.
 */
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
 * The minimum source count in a `corroboration` record. One source corroborates
 * nothing, so a positive lattice value below this floor rises to it.
 */
export const CORROBORATION_RECORD_FLOOR = 2 as const;

/** The approval class when the caller supplies none. */
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
  /** The frozen records: gate records first, then approval, then corroboration. */
  readonly requirements: readonly AdmissionRequirementV1[];
  /** The digest of the complete set — the generation identity the fold groups by. */
  readonly requirementSetDigest: ContentDigestV1;
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

/**
 * JSON serialization with sorted object keys. The inputs are validated plain
 * records with primitive leaves, so no cycles, dates, or class instances occur.
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

/**
 * A content-derived id. The prefix names the role of the id. The hex body is stable
 * and uses only characters that `StableIdValueSchema` accepts.
 */
function stableId(prefix: string, discriminant: CanonicalJson): string {
  return `${prefix}-${sha256Hex(canonicalJson(discriminant)).slice(0, 40)}`;
}

/** The canonical, subject-independent identity of a resolved gate. */
function gateDiscriminant(gate: ResolvedGate): CanonicalJson {
  return { family: gate.family, gate: gate.gate };
}

interface Binding {
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly subjectIdentity: CanonicalJson;
}

/** The subject as canonical JSON: its kind, its variant id, and its digest. */
function subjectIdentity(subject: EvidenceSubjectV1): CanonicalJson {
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

/**
 * Project the corroboration obligation. Its evidence binds to its own id, so
 * `sourceRequirementId` equals `requirementId`. The id excludes that field to
 * prevent a self-reference cycle.
 */
function projectCorroboration(
  minimumIndependentSources: number,
  binding: Binding,
): AdmissionRequirementV1 {
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
 * Project a resolved lattice element into the frozen records that the runtime
 * evaluates and replays. The same input always gives the same records and digest.
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

/**
 * A frozen record read back as the authority for a later resolution. `frozen`
 * means the original generation stands. `raised` means a stronger re-resolution
 * made a new generation.
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
 * Re-freeze under the authority of a frozen set. The result is the join of the
 * frozen set and the re-resolution, so a later attempt cannot lower the obligations
 * of a phase in progress. A weaker or equal re-resolution gives the same records and
 * digest as `frozen`. A stronger one raises the set.
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

/**
 * Parse one frozen gate. It checks the family against the known families and requires
 * a non-empty gate name. It does not check the name against the vocabulary of the family.
 */
function parseFrozenGate(raw: unknown): ResolvedGate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { family?: unknown; gate?: unknown };
  if (typeof record.family !== 'string' || typeof record.gate !== 'string') return null;
  if (!RESOLVED_GATE_FAMILIES.has(record.family) || record.gate.length === 0) {
    return null;
  }
  return { family: record.family, gate: record.gate } as ResolvedGate;
}

/**
 * Read a frozen `phase.entered` gate list back in order, without re-resolving.
 * Gate order is evaluation order, so this does not sort. One unreadable entry
 * gives `null`, because a partial sequence is a weaker authority.
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
 * Rebuild the lattice element from a frozen `phase.entered` record, without
 * re-resolving. One unreadable gate gives `null`. Then the caller holds no
 * authority and must do a full resolution.
 */
export function readFrozenRequirements(
  gates: readonly unknown[] | undefined,
): FrozenResolvedRequirements | null {
  const sequence = readFrozenGateSequence(gates);
  if (sequence === null) return null;
  return deepFreezeRequirements({ ...BOTTOM_REQUIREMENTS, gates: sequence });
}
