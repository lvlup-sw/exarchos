// ─── P07-02 / Transition tasks 027/051 — Live shadow observer ─────────────────
//
// The LIVE side of the shadow. P07-01 built the passive `shadowObserver?` seam
// on `GuardContext` (error-isolated, defaulted-off) and the event-sourced
// cutover gate, but no production caller fed the seam, so the gate's live
// conditions (>=20 attempts, all 6 phase kinds, both outcomes) could never be
// met. This module is that feed: given a legacy transition observation and the
// real legacy state, it runs the evidence-backed admission engine BESIDE the
// authoritative legacy decision (via P07-01's `runShadowDecision`), classifies
// any disagreement, and records the pair into a sink the cutover gate can read.
//
// Three preserved safety properties:
//   1. NON-AUTHORITATIVE — it only observes; the legacy decision is already made
//      and is returned untouched by the guard. Nothing here can change it.
//   2. ERROR-ISOLATED — every path is wrapped so a shadow failure (a projection
//      throw, a schema-parse throw, a sink throw) is swallowed. The guard ALSO
//      wraps the observer call; this is defence in depth.
//   3. NON-AUTHORITATIVE PERSISTENCE — the durable evidence append (DR-23, T-31)
//      is fire-and-forget and error-isolated, so it cannot change the returned
//      legacy decision, cannot reorder the authoritative transition events and
//      cannot fail a transition. It DOES change what is persisted: that is the
//      point — see below.
//
// ─── DR-23 / T-31: durable evidence ──────────────────────────────────────────
//
// Until T-31 the ONLY substrate was `liveShadowSink`, a process-scoped in-memory
// ring buffer. That is an INV-1 violation: the evidence the cutover gate reads
// evaporated on process exit, and the two registered replay shapes
// (`admission.shadow-attempt`, `admission.disagreement-disposition`) were
// registered-but-never-emitted. T-31 makes the observer append BOTH facts to the
// real event store through the same `EventStore.append` path every other
// admission producer uses (see `orchestrate/gate-runner.ts` for
// `admission.evidence-recorded`). The in-memory sink survives only as a
// same-process cache; the store is now the substrate.
//
// Enforcement still does NOT flip here: the cutover gate remains the only place
// that can approve enforcement, and only once its four conditions hold.

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

// ─── Sink ──────────────────────────────────────────────────────────────────────

/** One recorded live shadow observation: the gate substrate + the full record. */
export interface LiveShadowObservationRecord {
  /** The coverage substrate the cutover gate folds (phase kind + legacy outcome). */
  readonly attempt: LiveShadowAttempt;
  /** The full typed shadow decision (legacy vs admission + disposition). */
  readonly decision: ShadowDecisionRecord;
  /** The shared-IR edge this observation covered. */
  readonly edgeKey: string;
}

/** Where live shadow observations are recorded. */
export interface LiveShadowSink {
  record(record: LiveShadowObservationRecord): void;
}

/**
 * A bounded in-memory sink. Bounded so wiring the observer into every production
 * transition cannot leak memory; a drop of the oldest record is acceptable
 * because the cutover gate cares about coverage/threshold, not exhaustive history.
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

// ─── Durable evidence (DR-23 / T-31) ─────────────────────────────────────────

/**
 * The structural slice of `EventStore` the observer needs. Declared narrowly so
 * this module never constructs, owns or reaches for a store handle of its own —
 * it appends through the SAME `EventStore.append` path every other admission
 * producer uses. `EventStore` satisfies this interface structurally.
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
   * Resolves the stream a given legacy state's evidence belongs to. Defaults to
   * the feature's SIDECAR shadow stream — see
   * {@link liveShadowEvidenceStreamId}.
   */
  readonly streamIdFor?: (state: Record<string, unknown>) => string | undefined;
}

/** `event.source` stamped on both durable shadow facts. */
export const LIVE_SHADOW_OBSERVATION_SOURCE = 'live-shadow-observer';

/** Policy version the legacy-state translation adjudicates under. */
const SHADOW_POLICY_VERSION = TRANSLATION_PROVIDER_VERSION;

/**
 * T-49 seam — natural-identity idempotency keys.
 *
 * Every append below already has a NATURAL identity in hand (`shadowAttemptId`
 * for the attempt, `dispositionId` for the disposition — both derived from the
 * observed attempt, never random). T-49 turns this into
 * `{ idempotencyKey: naturalIdentity }`; nothing around the call has to change.
 */
function evidenceAppendOptions(
  _naturalIdentity: string,
): ShadowEvidenceAppendOptions {
  return {};
}

// ─── Identity + digest derivation (deterministic, never random) ───────────────

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
 * (`[A-Za-z0-9][A-Za-z0-9._:-]*`). Feature ids and phase names are caller data;
 * a stable id built from them must never be able to fail schema validation.
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
 * The namespaced SIDECAR segment carrying a feature's durable shadow evidence.
 *
 * Shadow observation is NON-AUTHORITATIVE and the observer's contract is that a
 * transition behaves identically whether or not it ran. Appending to the
 * feature's own stream would break that contract three ways:
 *   1. the durable append is fire-and-forget, so it interleaves at a
 *      nondeterministic sequence — racing the authoritative CAS/`expectedVersion`
 *      writes in `handleSet`/`appendTrailAtomically` and able to raise a
 *      SPURIOUS `ConcurrencyError` in production;
 *   2. it desynchronises the state file's `_eventSequence` from the stream tail,
 *      which reconciliation reads as drift;
 *   3. it changes `query(featureId)` for every existing consumer.
 * The `<feature-id>/<segment>` namespaced form is admitted by `validateStreamId`
 * precisely for this kind of sidecar. Evidence stays durable and per-feature
 * queryable; the authoritative stream stays byte-identical.
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

// ─── Provenance ───────────────────────────────────────────────────────────────

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

// ─── Decision-record projection ───────────────────────────────────────────────

/**
 * Project the shadow admission result onto the persisted
 * {@link AdmissionDecisionRecordV1} shape.
 *
 * The requirement dispositions come from the REAL policy evaluation of the same
 * edge and state, so the persisted record is a faithful account of what the
 * admission engine actually decided rather than a fabricated stand-in. Only the
 * route-denial fallback (a legal-route failure carries no requirement) is
 * synthesised, and it is labelled `route:<edge>` so it is unmistakable.
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
    waiverIds: [] as string[],
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

// ─── In-flight append tracking ────────────────────────────────────────────────
//
// The `shadowObserver` seam is synchronous and its return value is discarded by
// the guard (that is what keeps it behaviour-preserving), so the durable append
// is necessarily scheduled rather than awaited inside the transition. Tracking
// the in-flight promises lets a caller — a test, or a shutdown hook — wait for
// the evidence to land instead of guessing.

const pendingEvidenceAppends = new Set<Promise<void>>();

/**
 * T-32 hook point (DR-23 bullet 3 — "a dead observer is DETECTED").
 *
 * This is the ONE place a durable shadow append can fail silently: the promise
 * rejection is swallowed here so a store outage cannot propagate into the
 * authoritative transition path. T-32's health counter increments in the
 * rejection arm below (and in the two `return` guards inside
 * {@link emitShadowEvidence}: an unresolvable stream id, and the outer
 * `catch` in {@link observeLiveTransition}), so "zero shadow evidence" becomes
 * distinguishable from "zero transitions".
 */
function trackEvidenceAppend(work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined, // ← T-32: increment the observer-failure health counter here.
  );
  pendingEvidenceAppends.add(settled);
  void settled.finally(() => {
    pendingEvidenceAppends.delete(settled);
  });
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

// ─── Emission ─────────────────────────────────────────────────────────────────

/**
 * Build and schedule the durable facts for one observation.
 *
 * `admission.shadow-attempt` is appended for EVERY shadowed edge;
 * `admission.disagreement-disposition` is appended ONLY when the pair actually
 * disagreed (the registered disposition enum has no `agree` member, so an
 * agreement has nothing to dispose of).
 */
function emitShadowEvidence(args: {
  readonly target: LiveShadowEvidenceTarget;
  readonly edge: WorkflowEdgeIR;
  readonly key: string;
  readonly state: Record<string, unknown>;
  readonly context: TranslationContext;
  readonly record: ShadowDecisionRecord;
}): void {
  const { target, edge, key, state, context, record } = args;

  const streamId = (target.streamIdFor ?? defaultStreamIdFor)(state);
  // T-32: an unresolvable stream is a DEAD observer, not an absence of activity.
  if (streamId === undefined) return;

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
    readString(state, 'phaseAttemptId') ??
      `${readString(state, 'featureId') ?? edge.workflowType}:${edge.to}`,
    'live-shadow:phase-attempt',
  );

  // NATURAL identity (INV-8): a pure function of the observed attempt. Two
  // replays of the same attempt derive the same id; nothing here is random.
  const attemptIdentity = sha256Hex(
    JSON.stringify([
      streamId,
      key,
      phaseAttemptId,
      record.legacyOutcome,
      inputDigest.value,
      recordedAt,
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

  trackEvidenceAppend(
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
  );
}

// ─── Observer ────────────────────────────────────────────────────────────────

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
   * DR-23 — where the durable `admission.shadow-attempt` /
   * `admission.disagreement-disposition` facts are appended. Supplied by the
   * caller; there is deliberately no module-level default, so a path that
   * forgets to thread the store cannot silently degrade to memory-only.
   */
  readonly evidence?: LiveShadowEvidenceTarget;
}

/**
 * Observe one legacy transition against the evidence-backed admission engine and
 * record the pair. Only guarded edges present in the shared IR are shadowed;
 * unmodelled edges (universal cancel/cleanup, idempotent no-ops) are skipped.
 * Total and error-isolated: this never throws.
 */
export function observeLiveTransition(
  observation: LegacyTransitionObservation,
  state: Record<string, unknown>,
  deps: LiveShadowDeps,
): void {
  try {
    const edge = getEdgeIR(
      observation.workflowType,
      observation.fromPhase,
      observation.toPhase,
    );
    if (edge === undefined) return;

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
    };
    // DR-23: the DURABLE fact first. It is deliberately not conditioned on the
    // in-memory sink write succeeding — the store is the substrate now, and the
    // ring buffer is a same-process cache in front of it.
    if (deps.evidence !== undefined) {
      emitShadowEvidence({
        target: deps.evidence,
        edge,
        key,
        state,
        context: deps.context,
        record,
      });
    }
    deps.sink.record({ attempt: liveAttempt, decision: record, edgeKey: key });
  } catch {
    // Shadow observation is never authoritative — a failure is swallowed.
  }
}

// ─── Production wiring ──────────────────────────────────────────────────────────

/** The process-level live shadow sink the cutover gate reads (RESERVED gate). */
export const liveShadowSink = new InMemoryLiveShadowSink();

// The trust directory is out-of-band and stable; build it once.
const SHARED_TRANSLATION_AUTHORITY = createTranslationAuthority();
const LIVE_FRESHNESS_HORIZON_MS = 60 * 60 * 1000;

/**
 * The production observer callback: binds the given legacy state to the live
 * sink and a fresh (trusted-at-observe-time) evaluation instant. Wired into the
 * production transition path via `GuardContext.shadowObserver`. Because minted
 * evidence is stamped at `evaluatedAt` and compared against it, the exact
 * instant is immaterial to the verdict — it never renders evidence stale.
 *
 * DR-23 / T-31 — `appender` is the durable substrate, handed down from
 * `GuardContext.eventStore` by `notifyShadowObserver`. When it is `null` (a
 * caller in pure-evaluation mode that supplies no store at all) the observation
 * degrades to the in-memory cache; every production caller passes a real store.
 */
export function recordLiveTransition(
  observation: LegacyTransitionObservation,
  state: Record<string, unknown>,
  appender: ShadowEvidenceAppender | null | undefined,
): void {
  observeLiveTransition(observation, state, {
    sink: liveShadowSink,
    context: {
      authority: SHARED_TRANSLATION_AUTHORITY,
      evaluatedAt: new Date().toISOString(),
      freshnessHorizonMs: LIVE_FRESHNESS_HORIZON_MS,
    },
    ...(appender ? { evidence: { appender } } : {}),
  });
}
