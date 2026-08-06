/**
 * P01-04 — phase-attempt frozen admission state (DR-4, DR-9).
 *
 * Reconstructs, per phase attempt, the frozen requirement set, the evidence
 * bound to it, and the decision taken against it — using ONLY persisted event
 * payloads. The fold takes no policy handle, no clock, no filesystem, and no
 * event store: replaying the same append-only facts always yields the same
 * state, so a later policy edit cannot retroactively change what a historical
 * attempt was required to satisfy.
 *
 * ## Frozen requirement sets
 *
 * `admission.requirement-resolved` carries exactly ONE requirement plus the
 * `requirementSetDigest` of the complete set that requirement belongs to. The
 * fold therefore groups an attempt's resolutions by that digest: each digest
 * identifies one immutable *generation* of the attempt's requirement set. The
 * generation named by the attempt's LAST resolution is the active frozen set;
 * earlier generations stay visible in `requirementSetHistory` so a re-freeze is
 * auditable rather than destructive.
 *
 * ## Malformed / untrustworthy persisted facts — explicit policy
 *
 * This fold NEVER silently drops and NEVER silently trusts. Every persisted
 * payload is `safeParse`d against its registered schema; anything that fails,
 * or that parses but cannot be reconciled with the attempt's frozen set, is
 * QUARANTINED:
 *
 *   1. it is excluded from the trusted `frozenRequirementSet` / `evidence` /
 *      `decision` slots (fail closed — it can never satisfy anything),
 *   2. a typed {@link AdmissionFoldDiagnostic} naming the reason is emitted, and
 *   3. the owning attempt (when the payload is attributable to one) and the
 *      whole fold are marked `'contested'`, so a consumer that reads only
 *      `integrity` still cannot mistake a partial reconstruction for a complete
 *      one.
 *
 * Replay stays total: a malformed historical fact degrades the reconstruction
 * to `'contested'`, it never throws and never aborts the projection.
 *
 * The one deliberate exception is a byte-identical repeat of an already-folded
 * resolution: at-least-once delivery legitimately produces those, nothing is
 * lost by collapsing them, and they do not contest the attempt. A repeat that
 * differs in ANY field is a contradiction and is quarantined.
 *
 * Scope: this module reconstructs state. It does not evaluate policy, decide
 * admission, allocate attempt identities, or perform supersession selection
 * (see `select-evidence.ts`).
 */
import { z } from 'zod';
import {
  AdmissionEvidenceRecordedData,
  AdmissionRequirementResolvedData,
  AdmissionTransitionDecidedData,
  type AdmissionRequirementResolved,
} from '../../event-store/schemas.js';
import {
  DecisionIdSchema,
  EvidenceIdSchema,
  PhaseAttemptIdSchema,
  RequirementIdSchema,
  type AdmissionDecisionRecordV1,
  type AdmissionEvidenceV1,
  type AdmissionRequirementV1,
  type ContentDigestV1,
  type DecisionId,
  type EvidenceId,
  type PhaseAttemptId,
  type PolicyId,
  type RequirementId,
} from './types.js';

// ─── Public shapes ──────────────────────────────────────────────────────────

/** Why the fold refused to trust a persisted admission fact. */
export type AdmissionFoldDiagnosticCode =
  /** Payload does not satisfy `AdmissionRequirementResolvedData`. */
  | 'MALFORMED_REQUIREMENT_RESOLUTION'
  /** Payload does not satisfy `AdmissionEvidenceRecordedData`. */
  | 'MALFORMED_EVIDENCE_RECORD'
  /** Payload does not satisfy `AdmissionTransitionDecidedData`. */
  | 'MALFORMED_TRANSITION_DECISION'
  /** The same requirement id was frozen twice, with different content. */
  | 'CONTRADICTORY_REQUIREMENT_RESOLUTION'
  /** Resolutions sharing a requirement-set digest disagree on their policy inputs. */
  | 'INCONSISTENT_REQUIREMENT_SET_PROVENANCE'
  /** Evidence names a requirement absent from the attempt's frozen set. */
  | 'EVIDENCE_OUTSIDE_FROZEN_REQUIREMENT_SET'
  /** A decision names a requirement set that is not the attempt's frozen set. */
  | 'DECISION_REQUIREMENT_SET_MISMATCH';

/**
 * A quarantined persisted fact. Identity fields appear only when they could be
 * *validated* out of the raw payload — a malformed record never launders an
 * unchecked string into a branded id.
 */
export interface AdmissionFoldDiagnostic {
  readonly code: AdmissionFoldDiagnosticCode;
  readonly message: string;
  readonly phaseAttemptId?: PhaseAttemptId;
  readonly requirementId?: RequirementId;
  readonly evidenceId?: EvidenceId;
  readonly decisionId?: DecisionId;
}

/**
 * `'intact'` means every persisted fact in scope parsed and reconciled.
 * `'contested'` means at least one was quarantined — the reconstruction is
 * incomplete and MUST NOT be treated as a complete frozen requirement set.
 */
export type AdmissionFoldIntegrity = 'intact' | 'contested';

/** One immutable generation of an attempt's requirement set. */
export interface FrozenRequirementSet {
  /** Identity of the complete set, frozen by the writer at resolution time. */
  readonly requirementSetDigest: ContentDigestV1;
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  readonly inputDigest: ContentDigestV1;
  /** Members in resolution order; each requirement id appears at most once. */
  readonly requirements: readonly AdmissionRequirementV1[];
  readonly requirementIds: readonly RequirementId[];
}

/** Everything a replay can know about one phase attempt's admission state. */
export interface PhaseAttemptAdmissionState {
  readonly phaseAttemptId: PhaseAttemptId;
  /** Every generation this attempt froze, in first-resolution order. */
  readonly requirementSetHistory: readonly FrozenRequirementSet[];
  /** The generation named by the attempt's last resolution; `null` if none. */
  readonly frozenRequirementSet: FrozenRequirementSet | null;
  /** Evidence bound to a requirement in the active frozen set, in append order. */
  readonly evidence: readonly AdmissionEvidenceV1[];
  /** Quarantined evidence: parsed, but outside the active frozen set. */
  readonly unattributedEvidence: readonly AdmissionEvidenceV1[];
  /** Every parsed decision for this attempt, in append order. */
  readonly decisionHistory: readonly AdmissionDecisionRecordV1[];
  /**
   * Latest decision whose `requirementSetDigest` matches the active frozen set.
   * `null` when the attempt froze no requirement set — an attempt that never
   * resolved requirements can never carry a trusted decision (fail closed).
   */
  readonly decision: AdmissionDecisionRecordV1 | null;
  readonly integrity: AdmissionFoldIntegrity;
}

export interface PhaseAttemptAdmissionFold {
  /** Attempts in first-appearance order across the supplied histories. */
  readonly attempts: readonly PhaseAttemptAdmissionState[];
  readonly diagnostics: readonly AdmissionFoldDiagnostic[];
  readonly integrity: AdmissionFoldIntegrity;
}

/**
 * Raw persisted payloads, each in append order. `unknown` is deliberate: a
 * replay must diagnose historical facts, not assume they are well-formed.
 * Ordering matters only WITHIN a stream; the fold attributes across streams in
 * a second pass, so evidence persisted before its resolution still binds.
 */
export interface PhaseAttemptAdmissionFoldInput {
  readonly requirementEvents?: readonly unknown[];
  readonly evidenceEvents?: readonly unknown[];
  readonly decisionEvents?: readonly unknown[];
}

// ─── Validated probes for diagnostics ───────────────────────────────────────
// A malformed payload still often carries a well-formed identity. These probes
// PARSE that identity with the same branded schemas the trusted path uses, so a
// diagnostic can never smuggle an unvalidated string into a branded slot.

const RequirementAttemptProbe = z.object({
  requirement: z.object({ phaseAttemptId: PhaseAttemptIdSchema }),
});
const RequirementIdProbe = z.object({
  requirement: z.object({ requirementId: RequirementIdSchema }),
});
const EvidenceAttemptProbe = z.object({
  evidence: z.object({ phaseAttemptId: PhaseAttemptIdSchema }),
});
const EvidenceIdProbe = z.object({
  evidence: z.object({ evidenceId: EvidenceIdSchema }),
});
const DecisionAttemptProbe = z.object({
  decision: z.object({ phaseAttemptId: PhaseAttemptIdSchema }),
});
const DecisionIdProbe = z.object({
  decision: z.object({ decisionId: DecisionIdSchema }),
});

function probeRequirementAttempt(input: unknown): PhaseAttemptId | undefined {
  const parsed = RequirementAttemptProbe.safeParse(input);
  return parsed.success ? parsed.data.requirement.phaseAttemptId : undefined;
}

function probeRequirementId(input: unknown): RequirementId | undefined {
  const parsed = RequirementIdProbe.safeParse(input);
  return parsed.success ? parsed.data.requirement.requirementId : undefined;
}

function probeEvidenceAttempt(input: unknown): PhaseAttemptId | undefined {
  const parsed = EvidenceAttemptProbe.safeParse(input);
  return parsed.success ? parsed.data.evidence.phaseAttemptId : undefined;
}

function probeEvidenceId(input: unknown): EvidenceId | undefined {
  const parsed = EvidenceIdProbe.safeParse(input);
  return parsed.success ? parsed.data.evidence.evidenceId : undefined;
}

function probeDecisionAttempt(input: unknown): PhaseAttemptId | undefined {
  const parsed = DecisionAttemptProbe.safeParse(input);
  return parsed.success ? parsed.data.decision.phaseAttemptId : undefined;
}

function probeDecisionId(input: unknown): DecisionId | undefined {
  const parsed = DecisionIdProbe.safeParse(input);
  return parsed.success ? parsed.data.decision.decisionId : undefined;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}

/**
 * Order-independent serialization of already-parsed (therefore JSON-shaped)
 * schema output. Used only to compare two resolutions of the same requirement
 * id for exact equality; it is not a persisted content address.
 */
function stableSerialize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const entries: Array<[string, unknown]> = Object.entries(value);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(',')}}`;
}

interface DiagnosticScope {
  readonly phaseAttemptId?: PhaseAttemptId | undefined;
  readonly requirementId?: RequirementId | undefined;
  readonly evidenceId?: EvidenceId | undefined;
  readonly decisionId?: DecisionId | undefined;
}

function diagnostic(
  code: AdmissionFoldDiagnosticCode,
  message: string,
  scope: DiagnosticScope = {},
): AdmissionFoldDiagnostic {
  return {
    code,
    message,
    ...(scope.phaseAttemptId === undefined
      ? {}
      : { phaseAttemptId: scope.phaseAttemptId }),
    ...(scope.requirementId === undefined
      ? {}
      : { requirementId: scope.requirementId }),
    ...(scope.evidenceId === undefined ? {} : { evidenceId: scope.evidenceId }),
    ...(scope.decisionId === undefined ? {} : { decisionId: scope.decisionId }),
  };
}

interface GenerationBuilder {
  readonly requirementSetDigest: ContentDigestV1;
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  readonly inputDigest: ContentDigestV1;
  readonly requirements: AdmissionRequirementV1[];
  readonly serializedById: Map<string, string>;
}

interface AttemptBuilder {
  readonly phaseAttemptId: PhaseAttemptId;
  readonly generations: Map<string, GenerationBuilder>;
  readonly generationOrder: string[];
  activeGenerationKey: string | null;
  readonly evidence: AdmissionEvidenceV1[];
  readonly decisions: AdmissionDecisionRecordV1[];
  contested: boolean;
}

function sameResolutionProvenance(
  generation: GenerationBuilder,
  record: AdmissionRequirementResolved,
): boolean {
  return (
    generation.policyId === record.policyId &&
    generation.policyVersion === record.policyVersion &&
    digestKey(generation.policyDigest) === digestKey(record.policyDigest) &&
    digestKey(generation.inputDigest) === digestKey(record.inputDigest)
  );
}

function freezeGeneration(generation: GenerationBuilder): FrozenRequirementSet {
  return {
    requirementSetDigest: generation.requirementSetDigest,
    policyId: generation.policyId,
    policyVersion: generation.policyVersion,
    policyDigest: generation.policyDigest,
    inputDigest: generation.inputDigest,
    requirements: [...generation.requirements],
    requirementIds: generation.requirements.map(
      (requirement) => requirement.requirementId,
    ),
  };
}

// ─── The fold ───────────────────────────────────────────────────────────────

/**
 * Reconstruct every phase attempt's frozen admission state from persisted
 * facts alone. Pure: the inputs are never mutated and the result depends on
 * nothing but the supplied payloads.
 */
export function foldPhaseAttemptAdmission(
  input: PhaseAttemptAdmissionFoldInput,
): PhaseAttemptAdmissionFold {
  const diagnostics: AdmissionFoldDiagnostic[] = [];
  const builders = new Map<string, AttemptBuilder>();
  const builderOrder: string[] = [];

  const builderFor = (phaseAttemptId: PhaseAttemptId): AttemptBuilder => {
    const existing = builders.get(phaseAttemptId);
    if (existing !== undefined) return existing;
    const created: AttemptBuilder = {
      phaseAttemptId,
      generations: new Map(),
      generationOrder: [],
      activeGenerationKey: null,
      evidence: [],
      decisions: [],
      contested: false,
    };
    builders.set(phaseAttemptId, created);
    builderOrder.push(phaseAttemptId);
    return created;
  };

  const contest = (phaseAttemptId: PhaseAttemptId | undefined): void => {
    if (phaseAttemptId !== undefined) builderFor(phaseAttemptId).contested = true;
  };

  // ── Pass 1: frozen requirement sets ──────────────────────────────────────
  for (const candidate of input.requirementEvents ?? []) {
    const parsed = AdmissionRequirementResolvedData.safeParse(candidate);
    if (!parsed.success) {
      const phaseAttemptId = probeRequirementAttempt(candidate);
      diagnostics.push(
        diagnostic(
          'MALFORMED_REQUIREMENT_RESOLUTION',
          'requirement resolution does not satisfy the persisted admission proof schema',
          { phaseAttemptId, requirementId: probeRequirementId(candidate) },
        ),
      );
      contest(phaseAttemptId);
      continue;
    }

    const record = parsed.data;
    const requirement = record.requirement;
    const attempt = builderFor(requirement.phaseAttemptId);
    const generationKey = digestKey(record.requirementSetDigest);

    let generation = attempt.generations.get(generationKey);
    if (generation === undefined) {
      generation = {
        requirementSetDigest: record.requirementSetDigest,
        policyId: record.policyId,
        policyVersion: record.policyVersion,
        policyDigest: record.policyDigest,
        inputDigest: record.inputDigest,
        requirements: [],
        serializedById: new Map(),
      };
      attempt.generations.set(generationKey, generation);
      attempt.generationOrder.push(generationKey);
    } else if (!sameResolutionProvenance(generation, record)) {
      attempt.contested = true;
      diagnostics.push(
        diagnostic(
          'INCONSISTENT_REQUIREMENT_SET_PROVENANCE',
          'resolutions sharing a requirement-set digest disagree on policy or input identity',
          {
            phaseAttemptId: attempt.phaseAttemptId,
            requirementId: requirement.requirementId,
          },
        ),
      );
    }
    // A structurally valid resolution always names the attempt's latest
    // generation, even when it was quarantined for provenance drift.
    attempt.activeGenerationKey = generationKey;

    const serialized = stableSerialize(requirement);
    const previous = generation.serializedById.get(requirement.requirementId);
    if (previous === undefined) {
      generation.serializedById.set(requirement.requirementId, serialized);
      generation.requirements.push(requirement);
    } else if (previous !== serialized) {
      attempt.contested = true;
      diagnostics.push(
        diagnostic(
          'CONTRADICTORY_REQUIREMENT_RESOLUTION',
          'requirement id was frozen more than once with different content',
          {
            phaseAttemptId: attempt.phaseAttemptId,
            requirementId: requirement.requirementId,
          },
        ),
      );
    }
  }

  // ── Pass 2: evidence ─────────────────────────────────────────────────────
  for (const candidate of input.evidenceEvents ?? []) {
    const parsed = AdmissionEvidenceRecordedData.safeParse(candidate);
    if (!parsed.success) {
      const phaseAttemptId = probeEvidenceAttempt(candidate);
      diagnostics.push(
        diagnostic(
          'MALFORMED_EVIDENCE_RECORD',
          'evidence record does not satisfy the persisted admission proof schema',
          { phaseAttemptId, evidenceId: probeEvidenceId(candidate) },
        ),
      );
      contest(phaseAttemptId);
      continue;
    }
    const evidence = parsed.data.evidence;
    builderFor(evidence.phaseAttemptId).evidence.push(evidence);
  }

  // ── Pass 3: decisions ────────────────────────────────────────────────────
  for (const candidate of input.decisionEvents ?? []) {
    const parsed = AdmissionTransitionDecidedData.safeParse(candidate);
    if (!parsed.success) {
      const phaseAttemptId = probeDecisionAttempt(candidate);
      diagnostics.push(
        diagnostic(
          'MALFORMED_TRANSITION_DECISION',
          'transition decision does not satisfy the persisted admission proof schema',
          { phaseAttemptId, decisionId: probeDecisionId(candidate) },
        ),
      );
      contest(phaseAttemptId);
      continue;
    }
    const decision = parsed.data.decision;
    builderFor(decision.phaseAttemptId).decisions.push(decision);
  }

  // ── Pass 4: bind evidence and decisions to the frozen set ────────────────
  const attempts: PhaseAttemptAdmissionState[] = [];
  for (const key of builderOrder) {
    const builder = builders.get(key);
    if (builder === undefined) continue;

    const frozenByKey = new Map<string, FrozenRequirementSet>();
    for (const generationKey of builder.generationOrder) {
      const generation = builder.generations.get(generationKey);
      if (generation !== undefined) {
        frozenByKey.set(generationKey, freezeGeneration(generation));
      }
    }
    const requirementSetHistory = builder.generationOrder.flatMap(
      (generationKey) => {
        const frozen = frozenByKey.get(generationKey);
        return frozen === undefined ? [] : [frozen];
      },
    );
    const activeKey = builder.activeGenerationKey;
    const frozenRequirementSet =
      activeKey === null ? null : frozenByKey.get(activeKey) ?? null;
    const frozenRequirementIds = new Set<string>(
      frozenRequirementSet?.requirementIds ?? [],
    );

    const evidence: AdmissionEvidenceV1[] = [];
    const unattributedEvidence: AdmissionEvidenceV1[] = [];
    for (const record of builder.evidence) {
      if (frozenRequirementIds.has(record.requirementId)) {
        evidence.push(record);
        continue;
      }
      unattributedEvidence.push(record);
      builder.contested = true;
      diagnostics.push(
        diagnostic(
          'EVIDENCE_OUTSIDE_FROZEN_REQUIREMENT_SET',
          'evidence names a requirement absent from the attempt frozen requirement set',
          {
            phaseAttemptId: builder.phaseAttemptId,
            requirementId: record.requirementId,
            evidenceId: record.evidenceId,
          },
        ),
      );
    }

    let decision: AdmissionDecisionRecordV1 | null = null;
    for (const record of builder.decisions) {
      if (
        frozenRequirementSet !== null &&
        digestKey(record.requirementSetDigest) ===
          digestKey(frozenRequirementSet.requirementSetDigest)
      ) {
        decision = record;
        continue;
      }
      builder.contested = true;
      diagnostics.push(
        diagnostic(
          'DECISION_REQUIREMENT_SET_MISMATCH',
          frozenRequirementSet === null
            ? 'decision was recorded for an attempt that never froze a requirement set'
            : 'decision names a requirement set that is not the attempt frozen set',
          {
            phaseAttemptId: builder.phaseAttemptId,
            decisionId: record.decisionId,
          },
        ),
      );
    }

    attempts.push({
      phaseAttemptId: builder.phaseAttemptId,
      requirementSetHistory,
      frozenRequirementSet,
      evidence,
      unattributedEvidence,
      decisionHistory: [...builder.decisions],
      decision,
      integrity: builder.contested ? 'contested' : 'intact',
    });
  }

  return {
    attempts,
    diagnostics,
    integrity: diagnostics.length === 0 ? 'intact' : 'contested',
  };
}

/**
 * Look up one attempt's reconstructed state by identity.
 *
 * The id is PARSED with the branded schema rather than cast, so an
 * unvalidated carrier (for example a projected `phaseAttemptId` string read off
 * a historical state file) can never select an attempt by accident.
 */
export function selectPhaseAttempt(
  fold: PhaseAttemptAdmissionFold,
  phaseAttemptId: unknown,
): PhaseAttemptAdmissionState | null {
  const parsed = PhaseAttemptIdSchema.safeParse(phaseAttemptId);
  if (!parsed.success) return null;
  return (
    fold.attempts.find(
      (attempt) => attempt.phaseAttemptId === parsed.data,
    ) ?? null
  );
}
