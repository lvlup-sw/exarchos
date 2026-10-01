/**
 * Scoped, expiring waivers.
 *
 * A waiver is a separate, authorized artifact that permits admission despite a recorded failure.
 * It does not change the failed evidence. That failure stays on record and in reports.
 * A waiver applies to a target only when all of these checks pass, in this order:
 *   1. The waiver is an issuance. A revoked or superseded fact never grants.
 *   2. The resolved obligation set is waivable.
 *   3. The waiver declares the requirement id in `waivedRequirementIds`.
 *   4. The waiver scope covers the target subject.
 *   5. The evaluation instant is strictly before `expiresAt`.
 *   6. The trust authority accepts the waiver actor. A role on the record cannot authorize.
 * Each failed check gives one fixed reason. The module does no I/O, and "now" is a trusted input.
 */

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

/** The requirement instance that a waiver is evaluated against. */
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
  /** The out-of-band trust oracle. A self-asserted role cannot authorize. */
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
 * A stable identity key for an evidence subject: kind, id and content digest.
 * Two subjects are the same target only when their keys are equal.
 * Thus a waiver for one digest never covers another subject or a new digest.
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
 * True when the waiver scope covers the target. The check fails closed.
 * A subject scope must match the exact subject identity key.
 * A phase-attempt scope must match the target phase-attempt id.
 * A workflow scope covers only a workflow subject with the same workflow id.
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
 * True when `evaluatedAt` is strictly before `expiresAt`.
 * It compares epoch millis, because a text compare is wrong across different offsets.
 * An instant that does not parse counts as expired.
 */
function beforeExpiry(evaluatedAt: string, expiresAt: string): boolean {
  const now = Date.parse(evaluatedAt);
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expiry)) return false;
  return now < expiry;
}

/**
 * Evaluates one waiver against one requirement target.
 * The first failed check, in the order of the file header, sets the reason.
 * The function does not change the failed evidence.
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
 * Returns the first waiver that applies to the target, or `undefined`.
 * It sorts the candidates by `waiverId`, so the input order does not change the result.
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
