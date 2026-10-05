/**
 * Reconstructs, for each phase attempt, the frozen requirement set, its bound evidence and its decision.
 * The fold reads only persisted event payloads: no policy, no clock, no filesystem, no event store.
 * A replay of the same facts always gives the same state, so a later policy edit cannot change a historical attempt.
 *
 * `admission.requirement-resolved` carries one requirement and the `requirementSetDigest` of its complete set.
 * Each digest names one immutable generation of the requirement set of an attempt.
 * The generation of the last resolution is the active frozen set. Earlier generations stay in `requirementSetHistory`.
 *
 * The fold never drops a fact silently and never trusts one silently. A malformed payload never enters the trusted slots.
 * A payload that fails its schema, or contradicts the frozen set, gets an {@link AdmissionFoldDiagnostic}.
 * Its attempt (when known) and the fold become `'contested'`. Replay never throws.
 * An identical repeat of a resolution collapses with no diagnostic, because at-least-once delivery produces it.
 *
 * This module does not evaluate policy, decide admission, allocate attempt ids, or select superseding evidence (see `select-evidence.ts`).
 */
import { z } from 'zod';
import {
  AdmissionEvidenceRecordedData,
  AdmissionRequirementResolvedData,
  AdmissionTransitionDecidedData,
  type AdmissionRequirementResolved,
} from '../../events/schemas.js';
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

/**
 * Why the fold refused to trust a persisted admission fact.
 * - `MALFORMED_*`: the payload does not satisfy the schema of its event.
 * - `CONTRADICTORY_REQUIREMENT_RESOLUTION`: one requirement id was frozen twice, with different content.
 * - `INCONSISTENT_REQUIREMENT_SET_PROVENANCE`: resolutions with one set digest disagree on their policy inputs.
 * - `EVIDENCE_OUTSIDE_FROZEN_REQUIREMENT_SET`: evidence names a requirement outside the frozen set.
 * - `DECISION_REQUIREMENT_SET_MISMATCH`: a decision names a set that is not the frozen set.
 */
export type AdmissionFoldDiagnosticCode =
  | 'MALFORMED_REQUIREMENT_RESOLUTION'
  | 'MALFORMED_EVIDENCE_RECORD'
  | 'MALFORMED_TRANSITION_DECISION'
  | 'CONTRADICTORY_REQUIREMENT_RESOLUTION'
  | 'INCONSISTENT_REQUIREMENT_SET_PROVENANCE'
  | 'EVIDENCE_OUTSIDE_FROZEN_REQUIREMENT_SET'
  | 'DECISION_REQUIREMENT_SET_MISMATCH';

/**
 * A quarantined persisted fact. An identity field appears only when it passes validation.
 * Thus a malformed record never puts an unchecked string into a branded id.
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
  /** Members in resolution order. Each requirement id appears at most once. */
  readonly requirements: readonly AdmissionRequirementV1[];
  readonly requirementIds: readonly RequirementId[];
}

/** Everything a replay can know about one phase attempt's admission state. */
export interface PhaseAttemptAdmissionState {
  readonly phaseAttemptId: PhaseAttemptId;
  /** Every generation this attempt froze, in first-resolution order. */
  readonly requirementSetHistory: readonly FrozenRequirementSet[];
  /** The generation of the last resolution of the attempt, or `null` when there is none. */
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
 * Raw persisted payloads, each in append order. The type is `unknown`, because a replay must diagnose historical facts.
 * Order matters only inside one stream. The fold binds across streams in a later pass, so evidence persisted before its resolution still binds.
 */
export interface PhaseAttemptAdmissionFoldInput {
  readonly requirementEvents?: readonly unknown[];
  readonly evidenceEvents?: readonly unknown[];
  readonly decisionEvents?: readonly unknown[];
}

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

function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}

/**
 * An order-independent serialization of parsed, JSON-shaped schema output.
 * It only compares two resolutions of one requirement id for exact equality. It is not a persisted content address.
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

/**
 * Reconstructs the frozen admission state of every phase attempt from persisted facts alone. It does not mutate its inputs.
 * Four passes run: requirement sets, evidence, decisions, then the binding of evidence and decisions to the frozen set.
 * A valid resolution always moves the active generation, even when the fold contests its provenance.
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
 * Returns the reconstructed state of one attempt, or `null`.
 * The id is parsed with the branded schema and not cast, so an unvalidated string cannot select an attempt.
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
