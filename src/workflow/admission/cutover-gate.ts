/**
 * The cutover gate decides when enforcement can move from the legacy HSM guard path to the admission engine.
 *
 * RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31)
 *
 * Enforcement can flip only when all six conditions hold:
 *   1. `deterministic-corpus-clean`: the shadow corpus has zero unexplained disagreements.
 *   2. `live-attempt-threshold`: at least {@link MINIMUM_LIVE_ATTEMPTS} comparable live attempts exist.
 *   3. `phase-kind-coverage`: the comparable attempts cover every {@link PhaseKind}.
 *   4. `outcome-coverage`: the comparable attempts include both `allow` and `deny`.
 *   5. `live-disagreement-class`: durable evidence exists, and every attempt has a comparable verdict.
 *   6. `live-observer-health`: the observer is healthy. A dead observer never reads as a clean gate.
 * The report names each unmet condition. An `admission.enforcement-enabled` fact needs a satisfied gate.
 */
import {
  AdmissionEnforcementEnabledData,
  AdmissionRolloutDecisionData,
  AdmissionShadowAttemptData,
  type AdmissionEnforcementEnabled,
  type AdmissionRolloutDecision,
} from '../../events/schemas.js';
import type { PhaseKind } from '../phase-kind.js';
import {
  liveShadowEvidenceStreamId,
  liveShadowObserverStatus,
  type LiveShadowHealth,
  type LiveShadowObserverStatus,
} from './live-shadow-observer.js';
import {
  classifyShadowOutcome,
  summarizeShadowDecisions,
  type DisagreementClass,
  type ShadowDispositionView,
  type ShadowProvenance,
} from './shadow-decision.js';
import {
  ADMISSION_EVENT_TYPES,
  type ContentDigestV1,
  type EvidenceId,
  type OperationId,
  type PolicyId,
} from './types.js';

/**
 * Every {@link PhaseKind}. The `satisfies` clause makes a missing kind a compile error.
 * Thus `phase-kind-coverage` never drops a kind.
 */
const PHASE_KIND_PRESENCE = {
  IMPLEMENT: true,
  PLAN: true,
  REVIEW: true,
  SYNTHESIZE: true,
  MERGE: true,
  GATHER: true,
} as const satisfies Record<PhaseKind, true>;

export const ALL_PHASE_KINDS: readonly PhaseKind[] = Object.freeze(
  Object.keys(PHASE_KIND_PRESENCE) as PhaseKind[],
);

/** The minimum number of live shadow attempts the gate demands. */
export const MINIMUM_LIVE_ATTEMPTS = 20;

/** The enforcement outcome the legacy path produced for a live attempt. */
export type LiveAttemptOutcome = 'allow' | 'deny';

/**
 * The classes in which the admission engine gave a verdict to compare with the legacy one.
 * `shadow-error` and `admission-indeterminate` are not here, so they never count as coverage.
 */
const COMPARABLE_CLASSES: ReadonlySet<DisagreementClass> = new Set([
  'agree',
  'legacy-allow-admission-deny',
  'legacy-deny-admission-allow',
]);

/** True when the class records an admission verdict that compares with the legacy one. */
export function isComparableShadowClass(cls: DisagreementClass): boolean {
  return COMPARABLE_CLASSES.has(cls);
}

/** One recorded live shadow attempt. */
export interface LiveShadowAttempt {
  readonly phaseKind: PhaseKind;
  /** The LEGACY verdict. Alone it says nothing about the admission engine. */
  readonly outcome: LiveAttemptOutcome;
  /**
   * How the admission verdict relates to the legacy one.
   * It is required, because without it an attempt looks the same as one whose adjudication threw.
   */
  readonly disagreementClass: DisagreementClass;
}

/**
 * One `admission.shadow-attempt` fact from the durable sidecar stream.
 * {@link classifyShadowOutcome} derives the class, as on the live path, so the two readings cannot drift.
 * It has no `phaseKind`, because the event schema does not carry one.
 */
export interface DurableShadowAttemptFact {
  readonly legacyOutcome: LiveAttemptOutcome;
  readonly disagreementClass: DisagreementClass;
}

/** The `EventStore` slice that reads the durable shadow streams. */
export interface DurableShadowEvidenceReader {
  query(
    streamId: string,
    filters?: { type?: string | undefined } | undefined,
  ): Promise<readonly { readonly type: string; readonly data?: unknown }[]>;
}

/**
 * Reads the shadow-attempt facts from the sidecar stream of each feature and derives each class.
 * The gate uses these durable facts and not the in-memory ring buffer.
 * After a restart, an empty buffer cannot tell "no disagreements" from "the observer never ran".
 * The function drops an event that fails schema validation and never defaults it to `agree`.
 */
export async function readDurableShadowAttempts(
  reader: DurableShadowEvidenceReader,
  featureIds: readonly string[],
): Promise<readonly DurableShadowAttemptFact[]> {
  const facts: DurableShadowAttemptFact[] = [];
  for (const featureId of featureIds) {
    const events = await reader.query(liveShadowEvidenceStreamId(featureId), {
      type: ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT,
    });
    for (const event of events) {
      if (event.type !== ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT) continue;
      const parsed = AdmissionShadowAttemptData.safeParse(event.data);
      if (!parsed.success) continue;
      facts.push({
        legacyOutcome: parsed.data.legacyOutcome,
        disagreementClass: classifyShadowOutcome(parsed.data.legacyOutcome, {
          status: 'evaluated',
          verdict: parsed.data.decision.outcome,
        }),
      });
    }
  }
  return facts;
}

/** Everything the gate weighs. */
export interface CutoverGateEvidence {
  /**
   * Shadow records with their dispositions. In tests this is the deterministic corpus run.
   * In production, `evidence-reader.ts` folds the durable attempts and dispositions.
   * An undisposed live disagreement blocks `deterministic-corpus-clean` until a human records an explained disposition.
   */
  readonly corpusRecords: readonly ShadowDispositionView[];
  /** Live shadow attempts observed against real workflows. */
  readonly liveAttempts: readonly LiveShadowAttempt[];
  /** The same attempts, read from the durable sidecar streams. Process memory alone cannot justify a cutover. */
  readonly durableAttempts: readonly DurableShadowAttemptFact[];
  /** The observer health reading. Thus "no evidence" always comes with the observer status. */
  readonly observerHealth: LiveShadowHealth;
}

export type GateConditionId =
  | 'deterministic-corpus-clean'
  | 'live-attempt-threshold'
  | 'phase-kind-coverage'
  | 'outcome-coverage'
  | 'live-disagreement-class'
  | 'live-observer-health';

export interface GateCondition {
  readonly id: GateConditionId;
  readonly met: boolean;
  readonly detail: string;
}

/** A count for each {@link DisagreementClass}. Every class is always present. */
export type DisagreementClassTally = Readonly<Record<DisagreementClass, number>>;

export interface CutoverGateReport {
  /** True when every condition is met. */
  readonly satisfied: boolean;
  readonly conditions: readonly GateCondition[];
  /** The ids of the unmet conditions. It is empty only when the gate is satisfied. */
  readonly unmet: readonly GateConditionId[];
  readonly unexplainedDisagreements: number;
  /** ALL live attempts, comparable or not. */
  readonly liveAttemptCount: number;
  /** The live attempts with a comparable admission verdict. Coverage counts only these. */
  readonly comparableLiveAttemptCount: number;
  /** The live attempts with a missing (`shadow-error`) or undecided admission verdict. */
  readonly nonComparableLiveAttemptCount: number;
  readonly liveDisagreementClasses: DisagreementClassTally;
  /** The attempts read from the durable sidecar streams. */
  readonly durableAttemptCount: number;
  readonly nonComparableDurableAttemptCount: number;
  readonly durableDisagreementClasses: DisagreementClassTally;
  readonly observerStatus: LiveShadowObserverStatus;
  readonly coveredPhaseKinds: readonly PhaseKind[];
  readonly missingPhaseKinds: readonly PhaseKind[];
  readonly hasAllowOutcome: boolean;
  readonly hasDenyOutcome: boolean;
}

function emptyTally(): Record<DisagreementClass, number> {
  return {
    'agree': 0,
    'legacy-allow-admission-deny': 0,
    'legacy-deny-admission-allow': 0,
    'admission-indeterminate': 0,
    'shadow-error': 0,
  };
}

function tally(
  classes: readonly DisagreementClass[],
): Record<DisagreementClass, number> {
  const counts = emptyTally();
  for (const cls of classes) counts[cls] += 1;
  return counts;
}

/**
 * Evaluates the six conditions independently and folds them into a report. It does no I/O.
 * Only attempts that the admission engine decided count as coverage.
 * Thus 20 attempts that all threw are 20 non-comparisons.
 */
export function evaluateCutoverGate(
  evidence: CutoverGateEvidence,
): CutoverGateReport {
  const summary = summarizeShadowDecisions(evidence.corpusRecords);
  const unexplainedDisagreements = summary.unexplained;

  const liveAttemptCount = evidence.liveAttempts.length;
  const comparableAttempts = evidence.liveAttempts.filter((a) =>
    isComparableShadowClass(a.disagreementClass),
  );
  const nonComparableLiveAttemptCount =
    liveAttemptCount - comparableAttempts.length;
  const liveDisagreementClasses = tally(
    evidence.liveAttempts.map((a) => a.disagreementClass),
  );
  const durableDisagreementClasses = tally(
    evidence.durableAttempts.map((a) => a.disagreementClass),
  );
  const nonComparableDurableAttemptCount = evidence.durableAttempts.filter(
    (a) => !isComparableShadowClass(a.disagreementClass),
  ).length;
  const observerStatus = liveShadowObserverStatus(evidence.observerHealth);

  const covered = new Set<PhaseKind>();
  let hasAllowOutcome = false;
  let hasDenyOutcome = false;
  for (const attempt of comparableAttempts) {
    covered.add(attempt.phaseKind);
    if (attempt.outcome === 'allow') hasAllowOutcome = true;
    else hasDenyOutcome = true;
  }
  const coveredPhaseKinds = ALL_PHASE_KINDS.filter((k) => covered.has(k));
  const missingPhaseKinds = ALL_PHASE_KINDS.filter((k) => !covered.has(k));

  const conditions: readonly GateCondition[] = [
    {
      id: 'deterministic-corpus-clean',
      met: unexplainedDisagreements === 0,
      detail:
        unexplainedDisagreements === 0
          ? `0 unexplained disagreements across ${summary.total} corpus fixtures ` +
            `(${summary.explained} explained, ${summary.agreements} agreements)`
          : `${unexplainedDisagreements} unexplained disagreement(s) must be ` +
            `explained or resolved before enforcement can flip`,
    },
    {
      id: 'live-attempt-threshold',
      met: comparableAttempts.length >= MINIMUM_LIVE_ATTEMPTS,
      detail:
        `${comparableAttempts.length}/${MINIMUM_LIVE_ATTEMPTS} comparable live ` +
        `attempts recorded (${liveAttemptCount} observed, ` +
        `${nonComparableLiveAttemptCount} without a comparable admission verdict)`,
    },
    {
      id: 'phase-kind-coverage',
      met: missingPhaseKinds.length === 0,
      detail:
        missingPhaseKinds.length === 0
          ? `all ${ALL_PHASE_KINDS.length} phase kinds covered`
          : `missing phase kind(s): ${missingPhaseKinds.join(', ')}`,
    },
    {
      id: 'outcome-coverage',
      met: hasAllowOutcome && hasDenyOutcome,
      detail:
        hasAllowOutcome && hasDenyOutcome
          ? 'both allow and deny outcomes present'
          : `missing outcome(s): ${[
              hasAllowOutcome ? null : 'allow',
              hasDenyOutcome ? null : 'deny',
            ]
              .filter((v): v is string => v !== null)
              .join(', ')}`,
    },
    {
      id: 'live-disagreement-class',
      met:
        evidence.durableAttempts.length > 0 &&
        nonComparableDurableAttemptCount === 0 &&
        nonComparableLiveAttemptCount === 0,
      detail:
        evidence.durableAttempts.length === 0
          ? 'no durable shadow-attempt evidence — an empty in-memory buffer ' +
            'cannot distinguish "no disagreements" from "the observer never ran"'
          : nonComparableDurableAttemptCount > 0 || nonComparableLiveAttemptCount > 0
            ? `${nonComparableDurableAttemptCount} durable and ` +
              `${nonComparableLiveAttemptCount} live attempt(s) carry no ` +
              `comparable admission verdict (durable classes: ` +
              `${formatTally(durableDisagreementClasses)})`
            : `${evidence.durableAttempts.length} durable attempt(s), all ` +
              `comparable (${formatTally(durableDisagreementClasses)})`,
    },
    {
      id: 'live-observer-health',
      met: observerStatus === 'healthy',
      detail:
        observerStatus === 'healthy'
          ? `observer healthy: ${evidence.observerHealth.attemptsObserved} ` +
            `attempt(s) observed, ${evidence.observerHealth.appendsSucceeded} ` +
            `durable append(s) landed`
          : `observer is ${observerStatus} — ` +
            `${evidence.observerHealth.attemptsObserved} observed, ` +
            `${evidence.observerHealth.appendsSucceeded} landed, ` +
            `${evidence.observerHealth.appendsFailed} failed, ` +
            `${evidence.observerHealth.streamUnresolved} unresolved, ` +
            `${evidence.observerHealth.observationsThrew} threw`,
    },
  ];

  const unmet = conditions.filter((c) => !c.met).map((c) => c.id);

  return {
    satisfied: unmet.length === 0,
    conditions,
    unmet,
    unexplainedDisagreements,
    liveAttemptCount,
    comparableLiveAttemptCount: comparableAttempts.length,
    nonComparableLiveAttemptCount,
    liveDisagreementClasses,
    durableAttemptCount: evidence.durableAttempts.length,
    nonComparableDurableAttemptCount,
    durableDisagreementClasses,
    observerStatus,
    coveredPhaseKinds,
    missingPhaseKinds,
    hasAllowOutcome,
    hasDenyOutcome,
  };
}

function formatTally(counts: DisagreementClassTally): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([cls, n]) => `${cls}=${n}`)
    .join(', ');
}

/**
 * Reads the durable shadow streams, adds the observer health, and evaluates the gate.
 * No production code calls this function. `evidence-reader.ts` assembles the evidence and calls {@link evaluateCutoverGate}.
 */
export async function assessCutoverReadiness(input: {
  readonly reader: DurableShadowEvidenceReader;
  readonly featureIds: readonly string[];
  readonly corpusRecords: readonly ShadowDispositionView[];
  readonly liveAttempts: readonly LiveShadowAttempt[];
  readonly observerHealth: LiveShadowHealth;
}): Promise<CutoverGateReport> {
  const durableAttempts = await readDurableShadowAttempts(
    input.reader,
    input.featureIds,
  );
  return evaluateCutoverGate({
    corpusRecords: input.corpusRecords,
    liveAttempts: input.liveAttempts,
    durableAttempts,
    observerHealth: input.observerHealth,
  });
}

/** The rollout outcome — matches the `admission.rollout-decision` event enum. */
export type RolloutOutcome = 'approve-enforcement' | 'continue-shadow';

/** A satisfied gate approves enforcement. Otherwise shadow mode continues. */
export function decideRollout(report: CutoverGateReport): RolloutOutcome {
  return report.satisfied ? 'approve-enforcement' : 'continue-shadow';
}

/** The trusted policy identity on the recorded rollout and enablement facts. */
export interface CutoverPolicyRef {
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  readonly inputDigest: ContentDigestV1;
}

export interface RolloutDecisionEventInput {
  readonly report: CutoverGateReport;
  readonly rolloutDecisionId: string;
  readonly operationId: OperationId;
  readonly policy: CutoverPolicyRef;
  readonly evidenceIds: readonly EvidenceId[];
  readonly shadowEvidenceDigest: ContentDigestV1;
  readonly decidedAt: string;
  readonly provenance: ShadowProvenance;
}

/**
 * Builds a schema-validated `admission.rollout-decision` payload.
 * The gate report sets the outcome, so the decision always follows from the evidence.
 */
export function toRolloutDecisionData(
  input: RolloutDecisionEventInput,
): AdmissionRolloutDecision {
  const {
    report,
    rolloutDecisionId,
    operationId,
    policy,
    evidenceIds,
    shadowEvidenceDigest,
    decidedAt,
    provenance,
  } = input;
  return AdmissionRolloutDecisionData.parse({
    eventVersion: '1.0',
    rolloutDecisionId,
    operationId,
    outcome: decideRollout(report),
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyDigest: policy.policyDigest,
    inputDigest: policy.inputDigest,
    evidenceIds,
    shadowEvidenceDigest,
    decidedAt,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
}

export interface EnforcementEnabledEventInput {
  readonly report: CutoverGateReport;
  readonly enablementId: string;
  readonly operationId: OperationId;
  readonly rolloutDecisionId: string;
  readonly policy: CutoverPolicyRef;
  readonly enabledAt: string;
  readonly provenance: ShadowProvenance;
}

/** Thrown for a request to enable enforcement behind an unsatisfied gate. */
export class CutoverGateNotSatisfiedError extends Error {
  readonly unmet: readonly GateConditionId[];
  constructor(unmet: readonly GateConditionId[]) {
    super(
      `cutover gate is not satisfied — cannot enable enforcement; unmet: ${unmet.join(
        ', ',
      )}`,
    );
    this.name = 'CutoverGateNotSatisfiedError';
    this.unmet = unmet;
  }
}

/**
 * Builds a schema-validated `admission.enforcement-enabled` payload.
 * @throws {CutoverGateNotSatisfiedError} When the gate report is not satisfied.
 */
export function toEnforcementEnabledData(
  input: EnforcementEnabledEventInput,
): AdmissionEnforcementEnabled {
  const {
    report,
    enablementId,
    operationId,
    rolloutDecisionId,
    policy,
    enabledAt,
    provenance,
  } = input;
  if (!report.satisfied) {
    throw new CutoverGateNotSatisfiedError(report.unmet);
  }
  return AdmissionEnforcementEnabledData.parse({
    eventVersion: '1.0',
    enablementId,
    operationId,
    rolloutDecisionId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyDigest: policy.policyDigest,
    inputDigest: policy.inputDigest,
    enabledAt,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
}
