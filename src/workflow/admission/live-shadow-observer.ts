// The live side of the shadow. The guard passes a legacy transition through
// `GuardContext.shadowObserver`, and the caller of the guard binds the real
// legacy state. The module runs the evidence-backed admission engine beside
// the legacy decision, classifies any disagreement, and records the pair for
// the cutover gate.
//
// The observer is not authoritative. The legacy decision is already made, and
// nothing here can change it. Every path is error-isolated, and the guard also
// wraps the observer call.
//
// The durable append of the two shadow facts is fire-and-forget. It cannot
// change the decision, reorder the transition events, or fail a transition. The
// in-memory sink is only a same-process cache in front of the store.

import { createHash } from 'node:crypto';

import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { PhaseKind } from '../phase-kind.js';
import type { LiveShadowAttempt } from './cutover-gate.js';
import {
  isDisagreement,
  runShadowDecision,
  toDisagreementDispositionData,
  toShadowAttemptData,
  type DisagreementExplanation,
  type ExplainResolver,
  type LegacyDecision,
  type LegacyTransitionObservation,
  type ShadowAdmissionResult,
  type ShadowAttempt,
  type ShadowDecisionRecord,
  type ShadowProvenance,
} from './shadow-decision.js';
import { getEdgeIR, edgeKey } from './built-in-workflow-ir.js';
import type { WorkflowEdgeIR } from './built-in-workflow-ir.js';
import {
  adjudicateEdge,
  createTranslationAuthority,
  evaluateEdgeAdmission,
  factsDigest,
  projectStateToFacts,
  TRANSLATION_POLICY_ID,
  TRANSLATION_PROVIDER_VERSION,
  type TranslationContext,
} from './legacy-state-translation.js';
import type { PolicyEvaluation } from './policy-evaluation.js';
import {
  ADMISSION_EVENT_TYPES,
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  AdmissionDecisionRecordV1Schema,
  AttributedPrincipalV1Schema,
  AuthorizationSnapshotV1Schema,
  ContentDigestV1Schema,
  EvidenceSubjectV1Schema,
  OperationIdSchema,
  PhaseAttemptIdSchema,
  type AdmissionDecisionRecordV1,
  type ContentDigestV1,
} from './types.js';

/** One recorded live shadow observation: the gate substrate + the full record. */
export interface LiveShadowObservationRecord {
  /** The coverage substrate the cutover gate folds (phase kind + legacy outcome). */
  readonly attempt: LiveShadowAttempt;
  /** The full typed shadow decision: legacy, admission, and disposition. */
  readonly decision: ShadowDecisionRecord;
  /** The shared-IR edge this observation covered. */
  readonly edgeKey: string;
}

/** Where live shadow observations are recorded. */
export interface LiveShadowSink {
  record(record: LiveShadowObservationRecord): void;
}

/**
 * A bounded in-memory sink, so the observer cannot leak memory. The drop of the
 * oldest record is safe, because the cutover gate reads coverage and a
 * threshold, not the full history.
 */
export class InMemoryLiveShadowSink implements LiveShadowSink {
  private readonly buffer: LiveShadowObservationRecord[] = [];

  constructor(private readonly capacity = 5000) {}

  record(record: LiveShadowObservationRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  get size(): number {
    return this.buffer.length;
  }

  /** The coverage substrate the cutover gate consumes. */
  liveAttempts(): readonly LiveShadowAttempt[] {
    return this.buffer.map((r) => r.attempt);
  }

  /** The full shadow decision records. */
  decisionRecords(): readonly ShadowDecisionRecord[] {
    return this.buffer.map((r) => r.decision);
  }

  snapshot(): readonly LiveShadowObservationRecord[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

/**
 * An immutable reading of the observer's health. The fields are separate so that
 * a dead observer and a quiet one give different readings. "20 attempts, 0
 * appends succeeded" is dead, and "0 attempts" is quiet. The cutover gate reads
 * the {@link liveShadowObserverStatus} fold in `live-observer-health`.
 */
export interface LiveShadowHealth {
  /** Guarded-edge transitions the observer actually compared. */
  readonly attemptsObserved: number;
  /** Durable evidence appends scheduled (one per observed attempt with a store). */
  readonly appendsScheduled: number;
  /** Durable appends that LANDED. */
  readonly appendsSucceeded: number;
  /** Durable appends that REJECTED (store outage, validation, disk). */
  readonly appendsFailed: number;
  /** Observations with no resolvable evidence stream (no `featureId`). */
  readonly streamUnresolved: number;
  /** Observations that threw anywhere in the observer body. */
  readonly observationsThrew: number;
}

/** The reading of an observer that has done nothing at all. */
export const ZERO_LIVE_SHADOW_HEALTH: LiveShadowHealth = Object.freeze({
  attemptsObserved: 0,
  appendsScheduled: 0,
  appendsSucceeded: 0,
  appendsFailed: 0,
  streamUnresolved: 0,
  observationsThrew: 0,
});

/**
 * The four observer states.
 *
 * `dead` means that the observer saw transitions and no durable fact landed. A
 * store outage, an unresolvable stream, a throwing observer body, or a run with
 * no store can cause it. An empty evidence stream in that state is never clean.
 */
export type LiveShadowObserverStatus =
  | 'unobserved'
  | 'dead'
  | 'degraded'
  | 'healthy';

/** Fold a health reading into the judgement the cutover gate consumes. */
export function liveShadowObserverStatus(
  health: LiveShadowHealth,
): LiveShadowObserverStatus {
  if (health.attemptsObserved === 0) return 'unobserved';
  if (health.appendsSucceeded === 0) return 'dead';
  const lossy =
    health.appendsFailed > 0 ||
    health.streamUnresolved > 0 ||
    health.observationsThrew > 0;
  return lossy ? 'degraded' : 'healthy';
}

/**
 * The mutable counter that production increments. It is a class so that a
 * caller injects it through the required {@link LiveShadowDeps.health} and can
 * {@link reset} it. The one process-level instance, {@link liveShadowHealth},
 * exists because the production observer callback is process-level.
 */
export class LiveShadowHealthCounter {
  private attemptsObserved = 0;
  private appendsScheduled = 0;
  private appendsSucceeded = 0;
  private appendsFailed = 0;
  private streamUnresolvedCount = 0;
  private observationsThrew = 0;

  observedAttempt(): void {
    this.attemptsObserved += 1;
  }

  scheduledAppend(): void {
    this.appendsScheduled += 1;
  }

  appendSucceeded(): void {
    this.appendsSucceeded += 1;
  }

  appendFailed(): void {
    this.appendsFailed += 1;
  }

  unresolvedStream(): void {
    this.streamUnresolvedCount += 1;
  }

  observationThrew(): void {
    this.observationsThrew += 1;
  }

  snapshot(): LiveShadowHealth {
    return Object.freeze({
      attemptsObserved: this.attemptsObserved,
      appendsScheduled: this.appendsScheduled,
      appendsSucceeded: this.appendsSucceeded,
      appendsFailed: this.appendsFailed,
      streamUnresolved: this.streamUnresolvedCount,
      observationsThrew: this.observationsThrew,
    });
  }

  status(): LiveShadowObserverStatus {
    return liveShadowObserverStatus(this.snapshot());
  }

  reset(): void {
    this.attemptsObserved = 0;
    this.appendsScheduled = 0;
    this.appendsSucceeded = 0;
    this.appendsFailed = 0;
    this.streamUnresolvedCount = 0;
    this.observationsThrew = 0;
  }
}

/**
 * The structural slice of `EventStore` that the observer needs. The observer
 * owns no store handle of its own. It appends through `EventStore.append`.
 */
export interface ShadowEvidenceAppender {
  append(
    streamId: string,
    event: {
      type: string;
      timestamp?: string | undefined;
      source?: string | undefined;
      data?: Record<string, unknown> | undefined;
    },
    options?: { idempotencyKey?: string | undefined } | undefined,
  ): Promise<unknown>;
}

/** Append options for one shadow-evidence fact. */
export interface ShadowEvidenceAppendOptions {
  readonly idempotencyKey?: string | undefined;
}

/** Where the durable shadow facts are appended, and under which stream. */
export interface LiveShadowEvidenceTarget {
  readonly appender: ShadowEvidenceAppender;
  /**
   * Resolves the evidence stream for a legacy state. The default is the sidecar
   * shadow stream of the feature, {@link liveShadowEvidenceStreamId}.
   */
  readonly streamIdFor?: (state: Record<string, unknown>) => string | undefined;
}

/** `event.source` stamped on both durable shadow facts. */
export const LIVE_SHADOW_OBSERVATION_SOURCE = 'live-shadow-observer';

/** Policy version the legacy-state translation adjudicates under. */
const SHADOW_POLICY_VERSION = TRANSLATION_PROVIDER_VERSION;

/**
 * Idempotency options keyed on the natural identity of one shadow fact. The
 * identity hashes stream, edge key, phase-attempt id, legacy outcome, and input
 * digest. It excludes the evaluation instant, because
 * {@link recordLiveTransition} mints a fresh `evaluatedAt` for each call. Thus a
 * retry computes the same key, and its append collapses onto the stored row.
 * The facts record an adjudication with no external effect, so they need no
 * intent event. The key stays inside the 200-character `idempotencyKey` bound.
 */
function evidenceAppendOptions(
  naturalIdentity: string,
): ShadowEvidenceAppendOptions {
  return { idempotencyKey: naturalIdentity };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestOf(value: string): ContentDigestV1 {
  return ContentDigestV1Schema.parse({
    algorithm: 'sha256',
    value: sha256Hex(value),
  });
}

/**
 * Coerce an arbitrary token into the admission stable-id alphabet
 * (`[A-Za-z0-9][A-Za-z0-9._:-]*`). Feature ids and phase names are caller data.
 * A stable id built from them must never fail schema validation.
 */
function stableToken(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

function readString(
  state: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = state[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The namespaced sidecar segment for the durable shadow evidence of a feature.
 *
 * A transition must behave the same with or without the observer. An append to
 * the feature stream breaks that in three ways. The fire-and-forget append can
 * race the CAS writes in `handleSet` and `appendTrailAtomically` and cause a
 * false `ConcurrencyError`. It moves the stream tail away from `_eventSequence`,
 * which reconciliation reads as drift. It also changes `query(featureId)` for
 * every consumer. `validateStreamId` accepts the `<feature-id>/<segment>` form
 * for this kind of sidecar.
 */
export const LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT = 'admission-shadow';

/** The sidecar stream carrying `featureId`'s durable shadow evidence. */
export function liveShadowEvidenceStreamId(featureId: string): string {
  return `${featureId}/${LIVE_SHADOW_EVIDENCE_STREAM_SEGMENT}`;
}

/** The default stream for a workflow's shadow evidence: its sidecar. */
function defaultStreamIdFor(
  state: Record<string, unknown>,
): string | undefined {
  const featureId = readString(state, 'featureId');
  return featureId === undefined ? undefined : liveShadowEvidenceStreamId(featureId);
}

/**
 * The observer's own service identity, used when no dispatch authorization is
 * active (direct handler invocation, background reconciliation). It is a
 * `read-only` posture on purpose: the observer never authorizes anything, it
 * only witnesses.
 */
function observerProvenance(resolvedAt: string): ShadowProvenance {
  return {
    caller: AttributedPrincipalV1Schema.parse({
      principalKind: 'service',
      principalId: 'exarchos.live-shadow-observer',
      role: 'shadow-observer',
    }),
    authorization: AuthorizationSnapshotV1Schema.parse({
      authorizationId: 'live-shadow-observer:process',
      posture: 'read-only',
      capabilityIds: ['admission:shadow-observe'],
      resolverVersion: '1.0',
      resolvedAt,
    }),
  };
}

/**
 * Trusted provenance for the recorded facts. Derived from the active dispatch
 * authorization when one exists — never from anything the caller supplied.
 */
function shadowProvenance(resolvedAt: string): ShadowProvenance {
  const dispatchContext = getDispatchContext();
  const authorization = dispatchContext?.authorization;
  if (dispatchContext === undefined || authorization === undefined) {
    return observerProvenance(resolvedAt);
  }
  const capabilityIds = authorization.capabilities.length > 0
    ? authorization.capabilities.map((capability) => String(capability))
    : ['admission:shadow-observe'];
  return {
    caller: AttributedPrincipalV1Schema.parse({
      principalKind:
        authorization.identity.role === 'operator' ? 'operator' : 'agent',
      principalId: stableToken(
        authorization.identity.subjectId,
        'unknown-principal',
      ),
      role: stableToken(authorization.identity.role, 'agent'),
    }),
    authorization: AuthorizationSnapshotV1Schema.parse({
      authorizationId: stableToken(
        `${authorization.policy.id}:${dispatchContext.operationId}`,
        'live-shadow-observer:process',
      ),
      posture: authorization.posture,
      capabilityIds,
      resolverVersion: authorization.resolver.version,
      resolvedAt: authorization.resolvedAt,
    }),
  };
}

/**
 * Project the shadow admission result onto the persisted
 * {@link AdmissionDecisionRecordV1} shape.
 *
 * The requirement dispositions and `waiverIds` come from the real policy
 * evaluation of the same edge and state. Thus the record is a true account of
 * the admission decision, and `waiverIds` agrees with `waivedRequirementIds`.
 * A legal-route failure carries no requirement. When no evaluated requirement
 * applies, the record uses the synthetic requirement id `route:<edge>`.
 */
function projectDecisionRecord(args: {
  readonly key: string;
  readonly admission: ShadowAdmissionResult;
  readonly evaluation: PolicyEvaluation | undefined;
  readonly decisionId: string;
  readonly operationId: string;
  readonly phaseAttemptId: string;
  readonly policyDigest: ContentDigestV1;
  readonly requirementSetDigest: ContentDigestV1;
  readonly inputDigest: ContentDigestV1;
  readonly evidenceIds: readonly string[];
  readonly decidedAt: string;
}): AdmissionDecisionRecordV1 {
  const evaluations = args.evaluation?.requirementEvaluations ?? [];
  const routeRequirementId = stableToken(
    `route:${args.key}`,
    'route:unmodelled-edge',
  );
  const common = {
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    decisionId: args.decisionId,
    operationId: args.operationId,
    phaseAttemptId: args.phaseAttemptId,
    policyId: TRANSLATION_POLICY_ID,
    policyVersion: SHADOW_POLICY_VERSION,
    policyDigest: args.policyDigest,
    requirementSetDigest: args.requirementSetDigest,
    inputDigest: args.inputDigest,
    evidenceIds: [...args.evidenceIds],
    waiverIds: [...new Set(
      (args.evaluation?.appliedWaiverIds ?? []).map((id) => String(id)),
    )].sort(),
    decidedAt: args.decidedAt,
  };
  const satisfiedRequirementIds = evaluations
    .filter((evaluation) => evaluation.status === 'satisfied')
    .map((evaluation) => String(evaluation.requirementId));
  const waivedRequirementIds = evaluations
    .filter((evaluation) => evaluation.status === 'waived')
    .map((evaluation) => String(evaluation.requirementId));

  const outcome =
    args.admission.status === 'error' ? 'indeterminate' : args.admission.verdict;

  if (outcome === 'allow') {
    return AdmissionDecisionRecordV1Schema.parse({
      ...common,
      outcome: 'allow',
      satisfiedRequirementIds,
      waivedRequirementIds,
    });
  }

  const remediation = [
    { action: 'retry_transition', phaseAttemptId: args.phaseAttemptId },
  ];

  if (outcome === 'deny') {
    const denied = evaluations
      .filter((evaluation) => evaluation.status === 'denied')
      .map((evaluation) => ({
        requirementId: String(evaluation.requirementId),
        reason: evaluation.status === 'denied' ? evaluation.reason : 'failed',
      }));
    return AdmissionDecisionRecordV1Schema.parse({
      ...common,
      outcome: 'deny',
      satisfiedRequirementIds,
      unsatisfiedRequirements:
        denied.length > 0
          ? denied
          : [{ requirementId: routeRequirementId, reason: 'failed' }],
      remediation,
    });
  }

  const unresolved = evaluations
    .filter((evaluation) => evaluation.status === 'indeterminate')
    .map((evaluation) => String(evaluation.requirementId));
  const errors = evaluations
    .filter((evaluation) => evaluation.status === 'indeterminate')
    .map((evaluation) => ({
      code: evaluation.status === 'indeterminate' ? evaluation.code : 'EVALUATOR_FAILED',
      message: `requirement ${String(evaluation.requirementId)} is unresolved`,
    }));
  const fallbackMessage =
    args.admission.status === 'error'
      ? `shadow admission threw: ${args.admission.error}`
      : `shadow admission is indeterminate for edge ${args.key}`;
  return AdmissionDecisionRecordV1Schema.parse({
    ...common,
    outcome: 'indeterminate',
    unresolvedRequirementIds:
      unresolved.length > 0 ? unresolved : [routeRequirementId],
    errors:
      errors.length > 0
        ? errors
        : [{ code: 'EVALUATOR_FAILED', message: fallbackMessage }],
    remediation,
  });
}

/**
 * The in-flight durable appends. The guard discards the return value of the
 * synchronous `shadowObserver` seam, so the observer schedules the append and
 * does not await it. A test or a shutdown hook can wait on this set.
 */
const pendingEvidenceAppends = new Set<Promise<void>>();

/**
 * A listener that runs after each durable shadow append lands. The cutover
 * auto-export module installs it from `dispatch/core/context.ts`. The observer
 * cannot import the gate, because `cutover-gate.ts` already imports this
 * module. The observer swallows a throw from the listener.
 */
export type DurableAppendSuccessListener = () => void;

let durableAppendSuccessListener: DurableAppendSuccessListener | undefined;

/** Install (or clear, with `undefined`) the durable-append success listener. */
export function setDurableAppendSuccessListener(
  listener: DurableAppendSuccessListener | undefined,
): void {
  durableAppendSuccessListener = listener;
}

/**
 * Track one durable shadow append and count its result. The function swallows a
 * rejection, so a store outage cannot reach the transition path. Both arms
 * increment {@link LiveShadowHealthCounter}, so "nothing happened" and "every
 * append failed" are different readings.
 *
 * On success it notifies the durable-append listener and swallows a listener
 * throw. The transition path can await this settlement chain, and the listener
 * counts its own failures.
 */
function trackEvidenceAppend(
  work: Promise<unknown>,
  health: LiveShadowHealthCounter,
): Promise<void> {
  health.scheduledAppend();
  const settled = work.then(
    () => {
      health.appendSucceeded();
      try {
        durableAppendSuccessListener?.();
      } catch {
      }
    },
    () => {
      health.appendFailed();
    },
  );
  pendingEvidenceAppends.add(settled);
  void settled.finally(() => {
    pendingEvidenceAppends.delete(settled);
  });
  return settled;
}

/** Await every shadow-evidence append scheduled so far. Never throws. */
export async function flushLiveShadowEvidence(): Promise<void> {
  while (pendingEvidenceAppends.size > 0) {
    await Promise.all([...pendingEvidenceAppends]);
  }
}

/** Count of shadow-evidence appends still in flight (diagnostics). */
export function pendingLiveShadowEvidenceCount(): number {
  return pendingEvidenceAppends.size;
}

/**
 * Build and schedule the durable facts for one observation. It appends
 * `admission.shadow-attempt`, and it appends
 * `admission.disagreement-disposition` only for a disagreement, because the
 * disposition enum has no `agree` member.
 *
 * An unresolvable stream counts as a dead observer, not as no activity. The
 * phase-attempt id reads `_pendingPhaseAttemptId` first. Callers stamp the
 * current attempt there before `attempt()`, and `phaseAttemptId` still names
 * the previous attempt at that time.
 */
function emitShadowEvidence(args: {
  readonly target: LiveShadowEvidenceTarget;
  readonly edge: WorkflowEdgeIR;
  readonly key: string;
  readonly state: Record<string, unknown>;
  readonly context: TranslationContext;
  readonly record: ShadowDecisionRecord;
  readonly health: LiveShadowHealthCounter;
}): Promise<void> {
  const { target, edge, key, state, context, record, health } = args;

  const streamId = (target.streamIdFor ?? defaultStreamIdFor)(state);
  if (streamId === undefined) {
    health.unresolvedStream();
    return Promise.resolve();
  }

  const recordedAt = context.evaluatedAt;
  const inputDigest = factsDigest(projectStateToFacts(state));

  let evaluation: PolicyEvaluation | undefined;
  try {
    evaluation = evaluateEdgeAdmission(edge, state, context);
  } catch {
    evaluation = undefined;
  }
  const requirementIds = (evaluation?.requirementEvaluations ?? [])
    .map((entry) => String(entry.requirementId))
    .sort();
  const evidenceIds = [
    ...new Set(
      (evaluation?.requirementEvaluations ?? []).flatMap((entry) =>
        entry.evidenceIds.map((id) => String(id)),
      ),
    ),
  ].sort();

  const phaseAttemptId = stableToken(
    readString(state, '_pendingPhaseAttemptId') ??
      readString(state, 'phaseAttemptId') ??
      `${readString(state, 'featureId') ?? edge.workflowType}:${edge.to}`,
    'live-shadow:phase-attempt',
  );

  const attemptIdentity = sha256Hex(
    JSON.stringify([
      streamId,
      key,
      phaseAttemptId,
      record.legacyOutcome,
      inputDigest.value,
    ]),
  );
  const shadowAttemptId = `shadow-attempt:${attemptIdentity}`;
  const dispositionId = `disagreement-disposition:${attemptIdentity}`;
  const decisionId = `shadow-decision:${attemptIdentity}`;
  const operationId = stableToken(
    getDispatchContext()?.operationId ?? `live-shadow:${attemptIdentity}`,
    `live-shadow:${attemptIdentity}`,
  );

  const provenance = shadowProvenance(recordedAt);
  const decision = projectDecisionRecord({
    key,
    admission: record.admission,
    evaluation,
    decisionId,
    operationId,
    phaseAttemptId,
    policyDigest: digestOf(`${TRANSLATION_POLICY_ID}@${SHADOW_POLICY_VERSION}`),
    requirementSetDigest: digestOf(JSON.stringify(requirementIds)),
    inputDigest,
    evidenceIds,
    decidedAt: recordedAt,
  });

  const subject = EvidenceSubjectV1Schema.parse({
    kind: 'phase-attempt',
    phaseAttemptId,
    digest: inputDigest,
  });

  const attemptData = toShadowAttemptData({
    record,
    shadowAttemptId,
    operationId: OperationIdSchema.parse(operationId),
    phaseAttemptId: PhaseAttemptIdSchema.parse(phaseAttemptId),
    subject,
    evidenceSetDigest: digestOf(JSON.stringify(evidenceIds)),
    decision,
    attemptedAt: recordedAt,
    provenance,
  });

  const dispositionData = isDisagreement(record.disagreementClass)
    ? toDisagreementDispositionData({
        record,
        dispositionId,
        shadowAttemptId,
        recordedAt,
        provenance,
      })
    : undefined;

  return trackEvidenceAppend(
    (async () => {
      await target.appender.append(
        streamId,
        {
          type: ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT,
          timestamp: recordedAt,
          source: LIVE_SHADOW_OBSERVATION_SOURCE,
          data: attemptData as unknown as Record<string, unknown>,
        },
        evidenceAppendOptions(shadowAttemptId),
      );
      if (dispositionData !== undefined) {
        await target.appender.append(
          streamId,
          {
            type: ADMISSION_EVENT_TYPES.DISAGREEMENT_DISPOSITION,
            timestamp: recordedAt,
            source: LIVE_SHADOW_OBSERVATION_SOURCE,
            data: dispositionData as unknown as Record<string, unknown>,
          },
          evidenceAppendOptions(dispositionId),
        );
      }
    })(),
    health,
  );
}

/** Live disagreements are conservatively unexplained pending human disposition. */
const defaultLiveExplain: ExplainResolver = (): DisagreementExplanation => ({
  disposition: 'unexplained',
  reason: 'live shadow disagreement — pending disposition',
});

export interface LiveShadowDeps {
  readonly sink: LiveShadowSink;
  readonly context: TranslationContext;
  readonly explain?: ExplainResolver;
  /**
   * Where the observer appends the durable `admission.shadow-attempt` and
   * `admission.disagreement-disposition` facts. There is no module-level
   * default, so a path that forgets the store cannot silently fall back to
   * memory only.
   */
  readonly evidence?: LiveShadowEvidenceTarget;
  /**
   * The health counter that this observation increments. It is required, so a
   * call site cannot get a hidden default counter and report its failures
   * nowhere.
   */
  readonly health: LiveShadowHealthCounter;
}

/**
 * Observe one legacy transition against the evidence-backed admission engine and
 * record the pair. It shadows only guarded edges in the shared IR. It skips
 * unmodelled edges, such as universal cancel or cleanup and idempotent no-ops.
 * It never throws, and it counts a thrown failure. The returned promise settles
 * when the durable write lands or fails, and it never rejects.
 *
 * It counts the attempt before it schedules the durable append, so "observed
 * but nothing landed" is a readable state. The durable fact comes before the
 * sink write and does not depend on it. The live attempt carries the
 * disagreement class, so the gate can tell a failed adjudication from a clean
 * comparison.
 */
export function observeLiveTransition(
  observation: LegacyTransitionObservation,
  state: Record<string, unknown>,
  deps: LiveShadowDeps,
): Promise<void> {
  let written: Promise<void> = Promise.resolve();
  try {
    const edge = getEdgeIR(
      observation.workflowType,
      observation.fromPhase,
      observation.toPhase,
    );
    if (edge === undefined) return written;

    const key = edgeKey(edge.workflowType, edge.from, edge.to);
    const attempt: ShadowAttempt = {
      workflowType: edge.workflowType,
      fromPhase: edge.from,
      toPhase: edge.to,
      phaseKind: edge.toPhaseKind,
      attemptId: key,
      ...(edge.legacyGuardId ? { guardId: edge.legacyGuardId } : {}),
    };
    const legacy: LegacyDecision = {
      outcome: observation.legacyOutcome,
      idempotent: observation.idempotent,
    };

    const { record } = runShadowDecision({
      attempt,
      legacy,
      adjudicateAdmission: () => adjudicateEdge(edge, state, deps.context),
      explain: deps.explain ?? defaultLiveExplain,
    });

    const liveAttempt: LiveShadowAttempt = {
      phaseKind: edge.toPhaseKind satisfies PhaseKind,
      outcome: observation.legacyOutcome,
      disagreementClass: record.disagreementClass,
    };
    deps.health.observedAttempt();
    if (deps.evidence !== undefined) {
      written = emitShadowEvidence({
        target: deps.evidence,
        edge,
        key,
        state,
        context: deps.context,
        record,
        health: deps.health,
      });
    }
    deps.sink.record({ attempt: liveAttempt, decision: record, edgeKey: key });
  } catch {
    deps.health.observationThrew();
  }
  return written;
}

/** The process-level live shadow sink that the cutover gate reads. */
export const liveShadowSink = new InMemoryLiveShadowSink();

/**
 * The process-level observer health counter. It is process-level for the same
 * reason as {@link liveShadowSink}. The guard seam calls the process-level
 * {@link recordLiveTransition} and holds no per-request state. Every other path
 * injects the counter through {@link LiveShadowDeps.health}, and `reset()`
 * isolates each test.
 */
export const liveShadowHealth = new LiveShadowHealthCounter();

/** The trust directory is out-of-band and stable, so the module builds it once. */
const SHARED_TRANSLATION_AUTHORITY = createTranslationAuthority();
const LIVE_FRESHNESS_HORIZON_MS = 60 * 60 * 1000;

/**
 * The production observer callback, wired through `GuardContext.shadowObserver`.
 * It binds the legacy state to the live sink and a fresh evaluation instant.
 * Minted evidence carries `evaluatedAt`, and the check compares against it. Thus
 * the exact instant never makes evidence stale.
 *
 * `appender` is the durable store from the caller. When it is `null` or
 * `undefined`, the observation uses only the in-memory cache.
 */
export function recordLiveTransition(
  observation: LegacyTransitionObservation,
  state: Record<string, unknown>,
  appender: ShadowEvidenceAppender | null | undefined,
): Promise<void> {
  return observeLiveTransition(observation, state, {
    sink: liveShadowSink,
    health: liveShadowHealth,
    context: {
      authority: SHARED_TRANSLATION_AUTHORITY,
      evaluatedAt: new Date().toISOString(),
      freshnessHorizonMs: LIVE_FRESHNESS_HORIZON_MS,
    },
    ...(appender ? { evidence: { appender } } : {}),
  });
}
