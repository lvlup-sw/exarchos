// ─── P07-01 / Transition tasks 027, 051 — Shadow decisions (side-by-side) ─────
//
// The evidence-backed admission engine (P06-02..P06-06) is fully built but is
// NOT yet the production decision-maker: the legacy HSM guard path still
// decides. This module runs BOTH decisions for a single transition attempt,
// keeps the LEGACY decision authoritative, and records the pair together with a
// typed disagreement classification. It changes NO production behavior — the
// admission verdict is observed and recorded only.
//
// Three load-bearing safety properties (Transition task 027):
//
//   1. Legacy stays authoritative. {@link runShadowDecision} RECEIVES the
//      already-computed legacy decision and returns it byte-identical. The
//      shadow can never rewrite it — behaviour preservation is structural, not
//      a convention.
//   2. Shadow evaluation never throws into the production path. The admission
//      adjudication runs inside a `try/catch`; a shadow failure becomes a
//      recorded `shadow-error`, never a propagated exception.
//   3. Disagreements are TYPED, and each carries an explicit disposition with a
//      reason. An `unexplained` disposition is the only thing the cutover gate
//      blocks on (P06-04's `indeterminate` is distinct from `deny`, and a
//      legacy-defect disagreement is `explained`, not unexplained).
//
// The disagreement record is deliberately self-contained (P06-06's
// `decision-explanation.ts` may enrich the human-readable reason once it lands;
// the seam is the injected `explain` resolver). The event producers at the foot
// of this file map the record onto the already-registered, previously-inert
// `admission.shadow-attempt` / `admission.disagreement-disposition` replay
// shapes (event-store/schemas.ts), so recording a disagreement is event-sourced
// by construction.

import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
  type AdmissionDisagreementDisposition,
  type AdmissionShadowAttempt,
} from '../../event-store/schemas.js';
import type { PhaseKind } from '../phase-kind.js';
import type { PolicyVerdict } from './policy-evaluation.js';
import type {
  AdmissionDecisionRecordV1,
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  ContentDigestV1,
  EvidenceSubjectV1,
  OperationId,
  PhaseAttemptId,
} from './types.js';

// ─── Verdict algebra ──────────────────────────────────────────────────────────

/** The legacy HSM guard path is two-valued: it either permits or refuses. */
export type LegacyOutcome = 'allow' | 'deny';

/**
 * The admission verdict is the three-valued {@link PolicyVerdict} from P06-04.
 * `indeterminate` is a first-class outcome, NOT a synonym for `deny`.
 */
export type AdmissionVerdict = PolicyVerdict;

/**
 * The shadow (admission) result. `error` captures a shadow evaluation that
 * threw — recorded, never propagated into the authoritative path.
 */
export type ShadowAdmissionResult =
  | { readonly status: 'evaluated'; readonly verdict: AdmissionVerdict }
  | { readonly status: 'error'; readonly error: string };

// ─── Disagreement classes ─────────────────────────────────────────────────────

/**
 * The typed disagreement classes. `admission-indeterminate` is deliberately its
 * own class: a legacy `deny` vs admission `indeterminate` is a DIFFERENT thing
 * from a legacy `allow` vs admission `deny` (P06-04 — indeterminate ≠ deny).
 */
export type DisagreementClass =
  | 'agree'
  | 'legacy-allow-admission-deny'
  | 'legacy-deny-admission-allow'
  | 'admission-indeterminate'
  | 'shadow-error';

export const DISAGREEMENT_CLASSES: readonly DisagreementClass[] = Object.freeze([
  'agree',
  'legacy-allow-admission-deny',
  'legacy-deny-admission-allow',
  'admission-indeterminate',
  'shadow-error',
]);

/**
 * The disposition assigned to a disagreement. `agree` is the non-disagreement
 * sentinel; the other four are exactly the `admission.disagreement-disposition`
 * event enum. Only `unexplained` blocks the cutover gate.
 */
export type DisagreementDisposition =
  | 'agree'
  | 'explained-legacy'
  | 'explained-admission'
  | 'accepted-risk'
  | 'unexplained';

/** Dispositions that leave the cutover gate open (i.e. do not block it). */
const EXPLAINED_DISPOSITIONS: ReadonlySet<DisagreementDisposition> = new Set([
  'agree',
  'explained-legacy',
  'explained-admission',
  'accepted-risk',
]);

/** True iff the disposition is anything other than `unexplained`. */
export function isExplainedDisposition(
  disposition: DisagreementDisposition,
): boolean {
  return EXPLAINED_DISPOSITIONS.has(disposition);
}

// ─── Classifier (pure) ─────────────────────────────────────────────────────────

/**
 * Classify the legacy/admission pair. Total and pure. Precedence:
 *   - a shadow error dominates (there is no admission verdict to compare);
 *   - an admission `indeterminate` is its own class regardless of the legacy
 *     verdict (it can never be an `agree`, and it is not a `deny`);
 *   - otherwise the two two-valued verdicts either agree or name the direction
 *     of the disagreement.
 */
export function classifyShadowOutcome(
  legacy: LegacyOutcome,
  admission: ShadowAdmissionResult,
): DisagreementClass {
  if (admission.status === 'error') return 'shadow-error';
  if (admission.verdict === 'indeterminate') return 'admission-indeterminate';
  if (legacy === admission.verdict) return 'agree';
  if (legacy === 'allow' && admission.verdict === 'deny') {
    return 'legacy-allow-admission-deny';
  }
  return 'legacy-deny-admission-allow';
}

/** True iff the class is anything other than `agree`. */
export function isDisagreement(cls: DisagreementClass): boolean {
  return cls !== 'agree';
}

// ─── Attempt + record shapes ───────────────────────────────────────────────────

/**
 * The minimal, side-effect-free observation the LIVE guard path surfaces to an
 * injected shadow observer after it has computed the authoritative legacy
 * decision. Carrying only this keeps the hook non-invasive: the live path never
 * runs the admission engine itself.
 */
export interface LegacyTransitionObservation {
  readonly workflowType: string;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly legacyOutcome: LegacyOutcome;
  /** True iff the legacy attempt was an idempotent no-op (already in target). */
  readonly idempotent: boolean;
}

/** The authoritative legacy decision, returned untouched by the runner. */
export interface LegacyDecision {
  readonly outcome: LegacyOutcome;
  /** Optional legacy diagnostic (guard failure message, etc.). */
  readonly detail?: string;
  /** True iff the attempt was an idempotent no-op. */
  readonly idempotent?: boolean;
}

/** Everything a shadow comparison needs to describe the attempt it covers. */
export interface ShadowAttempt {
  readonly workflowType: string;
  readonly fromPhase: string;
  readonly toPhase: string;
  /** The kind of the target phase (drives cutover-gate coverage). */
  readonly phaseKind: PhaseKind;
  /** The legacy guard id on this edge, when one exists. */
  readonly guardId?: string;
  /** Stable id for the compared attempt (used when this is event-sourced). */
  readonly attemptId?: string;
}

/** The disposition + human-readable reason for a disagreement. */
export interface DisagreementExplanation {
  readonly disposition: DisagreementDisposition;
  readonly reason: string;
}

/** Context handed to an injected {@link ExplainResolver}. */
export interface ExplainContext {
  readonly attempt: ShadowAttempt;
  readonly disagreementClass: DisagreementClass;
  readonly legacy: LegacyDecision;
  readonly admission: ShadowAdmissionResult;
}

/**
 * Resolves the disposition/reason for a disagreement. Injected so the corpus
 * (which knows the P06-01 legacy defect inventory) and future consumers (P06-06
 * `decision-explanation.ts`) can supply richer reasons without this module
 * depending on either. Never invoked for `agree`.
 */
export type ExplainResolver = (ctx: ExplainContext) => DisagreementExplanation;

/** The self-contained, typed shadow disagreement record (Transition task 027). */
export interface ShadowDecisionRecord {
  readonly attempt: ShadowAttempt;
  readonly legacyOutcome: LegacyOutcome;
  readonly admission: ShadowAdmissionResult;
  readonly disagreementClass: DisagreementClass;
  readonly disposition: DisagreementDisposition;
  /** Convenience: `true` iff the disposition does not block the gate. */
  readonly explained: boolean;
  readonly reason: string;
}

export interface ShadowRunInput {
  readonly attempt: ShadowAttempt;
  /** The authoritative legacy decision — already computed, returned untouched. */
  readonly legacy: LegacyDecision;
  /**
   * Computes the shadow admission verdict. MAY throw; a throw is captured as a
   * `shadow-error` and never propagated. Deferred (a thunk) so the shadow cost
   * is only paid when a comparison is actually run.
   */
  readonly adjudicateAdmission: () => AdmissionVerdict;
  /** Resolves the disposition/reason for any disagreement. */
  readonly explain: ExplainResolver;
}

export interface ShadowRunResult {
  /** The authoritative legacy decision, byte-identical to the input. */
  readonly legacy: LegacyDecision;
  readonly record: ShadowDecisionRecord;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Run the admission decision beside the (already-decided) legacy decision and
 * produce a typed disagreement record. The legacy decision is authoritative and
 * is returned untouched; the admission adjudication is error-isolated.
 *
 * This function performs NO I/O and mutates nothing — it is safe to call from
 * the production guard path (via an injected observer) because it cannot alter
 * the returned legacy decision and cannot throw out of the shadow computation.
 */
export function runShadowDecision(input: ShadowRunInput): ShadowRunResult {
  const { attempt, legacy, adjudicateAdmission, explain } = input;

  let admission: ShadowAdmissionResult;
  try {
    admission = { status: 'evaluated', verdict: adjudicateAdmission() };
  } catch (err) {
    admission = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const disagreementClass = classifyShadowOutcome(legacy.outcome, admission);

  const explanation: DisagreementExplanation =
    disagreementClass === 'agree'
      ? { disposition: 'agree', reason: 'legacy and admission agree' }
      : explain({ attempt, disagreementClass, legacy, admission });

  const record: ShadowDecisionRecord = {
    attempt,
    legacyOutcome: legacy.outcome,
    admission,
    disagreementClass,
    disposition: explanation.disposition,
    explained: isExplainedDisposition(explanation.disposition),
    reason: explanation.reason,
  };

  // Legacy is returned by reference — behaviour preservation is structural.
  return { legacy, record };
}

// ─── Aggregate view ────────────────────────────────────────────────────────────

export interface ShadowDisagreementSummary {
  readonly total: number;
  readonly agreements: number;
  readonly disagreements: number;
  readonly explained: number;
  readonly unexplained: number;
  readonly byClass: Readonly<Record<DisagreementClass, number>>;
}

/** Fold a batch of shadow records into counts the cutover gate consumes. */
export function summarizeShadowDecisions(
  records: readonly ShadowDecisionRecord[],
): ShadowDisagreementSummary {
  const byClass: Record<DisagreementClass, number> = {
    'agree': 0,
    'legacy-allow-admission-deny': 0,
    'legacy-deny-admission-allow': 0,
    'admission-indeterminate': 0,
    'shadow-error': 0,
  };
  let agreements = 0;
  let disagreements = 0;
  let explained = 0;
  let unexplained = 0;
  for (const record of records) {
    byClass[record.disagreementClass] += 1;
    if (isDisagreement(record.disagreementClass)) {
      disagreements += 1;
      if (record.disposition === 'unexplained') unexplained += 1;
      else explained += 1;
    } else {
      agreements += 1;
    }
  }
  return {
    total: records.length,
    agreements,
    disagreements,
    explained,
    unexplained,
    byClass: Object.freeze(byClass),
  };
}

// ─── Event producers (event-sourced recording) ────────────────────────────────

/** Trusted provenance stamped on every recorded shadow fact (P01-07). */
export interface ShadowProvenance {
  readonly caller: AttributedPrincipalV1;
  readonly authorization: AuthorizationSnapshotV1;
}

/** Map an internal disposition onto the persisted event enum. */
function dispositionToEventValue(
  disposition: DisagreementDisposition,
): AdmissionDisagreementDisposition['disposition'] {
  switch (disposition) {
    case 'explained-legacy':
      return 'explained-legacy';
    case 'explained-admission':
      return 'explained-admission';
    case 'accepted-risk':
      return 'accepted-risk';
    case 'unexplained':
      return 'unexplained';
    case 'agree':
      throw new Error(
        'cannot record a disagreement-disposition event for an agreement',
      );
  }
}

export interface DisagreementDispositionEventInput {
  readonly record: ShadowDecisionRecord;
  readonly dispositionId: string;
  readonly shadowAttemptId: string;
  readonly recordedAt: string;
  readonly provenance: ShadowProvenance;
}

/**
 * Build a schema-validated `admission.disagreement-disposition` payload for a
 * recorded disagreement. Throws for an `agree` record (there is nothing to
 * dispose of) and for a payload that fails the registered zod schema — so an
 * invalid disagreement fact can never be laundered onto the log.
 */
export function toDisagreementDispositionData(
  input: DisagreementDispositionEventInput,
): AdmissionDisagreementDisposition {
  const { record, dispositionId, shadowAttemptId, recordedAt, provenance } =
    input;
  if (!isDisagreement(record.disagreementClass)) {
    throw new Error(
      'toDisagreementDispositionData requires a disagreement record',
    );
  }
  return AdmissionDisagreementDispositionData.parse({
    eventVersion: '1.0',
    dispositionId,
    shadowAttemptId,
    disposition: dispositionToEventValue(record.disposition),
    rationale: record.reason,
    recordedAt,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
}

export interface ShadowAttemptEventInput {
  readonly record: ShadowDecisionRecord;
  readonly shadowAttemptId: string;
  readonly operationId: OperationId;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly evidenceSetDigest: ContentDigestV1;
  /**
   * The persisted admission decision this shadow compared against. In P07-01
   * the full evidence-backed decision record is produced by P06-05's
   * `runTransitionCommand`; wiring the legacy state through that pipeline is the
   * P07-02 seam. The caller supplies the decision so the event stays a faithful
   * pairing rather than a fabricated stand-in.
   */
  readonly decision: AdmissionDecisionRecordV1;
  readonly attemptedAt: string;
  readonly provenance: ShadowProvenance;
}

/**
 * Build a schema-validated `admission.shadow-attempt` payload pairing the
 * authoritative legacy outcome with the admission decision record. Validated
 * against the registered zod schema.
 */
export function toShadowAttemptData(
  input: ShadowAttemptEventInput,
): AdmissionShadowAttempt {
  const {
    record,
    shadowAttemptId,
    operationId,
    phaseAttemptId,
    subject,
    evidenceSetDigest,
    decision,
    attemptedAt,
    provenance,
  } = input;
  return AdmissionShadowAttemptData.parse({
    eventVersion: '1.0',
    shadowAttemptId,
    operationId,
    phaseAttemptId,
    legacyOutcome: record.legacyOutcome,
    subject,
    evidenceSetDigest,
    decision,
    attemptedAt,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
}
