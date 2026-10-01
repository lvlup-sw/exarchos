/**
 * Shadow decisions: run the admission engine beside the legacy HSM guard path for one transition attempt.
 * The legacy decision stays authoritative. The module records the pair with a typed disagreement class and changes no production behavior.
 *
 * Three safety properties apply:
 *  1. {@link runShadowDecision} receives the legacy decision and returns it by reference, so the shadow cannot change it.
 *  2. A throw from the admission adjudication becomes a recorded `shadow-error`. It does not propagate.
 *  3. Each disagreement carries a disposition and a reason. Only an `unexplained` disposition blocks the cutover gate.
 *
 * The event producers map a record onto the `admission.shadow-attempt` and `admission.disagreement-disposition` payloads.
 */

import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
  type AdmissionDisagreementDisposition,
  type AdmissionShadowAttempt,
} from '../../events/schemas.js';
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

/** The legacy HSM guard path is two-valued: it either permits or refuses. */
export type LegacyOutcome = 'allow' | 'deny';

/** The three-valued admission {@link PolicyVerdict}. `indeterminate` is its own outcome, not a synonym for `deny`. */
export type AdmissionVerdict = PolicyVerdict;

/** The shadow admission result. `error` records a shadow evaluation that threw. */
export type ShadowAdmissionResult =
  | { readonly status: 'evaluated'; readonly verdict: AdmissionVerdict }
  | { readonly status: 'error'; readonly error: string };

/**
 * The typed disagreement classes.
 * `admission-indeterminate` is its own class, because an `indeterminate` verdict is not a `deny`.
 */
export type DisagreementClass =
  | 'agree'
  | 'legacy-allow-admission-deny'
  | 'legacy-deny-admission-allow'
  | 'admission-indeterminate'
  | 'shadow-error';

/** Every {@link DisagreementClass}, in a frozen list. */
export const DISAGREEMENT_CLASSES: readonly DisagreementClass[] = Object.freeze([
  'agree',
  'legacy-allow-admission-deny',
  'legacy-deny-admission-allow',
  'admission-indeterminate',
  'shadow-error',
]);

/**
 * The disposition of a disagreement. `agree` marks a pair that does not disagree.
 * The other four are the `admission.disagreement-disposition` event enum. Only `unexplained` blocks the cutover gate.
 */
export type DisagreementDisposition =
  | 'agree'
  | 'explained-legacy'
  | 'explained-admission'
  | 'accepted-risk'
  | 'unexplained';

/** Dispositions that do not block the cutover gate. */
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

/**
 * Classify the legacy and admission pair. Total and pure. The precedence is:
 *  1. A shadow error wins, because no admission verdict exists to compare.
 *  2. An admission `indeterminate` is its own class for any legacy verdict.
 *  3. Otherwise the two verdicts agree, or the class names the direction of the disagreement.
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

/**
 * The observation that the live guard path gives to an injected shadow observer after the legacy decision.
 * The live path never runs the admission engine itself.
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
  /** Optional legacy diagnostic, such as a guard failure message. */
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
 * Resolves the disposition and reason for a disagreement. The runner never calls it for `agree`.
 * It is injected, so a caller that knows the legacy defect inventory can supply reasons without a dependency here.
 */
export type ExplainResolver = (ctx: ExplainContext) => DisagreementExplanation;

/** The self-contained, typed shadow disagreement record. */
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

/** The input of {@link runShadowDecision}. */
export interface ShadowRunInput {
  readonly attempt: ShadowAttempt;
  /** The authoritative legacy decision — already computed, returned untouched. */
  readonly legacy: LegacyDecision;
  /**
   * Computes the shadow admission verdict. A throw becomes a `shadow-error` and does not propagate.
   * It is a thunk, so the shadow cost applies only when a comparison runs.
   */
  readonly adjudicateAdmission: () => AdmissionVerdict;
  /** Resolves the disposition/reason for any disagreement. */
  readonly explain: ExplainResolver;
}

/** The result of {@link runShadowDecision}. */
export interface ShadowRunResult {
  /** The authoritative legacy decision, byte-identical to the input. */
  readonly legacy: LegacyDecision;
  readonly record: ShadowDecisionRecord;
}

/**
 * Run the admission decision beside the legacy decision and produce a typed disagreement record.
 * The legacy decision returns by reference, untouched. A throw from the admission adjudication becomes a `shadow-error`.
 * The function itself does no I/O and mutates nothing, so the production guard path can call it through an observer.
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

  return { legacy, record };
}

/** Counts of a batch of shadow records, for the cutover gate. */
export interface ShadowDisagreementSummary {
  readonly total: number;
  readonly agreements: number;
  readonly disagreements: number;
  readonly explained: number;
  readonly unexplained: number;
  readonly byClass: Readonly<Record<DisagreementClass, number>>;
}

/**
 * The minimum that {@link summarizeShadowDecisions} reads: the class and its disposition.
 * A full {@link ShadowDecisionRecord} satisfies it. So does a record that the durable fold rebuilds from the event rows.
 * Those rows carry no edge or phase identity. This minimal view lets the gate count them without invented attempt metadata.
 */
export interface ShadowDispositionView {
  readonly disagreementClass: DisagreementClass;
  readonly disposition: DisagreementDisposition;
}

/** Fold a batch of shadow records into counts the cutover gate consumes. */
export function summarizeShadowDecisions(
  records: readonly ShadowDispositionView[],
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

/** Trusted provenance stamped on every recorded shadow fact. */
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

/** The input of {@link toDisagreementDispositionData}. */
export interface DisagreementDispositionEventInput {
  readonly record: ShadowDecisionRecord;
  readonly dispositionId: string;
  readonly shadowAttemptId: string;
  readonly recordedAt: string;
  readonly provenance: ShadowProvenance;
}

/**
 * Build a schema-validated `admission.disagreement-disposition` payload for a recorded disagreement.
 * It throws for an `agree` record and for a payload that fails the zod schema, so no invalid fact reaches the log.
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

/** The input of {@link toShadowAttemptData}. */
export interface ShadowAttemptEventInput {
  readonly record: ShadowDecisionRecord;
  readonly shadowAttemptId: string;
  readonly operationId: OperationId;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly evidenceSetDigest: ContentDigestV1;
  /**
   * The persisted admission decision that this shadow compared against.
   * The caller supplies it, so the event pairs two real records and invents nothing.
   */
  readonly decision: AdmissionDecisionRecordV1;
  readonly attemptedAt: string;
  readonly provenance: ShadowProvenance;
}

/** Build a schema-validated `admission.shadow-attempt` payload that pairs the legacy outcome with the admission decision record. */
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
