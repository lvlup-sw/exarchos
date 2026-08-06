// ─── P06-04 / Transition tasks 021, 022, 044 — Scoped expiring waivers ───────
//
// A waiver is a SEPARATE, scoped, expiring, authorized artifact that permits
// admission despite a recorded failure. It is emphatically NOT a rewrite of the
// failed evidence: the underlying failure stays on record and stays reported
// (see `policy-evaluation.ts`). This module answers exactly one question about
// one waiver against one target requirement: does it apply?
//
// A waiver applies to a (requirement, subject, phase-attempt) target iff ALL of:
//   1. it is an ISSUANCE (a revoked/superseded lifecycle fact never grants),
//   2. the obligation set is waivable at all (`resolveRequirements(ctx).waivable`),
//   3. the requirement id is in the waiver's DECLARED `waivedRequirementIds`,
//   4. the waiver's SCOPE covers the target subject,
//   5. the target instant is strictly before the waiver's `expiresAt`,
//   6. the waiver's actor is AUTHORIZED to grant waivers (P01-07 trust, not a
//      self-asserted role on the record).
//
// Every failing check yields a specific, deterministic reason, so an explaining
// caller (P06-06) can say precisely why a waiver did not save admission.
//
// Pure: no I/O; the "now" instant is a trusted input, never `Date.now()`.

import type { PolicyAuthority } from './policy-authority.js';
import type {
  EvidenceSubjectV1,
  PhaseAttemptId,
  RequirementId,
  WaiverId,
  WaiverProvenanceV1,
  WaiverScopeV1,
} from './types.js';

/** The issuance arm of the waiver lifecycle — the only arm that can grant. */
export type IssuedWaiver = Extract<WaiverProvenanceV1, { event: 'issued' }>;

/** Narrow a waiver lifecycle fact to its issuance arm. */
export function isIssuedWaiver(
  waiver: WaiverProvenanceV1,
): waiver is IssuedWaiver {
  return waiver.event === 'issued';
}

/** Why a waiver did not apply to a target. Distinct, deterministic, ordered. */
export type WaiverInapplicableReason =
  | 'not-an-issuance'
  | 'not-waivable'
  | 'requirement-not-declared'
  | 'subject-out-of-scope'
  | 'expired'
  | 'unauthorized';

/** The requirement instance a waiver is being tested against. */
export interface WaiverTarget {
  readonly requirementId: RequirementId;
  readonly subject: EvidenceSubjectV1;
  readonly phaseAttemptId: PhaseAttemptId;
}

/** Trusted evaluation inputs a waiver is judged under. */
export interface WaiverEvaluationOptions {
  /** Trusted RFC3339 evaluation instant. Never `Date.now()`. */
  readonly evaluatedAt: string;
  /** Whether the resolved obligation set permits waivers at all. */
  readonly waivable: boolean;
  /** Out-of-band trust oracle; a self-asserted role cannot authorize. */
  readonly authority: PolicyAuthority;
}

/** The verdict for one waiver against one target. */
export type WaiverApplicability =
  | { readonly waiverId: WaiverId; readonly applies: true }
  | {
      readonly waiverId: WaiverId;
      readonly applies: false;
      readonly reason: WaiverInapplicableReason;
    };

/**
 * A stable identity key for an evidence subject — kind, id, and content digest.
 * Two subjects are the same target iff their keys are equal, so a waiver bound
 * to subject A's digest never silently covers subject B or a re-digested A.
 */
export function subjectIdentityKey(subject: EvidenceSubjectV1): string {
  const digest = `${subject.digest.algorithm}:${subject.digest.value}`;
  switch (subject.kind) {
    case 'workflow':
      return `workflow:${subject.workflowId}:${digest}`;
    case 'phase-attempt':
      return `phase-attempt:${subject.phaseAttemptId}:${digest}`;
    case 'wave':
      return `wave:${subject.waveId}:${digest}`;
    case 'task':
      return `task:${subject.taskId}:${digest}`;
    case 'commit':
      return `commit:${subject.commitId}:${digest}`;
    case 'diff':
      return `diff:${subject.diffId}:${digest}`;
    case 'artifact':
      return `artifact:${subject.artifactId}:${digest}`;
  }
}

/**
 * Whether a waiver's declared scope covers a target subject/phase-attempt.
 *
 * The three scopes are read CONSERVATIVELY (fail-closed): a subject scope must
 * match the exact subject identity (kind + id + digest); a phase-attempt scope
 * must match the target's phase-attempt id; a workflow scope covers only a
 * workflow-kind subject with the matching workflow id. Nothing is inferred
 * across the subject graph, so a scope never over-applies.
 */
export function waiverScopeCovers(
  scope: WaiverScopeV1,
  target: WaiverTarget,
): boolean {
  switch (scope.kind) {
    case 'subject':
      return subjectIdentityKey(scope.subject) === subjectIdentityKey(target.subject);
    case 'phase-attempt':
      return scope.phaseAttemptId === target.phaseAttemptId;
    case 'workflow':
      return (
        target.subject.kind === 'workflow' &&
        target.subject.workflowId === scope.workflowId
      );
  }
}

/**
 * True iff `evaluatedAt` is strictly before `expiresAt`. Both are RFC3339 with
 * an offset, so parse to epoch millis before comparing (a lexical compare is
 * wrong across differing offsets). An unparseable instant is treated as expired
 * — fail closed.
 */
function beforeExpiry(evaluatedAt: string, expiresAt: string): boolean {
  const now = Date.parse(evaluatedAt);
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expiry)) return false;
  return now < expiry;
}

/**
 * Evaluate one waiver against one requirement target. Total and deterministic:
 * the first failing gate (in the order documented at the top of the module)
 * fixes the reason. The underlying failed evidence is never touched — this
 * function only decides whether the waiver *permits admission despite* it.
 */
export function evaluateWaiver(
  waiver: WaiverProvenanceV1,
  target: WaiverTarget,
  options: WaiverEvaluationOptions,
): WaiverApplicability {
  const deny = (reason: WaiverInapplicableReason): WaiverApplicability => ({
    waiverId: waiver.waiverId,
    applies: false,
    reason,
  });

  if (!isIssuedWaiver(waiver)) return deny('not-an-issuance');
  if (!options.waivable) return deny('not-waivable');
  if (!waiver.waivedRequirementIds.includes(target.requirementId)) {
    return deny('requirement-not-declared');
  }
  if (!waiverScopeCovers(waiver.scope, target)) return deny('subject-out-of-scope');
  if (!beforeExpiry(options.evaluatedAt, waiver.expiresAt)) return deny('expired');
  if (!options.authority.authorizesWaiver(waiver.actor, waiver.authorization)) {
    return deny('unauthorized');
  }
  return { waiverId: waiver.waiverId, applies: true };
}

/**
 * The single applicable waiver for a target, or `undefined` if none applies.
 * Candidates are considered in ascending `waiverId` order so the choice is
 * independent of input order; the first that applies wins.
 */
export function selectApplicableWaiver(
  waivers: readonly WaiverProvenanceV1[],
  target: WaiverTarget,
  options: WaiverEvaluationOptions,
): IssuedWaiver | undefined {
  const ordered = [...waivers].sort((a, b) =>
    a.waiverId < b.waiverId ? -1 : a.waiverId > b.waiverId ? 1 : 0,
  );
  for (const waiver of ordered) {
    if (evaluateWaiver(waiver, target, options).applies && isIssuedWaiver(waiver)) {
      return waiver;
    }
  }
  return undefined;
}
