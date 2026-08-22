// ─── P06-04 / Transition tasks 021, 022, 044 — Three-valued policy evaluation ─
//
// `evaluatePolicy` folds the ACTIVE evidence (already selected by P01-06's
// `selectEvidence`), the detected contradictions, and any waivers against a
// resolved requirement set into ONE three-valued verdict:
//
//   allow          — every requirement is satisfied, or validly waived;
//   deny           — at least one requirement is unsatisfied for a SOUND reason
//                    (missing / stale / contradictory / malformed / unauthorized
//                    / failed) and no waiver rescues it;
//   indeterminate  — no sound deny, but at least one requirement could not be
//                    decided (an evaluator returned `indeterminate`). This is a
//                    first-class outcome that MUST fail closed downstream — it is
//                    never coerced to allow, and a waiver never rescues it.
//
// The load-bearing invariant (the P06-04 exit proof): a waiver NEVER rewrites or
// hides failed evidence. A waived requirement is reported as `waived`, and the
// failure it waived is ALSO reported in `recordedFailures` with `waived: true`
// and the waiver id — so anyone auditing the decision still sees the failure.
//
// Trust is never self-asserted: authorization comes from the injected
// `PolicyAuthority` (P01-07), and the evaluation instant / freshness horizon are
// trusted inputs, never `Date.now()`.
//
// Pure: no I/O, no clock, no config reads; deterministic output ordering.

import type { EvidenceContradiction } from './select-evidence.js';
import { DENY_ALL_AUTHORITY, type PolicyAuthority } from './policy-authority.js';
import type { ActionIdRequirement } from './requirement-resolution.js';
import type { ResolvedRequirements } from './requirement-strength.js';
import {
  selectApplicableWaiver,
  subjectIdentityKey,
  type WaiverTarget,
} from './waiver.js';
import type {
  AdmissionEvidenceV1,
  AdmissionIndeterminateCode,
  AdmissionRequirementV1,
  EvidenceId,
  EvidenceSubjectV1,
  PhaseAttemptId,
  RequirementId,
  WaiverId,
  WaiverProvenanceV1,
} from './types.js';

// ─── Public result algebra ───────────────────────────────────────────────────

export type PolicyVerdict = 'allow' | 'deny' | 'indeterminate';

/** The sound reasons a requirement is unsatisfied. Each independently denies. */
export type PolicyDenyReason =
  | 'missing'
  | 'failed'
  | 'stale'
  | 'malformed'
  | 'contradictory'
  | 'unauthorized';

/** The disposition of a single requirement in the evaluated set. */
export type RequirementEvaluation =
  | {
      readonly requirementId: RequirementId;
      readonly status: 'satisfied';
      readonly evidenceIds: readonly EvidenceId[];
    }
  | {
      readonly requirementId: RequirementId;
      readonly status: 'denied';
      readonly reason: PolicyDenyReason;
      readonly evidenceIds: readonly EvidenceId[];
    }
  | {
      readonly requirementId: RequirementId;
      readonly status: 'waived';
      readonly waiverId: WaiverId;
      /** The failure the waiver permitted admission despite — kept, not erased. */
      readonly waivedReason: PolicyDenyReason;
      readonly evidenceIds: readonly EvidenceId[];
    }
  | {
      readonly requirementId: RequirementId;
      readonly status: 'indeterminate';
      readonly code: AdmissionIndeterminateCode;
      readonly evidenceIds: readonly EvidenceId[];
    };

/**
 * A failure that remains on record even when a waiver permitted admission. This
 * is the durable proof that admission-despite-failure never rewrites the
 * evidence: `waived: true` entries appear here under an `allow` verdict.
 */
export interface RecordedFailure {
  readonly requirementId: RequirementId;
  readonly reason: PolicyDenyReason;
  readonly evidenceIds: readonly EvidenceId[];
  readonly waived: boolean;
  readonly waiverId?: WaiverId;
}

export interface PolicyEvaluation {
  readonly verdict: PolicyVerdict;
  readonly requirementEvaluations: readonly RequirementEvaluation[];
  readonly recordedFailures: readonly RecordedFailure[];
  readonly appliedWaiverIds: readonly WaiverId[];
}

export interface PolicyEvaluationInput {
  /**
   * The resolved requirement RECORDS to evaluate — each carrying a stable id and
   * an immutable subject. In the full pipeline these are the projection of a
   * {@link ResolvedRequirements} obligation lattice; the lattice element itself
   * is threaded as {@link PolicyEvaluationInput.obligations}.
   */
  readonly requirements: readonly AdmissionRequirementV1[];
  /**
   * The resolved obligation lattice element from `resolveRequirements(ctx)`. Its
   * `waivable` floor decides whether ANY waiver may discharge a failure.
   */
  readonly obligations: ResolvedRequirements;
  /** Canonical ACTIVE evidence (`selectEvidence(...).activeEvidence.map(r => r.evidence)`). */
  readonly activeEvidence: readonly AdmissionEvidenceV1[];
  /** Detected contradictions (`selectEvidence(...).contradictions`). */
  readonly contradictions?: readonly EvidenceContradiction[];
  /** Waiver lifecycle facts; only authorized, in-scope, unexpired issuances apply. */
  readonly waivers?: readonly WaiverProvenanceV1[];
  /** Out-of-band trust oracle (P01-07). Self-asserted roles cannot authorize. */
  readonly authority: PolicyAuthority;
  /** Trusted RFC3339 evaluation instant. Never `Date.now()`. */
  readonly evaluatedAt: string;
  /** Evidence older than this (created-at to evaluated-at) is stale. */
  readonly freshnessHorizonMs: number;
}

// ─── Internal, pre-waiver disposition ────────────────────────────────────────

type RawDisposition =
  | { readonly kind: 'satisfied'; readonly evidenceIds: readonly EvidenceId[] }
  | {
      readonly kind: 'denied';
      readonly reason: PolicyDenyReason;
      readonly evidenceIds: readonly EvidenceId[];
    }
  | {
      readonly kind: 'indeterminate';
      readonly code: AdmissionIndeterminateCode;
      readonly evidenceIds: readonly EvidenceId[];
    };

interface EvalContext {
  readonly authority: PolicyAuthority;
  readonly evaluatedAt: string;
  readonly freshnessHorizonMs: number;
}

type GateEvidence = Extract<AdmissionEvidenceV1, { kind: 'gate' }>;
type ApprovalEvidence = Extract<AdmissionEvidenceV1, { kind: 'approval' }>;

function sortedIds(evidence: readonly AdmissionEvidenceV1[]): readonly EvidenceId[] {
  return [...new Set(evidence.map((e) => e.evidenceId))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function satisfied(evidence: readonly AdmissionEvidenceV1[]): RawDisposition {
  return { kind: 'satisfied', evidenceIds: sortedIds(evidence) };
}

function denied(
  reason: PolicyDenyReason,
  evidence: readonly AdmissionEvidenceV1[],
): RawDisposition {
  return { kind: 'denied', reason, evidenceIds: sortedIds(evidence) };
}

function indeterminate(
  code: AdmissionIndeterminateCode,
  evidence: readonly AdmissionEvidenceV1[],
): RawDisposition {
  return { kind: 'indeterminate', code, evidenceIds: sortedIds(evidence) };
}

// ─── Per-evidence soundness predicates ───────────────────────────────────────

/** Evidence is well-formed for a requirement iff its subject and attempt match. */
function wellFormed(
  evidence: AdmissionEvidenceV1,
  subject: EvidenceSubjectV1,
  phaseAttemptId: PhaseAttemptId,
): boolean {
  return (
    subjectIdentityKey(evidence.subject) === subjectIdentityKey(subject) &&
    evidence.phaseAttemptId === phaseAttemptId
  );
}

/** Evidence is stale iff its age exceeds the freshness horizon. Fail closed. */
function isStale(evidence: AdmissionEvidenceV1, ctx: EvalContext): boolean {
  const created = Date.parse(evidence.createdAt);
  const now = Date.parse(ctx.evaluatedAt);
  if (Number.isNaN(created) || Number.isNaN(now)) return true;
  return now - created > ctx.freshnessHorizonMs;
}

function isAuthorized(evidence: AdmissionEvidenceV1, ctx: EvalContext): boolean {
  return evidence.kind === 'gate'
    ? ctx.authority.authorizesGateEvidence(evidence.producer)
    : ctx.authority.authorizesApproval(evidence.attributedTo);
}

function isSatisfyingVerdict(evidence: AdmissionEvidenceV1): boolean {
  return evidence.kind === 'gate'
    ? evidence.verdict === 'pass'
    : evidence.verdict === 'approved';
}

/** Independence key: distinct producers / approvers are independent sources. */
function independenceKey(evidence: AdmissionEvidenceV1): string {
  return evidence.kind === 'gate'
    ? `gate:${evidence.producer.producerId}`
    : `approval:${evidence.attributedTo.principalId}`;
}

// ─── Per-kind requirement evaluators ─────────────────────────────────────────

function evaluateGate(
  subject: EvidenceSubjectV1,
  phaseAttemptId: PhaseAttemptId,
  matched: readonly AdmissionEvidenceV1[],
  ctx: EvalContext,
): RawDisposition {
  const gate = matched.filter((e): e is GateEvidence => e.kind === 'gate');
  if (gate.length === 0) return denied('missing', []);

  const malformed = gate.filter((e) => !wellFormed(e, subject, phaseAttemptId));
  if (malformed.length > 0) return denied('malformed', malformed);

  const unauthorized = gate.filter((e) => !isAuthorized(e, ctx));
  if (unauthorized.length > 0) return denied('unauthorized', unauthorized);

  const fresh = gate.filter((e) => !isStale(e, ctx));
  if (fresh.length === 0) return denied('stale', gate);

  const passing = fresh.filter((e) => e.verdict === 'pass');
  if (passing.length > 0) return satisfied(passing);

  const failing = fresh.filter((e) => e.verdict === 'fail');
  if (failing.length > 0) return denied('failed', failing);

  // Well-formed, authorized, fresh — but the gate itself could not decide.
  return indeterminate('EVALUATOR_FAILED', fresh);
}

function evaluateApproval(
  subject: EvidenceSubjectV1,
  phaseAttemptId: PhaseAttemptId,
  minimumApprovals: number,
  matched: readonly AdmissionEvidenceV1[],
  ctx: EvalContext,
): RawDisposition {
  const approvals = matched.filter(
    (e): e is ApprovalEvidence => e.kind === 'approval',
  );
  if (approvals.length === 0) return denied('missing', []);

  const malformed = approvals.filter(
    (e) => !wellFormed(e, subject, phaseAttemptId),
  );
  if (malformed.length > 0) return denied('malformed', malformed);

  const unauthorized = approvals.filter((e) => !isAuthorized(e, ctx));
  if (unauthorized.length > 0) return denied('unauthorized', unauthorized);

  const fresh = approvals.filter((e) => !isStale(e, ctx));
  if (fresh.length === 0) return denied('stale', approvals);

  const approved = fresh.filter((e) => e.verdict === 'approved');
  const distinctApprovers = new Set(
    approved.map((e) => e.attributedTo.principalId),
  );
  if (distinctApprovers.size >= minimumApprovals) return satisfied(approved);

  const rejected = fresh.filter((e) => e.verdict === 'rejected');
  if (rejected.length > 0) return denied('failed', rejected);

  return denied('missing', approved);
}

function evaluateCorroboration(
  subject: EvidenceSubjectV1,
  phaseAttemptId: PhaseAttemptId,
  minimumIndependentSources: number,
  source: readonly AdmissionEvidenceV1[],
  ctx: EvalContext,
): RawDisposition {
  if (source.length === 0) return denied('missing', []);

  const malformed = source.filter((e) => !wellFormed(e, subject, phaseAttemptId));
  if (malformed.length > 0) return denied('malformed', malformed);

  const unauthorized = source.filter((e) => !isAuthorized(e, ctx));
  if (unauthorized.length > 0) return denied('unauthorized', unauthorized);

  const fresh = source.filter((e) => !isStale(e, ctx));
  if (fresh.length === 0) return denied('stale', source);

  const satisfying = fresh.filter(isSatisfyingVerdict);
  const independent = new Set(satisfying.map(independenceKey));
  if (independent.size >= minimumIndependentSources) return satisfied(satisfying);

  return denied('missing', satisfying);
}

// ─── The evaluator ───────────────────────────────────────────────────────────

function evaluateRequirement(
  requirement: AdmissionRequirementV1,
  byRequirement: ReadonlyMap<string, readonly AdmissionEvidenceV1[]>,
  contradicted: ReadonlySet<string>,
  ctx: EvalContext,
): RawDisposition {
  const governingIds =
    requirement.kind === 'corroboration'
      ? [requirement.requirementId, requirement.sourceRequirementId]
      : [requirement.requirementId];

  if (governingIds.some((id) => contradicted.has(id))) {
    const evidence = governingIds.flatMap((id) => byRequirement.get(id) ?? []);
    return denied('contradictory', evidence);
  }

  switch (requirement.kind) {
    case 'gate-evidence':
      return evaluateGate(
        requirement.subject,
        requirement.phaseAttemptId,
        byRequirement.get(requirement.requirementId) ?? [],
        ctx,
      );
    case 'approval':
      return evaluateApproval(
        requirement.subject,
        requirement.phaseAttemptId,
        requirement.minimumApprovals,
        byRequirement.get(requirement.requirementId) ?? [],
        ctx,
      );
    case 'corroboration':
      return evaluateCorroboration(
        requirement.subject,
        requirement.phaseAttemptId,
        requirement.minimumIndependentSources,
        byRequirement.get(requirement.sourceRequirementId) ?? [],
        ctx,
      );
  }
}

/**
 * Evaluate a resolved requirement set against active evidence, contradictions,
 * and waivers into a single three-valued verdict. Pure, total, deterministic:
 * the same input always produces the same (deeply frozen) evaluation.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const ctx: EvalContext = {
    authority: input.authority,
    evaluatedAt: input.evaluatedAt,
    freshnessHorizonMs: input.freshnessHorizonMs,
  };

  const contradicted = new Set<string>();
  for (const contradiction of input.contradictions ?? []) {
    contradicted.add(contradiction.requirementId);
  }

  const byRequirement = new Map<string, AdmissionEvidenceV1[]>();
  for (const evidence of input.activeEvidence) {
    const list = byRequirement.get(evidence.requirementId) ?? [];
    list.push(evidence);
    byRequirement.set(evidence.requirementId, list);
  }

  const waivers = input.waivers ?? [];
  const requirementEvaluations: RequirementEvaluation[] = [];
  const recordedFailures: RecordedFailure[] = [];
  const appliedWaiverIds: WaiverId[] = [];

  for (const requirement of input.requirements) {
    const raw = evaluateRequirement(requirement, byRequirement, contradicted, ctx);

    if (raw.kind === 'satisfied') {
      requirementEvaluations.push({
        requirementId: requirement.requirementId,
        status: 'satisfied',
        evidenceIds: raw.evidenceIds,
      });
      continue;
    }

    if (raw.kind === 'indeterminate') {
      // Indeterminate is first-class and fails closed: a waiver NEVER rescues it.
      requirementEvaluations.push({
        requirementId: requirement.requirementId,
        status: 'indeterminate',
        code: raw.code,
        evidenceIds: raw.evidenceIds,
      });
      continue;
    }

    // Deny-class: a scoped, unexpired, authorized waiver may permit admission —
    // but the failure is still recorded, never rewritten.
    const target: WaiverTarget = {
      requirementId: requirement.requirementId,
      subject: requirement.subject,
      phaseAttemptId: requirement.phaseAttemptId,
    };
    const waiver = selectApplicableWaiver(waivers, target, {
      evaluatedAt: ctx.evaluatedAt,
      waivable: input.obligations.waivable,
      authority: ctx.authority,
    });

    if (waiver !== undefined) {
      requirementEvaluations.push({
        requirementId: requirement.requirementId,
        status: 'waived',
        waiverId: waiver.waiverId,
        waivedReason: raw.reason,
        evidenceIds: raw.evidenceIds,
      });
      appliedWaiverIds.push(waiver.waiverId);
      recordedFailures.push({
        requirementId: requirement.requirementId,
        reason: raw.reason,
        evidenceIds: raw.evidenceIds,
        waived: true,
        waiverId: waiver.waiverId,
      });
    } else {
      requirementEvaluations.push({
        requirementId: requirement.requirementId,
        status: 'denied',
        reason: raw.reason,
        evidenceIds: raw.evidenceIds,
      });
      recordedFailures.push({
        requirementId: requirement.requirementId,
        reason: raw.reason,
        evidenceIds: raw.evidenceIds,
        waived: false,
      });
    }
  }

  const hasDenied = requirementEvaluations.some((e) => e.status === 'denied');
  const hasIndeterminate = requirementEvaluations.some(
    (e) => e.status === 'indeterminate',
  );
  const verdict: PolicyVerdict = hasDenied
    ? 'deny'
    : hasIndeterminate
      ? 'indeterminate'
      : 'allow';

  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  return Object.freeze({
    verdict,
    requirementEvaluations: Object.freeze(
      [...requirementEvaluations].sort((a, b) =>
        byId(a.requirementId, b.requirementId),
      ),
    ),
    recordedFailures: Object.freeze(
      [...recordedFailures].sort((a, b) => byId(a.requirementId, b.requirementId)),
    ),
    appliedWaiverIds: Object.freeze(
      [...new Set(appliedWaiverIds)].sort(byId),
    ),
  });
}

// ─── ActionId-wide authored discriminants ────────────────────────────────────

export interface AuthoredRequirementEvaluationInput {
  /** Authored obligation discriminants — never freeze-time requirement ids. */
  readonly requirements: readonly ActionIdRequirement[];
  /** Lattice projection of those discriminants; `waivable` gates the waiver arm. */
  readonly obligations: ResolvedRequirements;
  readonly evidence: readonly AdmissionEvidenceV1[];
  /** Present only when the snapshot carries a phase attempt. */
  readonly phaseAttemptId?: PhaseAttemptId;
  readonly evaluatedAt: string;
  readonly freshnessHorizonMs: number;
  /** Snapshot-resident authorization predicate; not a self-asserted producer role. */
  readonly authorizesEvidence: (evidence: AdmissionEvidenceV1) => boolean;
}

function evidenceMatchesDiscriminant(
  evidence: AdmissionEvidenceV1,
  requirement: ActionIdRequirement,
): boolean {
  const id = evidence.requirementId;
  if ('family' in requirement) {
    return (
      evidence.kind === 'gate' &&
      (id === requirement.gate ||
        id === `${requirement.family}:${requirement.gate}` ||
        id === `gate:${requirement.family}:${requirement.gate}`)
    );
  }
  if (requirement.kind === 'approvals') {
    return evidence.kind === 'approval';
  }
  return true;
}

function attemptMismatch(
  evidence: AdmissionEvidenceV1,
  phaseAttemptId: PhaseAttemptId | undefined,
): boolean {
  return phaseAttemptId !== undefined && evidence.phaseAttemptId !== phaseAttemptId;
}

function authoredContradiction(matched: readonly AdmissionEvidenceV1[]): boolean {
  const statements = new Set(matched.map(statementOfAuthored));
  return statements.has('satisfied') && statements.has('unsatisfied');
}

function statementOfAuthored(evidence: AdmissionEvidenceV1): EvidenceStatementLike {
  if (evidence.kind === 'approval') {
    return evidence.verdict === 'approved' ? 'satisfied' : 'unsatisfied';
  }
  switch (evidence.verdict) {
    case 'pass':
      return 'satisfied';
    case 'fail':
      return 'unsatisfied';
    case 'indeterminate':
      return 'indeterminate';
  }
}

type EvidenceStatementLike = 'satisfied' | 'unsatisfied' | 'indeterminate';

function evaluateAuthoredRequirement(
  requirement: ActionIdRequirement,
  evidence: readonly AdmissionEvidenceV1[],
  ctx: EvalContext,
  phaseAttemptId: PhaseAttemptId | undefined,
  authorizesEvidence: (evidence: AdmissionEvidenceV1) => boolean,
): RawDisposition {
  const matched = evidence.filter((item) =>
    evidenceMatchesDiscriminant(item, requirement),
  );
  if (matched.length === 0) return denied('missing', []);

  const malformed = matched.filter((item) => attemptMismatch(item, phaseAttemptId));
  if (malformed.length > 0) return denied('malformed', malformed);

  const unauthorized = matched.filter((item) => !authorizesEvidence(item));
  if (unauthorized.length > 0) return denied('unauthorized', unauthorized);

  const fresh = matched.filter((item) => !isStale(item, ctx));
  if (fresh.length === 0) return denied('stale', matched);

  if (authoredContradiction(fresh)) return denied('contradictory', fresh);

  if ('family' in requirement) {
    const passing = fresh.filter((item) => item.kind === 'gate' && item.verdict === 'pass');
    if (passing.length > 0) return satisfied(passing);
    const failing = fresh.filter((item) => item.kind === 'gate' && item.verdict === 'fail');
    if (failing.length > 0) return denied('failed', failing);
    return indeterminate('EVALUATOR_FAILED', fresh);
  }

  if (requirement.kind === 'approvals') {
    const approved = fresh.filter(
      (item): item is ApprovalEvidence =>
        item.kind === 'approval' && item.verdict === 'approved',
    );
    const distinct = new Set(approved.map((item) => item.attributedTo.principalId));
    if (distinct.size >= requirement.minimum) return satisfied(approved);
    const rejected = fresh.filter(
      (item) => item.kind === 'approval' && item.verdict === 'rejected',
    );
    if (rejected.length > 0) return denied('failed', rejected);
    return denied('missing', approved);
  }

  const satisfying = fresh.filter(isSatisfyingVerdict);
  const independent = new Set(satisfying.map(independenceKey));
  if (independent.size >= requirement.minimum) return satisfied(satisfying);
  return denied('missing', satisfying);
}

/**
 * Evaluate authored ActionId-wide requires against snapshot-resident evidence.
 *
 * Discriminants are matched by their authored keys, not by minted requirement
 * ids. A waiver-bearing (waivable) miss without a phase attempt is
 * indeterminate — the waiver arm is not evaluated when the snapshot has no
 * attempt to bind. Contradictory, stale, unauthorized, failed, or missing
 * evidence never allows.
 */
export function evaluateAuthoredRequirements(
  input: AuthoredRequirementEvaluationInput,
): { readonly verdict: PolicyVerdict } {
  const ctx: EvalContext = {
    authority: DENY_ALL_AUTHORITY,
    evaluatedAt: input.evaluatedAt,
    freshnessHorizonMs: input.freshnessHorizonMs,
  };

  const dispositions: RawDisposition[] = [];
  for (const requirement of input.requirements) {
    dispositions.push(
      evaluateAuthoredRequirement(
        requirement,
        input.evidence,
        ctx,
        input.phaseAttemptId,
        input.authorizesEvidence,
      ),
    );
  }

  const hasDenied = dispositions.some((item) => item.kind === 'denied');
  const hasIndeterminate = dispositions.some((item) => item.kind === 'indeterminate');
  if (hasDenied) {
    const waiverEligibleMiss =
      input.obligations.waivable &&
      input.phaseAttemptId === undefined &&
      dispositions.every(
        (item) =>
          item.kind !== 'denied' ||
          item.reason === 'missing' ||
          item.reason === 'failed',
      );
    if (waiverEligibleMiss) {
      return Object.freeze({ verdict: 'indeterminate' as const });
    }
    return Object.freeze({ verdict: 'deny' as const });
  }
  if (hasIndeterminate) {
    return Object.freeze({ verdict: 'indeterminate' as const });
  }
  return Object.freeze({ verdict: 'allow' as const });
}
