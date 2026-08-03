// ─── P06-05 / Transition tasks 003, 023, 024, 045 — the admission chokepoint ──
//
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// code awaiting the legacy HSM cutover. The evidence-backed admission system is
// complete, but `hsm-transition-guard.ts` remains the authoritative decider
// until P07-01 shadow mode reports zero unexplained disagreements and P07-02
// migrates the built-in workflows. Deliberately staged that way: flipping the
// decider in the same change that builds it would land an unverified cutover.
// P07-05 deletes the legacy guard once this is the only path.
//
// This module is the SOLE admission chokepoint. A guarded phase transition
// folds the stream at an explicit expected version, decides route legality
// (topology) and then admission (evidence-backed permission), and appends the
// admission decision together with the phase-transition lifecycle event in ONE
// atomic {@link AtomicAppender.decideOnce} transaction. The same primitive backs
// workflow cleanup, so every phase mutation shares one atomic + idempotent path.
//
// Ordering is load-bearing and explicit (Transition task 003 / requirement #2):
//
//   1. ROUTE  (P06-02 `selectEdge`)  — is the edge LEGAL to take at all?
//                                      Illegal ⇒ no admission, no phase change,
//                                      nothing persisted.
//   2. ADMISSION (P06-03 resolve → P06-05 freeze → P06-04 evaluatePolicy) — is
//      the legal edge PERMITTED by evidence? `allow` ⇒ the phase advances;
//      `deny` / `indeterminate` ⇒ the attempt + decision are recorded but the
//      phase is UNCHANGED (fail closed — requirement #5, task 024).
//
// Atomicity (requirement #3, task 045): the decision event and the lifecycle
// event are members of the SAME `decideOnce` decision — one BEGIN IMMEDIATE
// transaction. It is structurally impossible to observe a decision without its
// lifecycle sibling, or a lifecycle event without its decision.
//
// Idempotency (requirement #4, task 023): retries key on `operationId` via
// `decideOnce`, so a retried transition returns the SAME recorded decision and
// never re-evaluates to a different one.
//
// Optimistic concurrency (requirement #1): the caller's observed
// `expectedVersion` is the sequence gate. A concurrent writer that advanced the
// stream raises a typed {@link ConcurrencyError}, never a silent lost update.
//
// This module orchestrates the pure admission pieces; it evaluates them BEFORE
// opening the transaction (they are pure and deterministic) and appends inside
// it. `decideOnce`'s closure is synchronous, which suits the pure pipeline.

import { createHash } from 'node:crypto';

import type {
  DecideOnceContext,
  DecideOnceDecision,
  DecideOnceStoredEvent,
  EventInput,
} from '../../event-store/atomic-appender.js';
import {
  AdmissionTransitionDecidedData,
  WorkflowCleanupData,
  WorkflowTransitionData,
} from '../../event-store/schemas.js';
import {
  selectEdge,
  type EdgeCandidate,
  type EdgeSelection,
} from './edge-condition-select.js';
import type { EdgeConditionFacts } from './edge-condition-evaluate.js';
import { resolveRequirements } from './requirement-resolution.js';
import type { RequirementContext } from './requirement-context.js';
import { freezeRequirements } from './freeze-requirements.js';
import type { FrozenRequirementSetProjection } from './freeze-requirements.js';
import {
  evaluatePolicy,
  type PolicyEvaluation,
  type PolicyVerdict,
} from './policy-evaluation.js';
import type { EvidenceContradiction } from './select-evidence.js';
import type { PolicyAuthority } from './policy-authority.js';
import {
  foldPhaseAttemptAdmission,
  type PhaseAttemptAdmissionFold,
} from './phase-attempt-state.js';
import {
  ADMISSION_EVENT_TYPES,
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  AdmissionDecisionRecordV1Schema,
  UnsatisfiedRequirementReasonSchema,
  type AdmissionDecisionRecordV1,
  type AdmissionEvidenceV1,
  type AdmissionRequirementV1,
  type ApprovalClass,
  type AttributedPrincipalV1,
  type AuthorizationSnapshotV1,
  type ContentDigestV1,
  type EvidenceId,
  type EvidenceSubjectV1,
  type OperationId,
  type PhaseAttemptId,
  type PolicyId,
  type RemediationActionV1,
  type WaiverId,
  type WaiverProvenanceV1,
} from './types.js';

// ─── Injected substrate ──────────────────────────────────────────────────────

/**
 * The narrow slice of {@link AtomicAppender} the chokepoint depends on. Keeping
 * the dependency to `decideOnce` lets tests inject a recording double to prove
 * the single-transaction, both-siblings contract without a real backend, while
 * the production `AtomicAppender` satisfies it structurally.
 */
export interface AdmissionDecider {
  decideOnce<TResult>(
    operationId: string,
    requestDigest: string,
    closure: (ctx: DecideOnceContext) => DecideOnceDecision<TResult>,
  ): Promise<TResult>;
}

// ─── Public command shapes ────────────────────────────────────────────────────

/** Topology: the legal-route question (P06-02). */
export interface TransitionRoute {
  readonly candidates: readonly EdgeCandidate[];
  readonly facts: EdgeConditionFacts;
}

/** The phase mutation this command intends when admission allows. */
export interface TransitionLifecycle {
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly trigger: string;
  readonly featureId: string;
}

/** Everything the evidence-backed admission decision folds over (P06-03/04). */
export interface TransitionAdmission {
  /** Normalized resolution context; resolved and frozen inside the chokepoint. */
  readonly requirementContext: RequirementContext;
  readonly approvalClass?: ApprovalClass;
  readonly activeEvidence: readonly AdmissionEvidenceV1[];
  readonly contradictions?: readonly EvidenceContradiction[];
  readonly waivers?: readonly WaiverProvenanceV1[];
  /** Out-of-band trust oracle (P01-07); self-asserted roles cannot authorize. */
  readonly authority: PolicyAuthority;
  /** Trusted RFC3339 evaluation instant — never `Date.now()`. */
  readonly evaluatedAt: string;
  readonly freshnessHorizonMs: number;
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
}

/** Trusted, frozen provenance stamped on the persisted decision (P01-07). */
export interface TransitionProvenance {
  readonly caller: AttributedPrincipalV1;
  readonly authorization: AuthorizationSnapshotV1;
}

export interface TransitionCommandInput {
  readonly appender: AdmissionDecider;
  readonly streamId: string;
  readonly operationId: OperationId;
  /** The stream version the caller observed before issuing this command (OCC). */
  readonly expectedVersion: number;
  readonly route: TransitionRoute;
  readonly lifecycle: TransitionLifecycle;
  readonly admission: TransitionAdmission;
  readonly provenance: TransitionProvenance;
}

/** A transition that reached admission and produced a persisted decision. */
export interface TransitionDecided {
  readonly outcome: 'admitted' | 'denied' | 'indeterminate';
  readonly verdict: PolicyVerdict;
  /** True iff the phase advanced. Only ever true under an `allow` verdict. */
  readonly phaseChanged: boolean;
  /** The persisted, authoritative admission decision (idempotent across retries). */
  readonly decision: AdmissionDecisionRecordV1;
  /** The legal route the transition took. */
  readonly route: Extract<EdgeSelection, { outcome: 'selected' }>;
  readonly evaluation: PolicyEvaluation;
  readonly frozenRequirements: readonly AdmissionRequirementV1[];
  readonly requirementSetDigest: ContentDigestV1;
  /** The append-only event types committed in the single atomic decision. */
  readonly appendedEventTypes: readonly string[];
  /** Integrity of the folded prior stream state (P01-04). */
  readonly foldIntegrity: PhaseAttemptAdmissionFold['integrity'];
}

/** A transition rejected at the topology layer — no admission, no persistence. */
export interface TransitionRouteRejected {
  readonly outcome: 'route-blocked' | 'no-route';
  readonly route: EdgeSelection;
}

export type TransitionCommandResult = TransitionDecided | TransitionRouteRejected;

// ─── Canonical serialization for content-addressed request digests ───────────

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, CanonicalJson>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ─── Stream fold (P01-04) ─────────────────────────────────────────────────────

/**
 * Fold the stream's admission facts at the transaction-consistent snapshot.
 * Reconstructs prior requirement / evidence / decision state so the chokepoint
 * reads state — never assumes it — before appending. Total: a malformed
 * historical fact degrades integrity to `'contested'`, it never throws.
 */
function foldTransitionStream(
  events: readonly DecideOnceStoredEvent[],
): PhaseAttemptAdmissionFold {
  const requirementEvents: unknown[] = [];
  const evidenceEvents: unknown[] = [];
  const decisionEvents: unknown[] = [];
  for (const event of events) {
    switch (event.type) {
      case ADMISSION_EVENT_TYPES.REQUIREMENT_RESOLVED:
        requirementEvents.push(event.data);
        break;
      case ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED:
        evidenceEvents.push(event.data);
        break;
      case ADMISSION_EVENT_TYPES.TRANSITION_DECIDED:
        decisionEvents.push(event.data);
        break;
      default:
        break;
    }
  }
  return foldPhaseAttemptAdmission({
    requirementEvents,
    evidenceEvents,
    decisionEvents,
  });
}

// ─── Decision record construction ─────────────────────────────────────────────

function collectEvidenceIds(evaluation: PolicyEvaluation): readonly EvidenceId[] {
  const ids = new Set<EvidenceId>();
  for (const evaluationEntry of evaluation.requirementEvaluations) {
    for (const evidenceId of evaluationEntry.evidenceIds) ids.add(evidenceId);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function remediationForRequirement(
  requirement: AdmissionRequirementV1,
): RemediationActionV1 {
  switch (requirement.kind) {
    case 'gate-evidence':
      return {
        action: 'run_gate',
        requirementId: requirement.requirementId,
        gateId: requirement.gateId,
      };
    case 'approval':
      return {
        action: 'request_approval',
        requirementId: requirement.requirementId,
      };
    case 'corroboration':
      return {
        action: 'collect_evidence',
        requirementId: requirement.requirementId,
        subject: requirement.subject,
      };
  }
}

interface DecisionBuildInput {
  readonly operationId: OperationId;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly evaluation: PolicyEvaluation;
  readonly frozen: FrozenRequirementSetProjection;
  readonly waivable: boolean;
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  readonly evaluatedAt: string;
  readonly freshnessHorizonMs: number;
}

function buildDecisionRecord(input: DecisionBuildInput): AdmissionDecisionRecordV1 {
  const {
    operationId,
    phaseAttemptId,
    evaluation,
    frozen,
    waivable,
    policyId,
    policyVersion,
    policyDigest,
    evaluatedAt,
  } = input;

  const byId = new Map<string, AdmissionRequirementV1>(
    frozen.requirements.map((requirement) => [requirement.requirementId, requirement]),
  );

  const evidenceIds = collectEvidenceIds(evaluation);
  const waiverIds: readonly WaiverId[] = evaluation.appliedWaiverIds;

  const inputDigestValue = sha256Hex(
    canonicalJson({
      requirementSetDigest: frozen.requirementSetDigest.value,
      policyDigest: policyDigest.value,
      policyId,
      policyVersion,
      evidenceIds: [...evidenceIds],
      waiverIds: [...waiverIds],
      evaluatedAt,
      freshnessHorizonMs: input.freshnessHorizonMs,
      verdict: evaluation.verdict,
    }),
  );
  const inputDigest: ContentDigestV1 = {
    algorithm: 'sha256',
    value: inputDigestValue,
  };
  const decisionId = `decision.${sha256Hex(`${operationId}\u0000${inputDigestValue}`).slice(0, 40)}`;

  const base = {
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    decisionId,
    operationId,
    phaseAttemptId,
    policyId,
    policyVersion,
    policyDigest,
    requirementSetDigest: frozen.requirementSetDigest,
    inputDigest,
    evidenceIds,
    waiverIds,
    decidedAt: evaluatedAt,
  } as const;

  const satisfiedRequirementIds = evaluation.requirementEvaluations
    .filter((entry) => entry.status === 'satisfied')
    .map((entry) => entry.requirementId);

  if (evaluation.verdict === 'allow') {
    const waivedRequirementIds = evaluation.requirementEvaluations
      .filter((entry) => entry.status === 'waived')
      .map((entry) => entry.requirementId);
    return AdmissionDecisionRecordV1Schema.parse({
      ...base,
      outcome: 'allow',
      satisfiedRequirementIds,
      waivedRequirementIds,
    });
  }

  if (evaluation.verdict === 'deny') {
    const denied = evaluation.requirementEvaluations.filter(
      (entry) => entry.status === 'denied',
    );
    const unsatisfiedRequirements = denied.map((entry) => ({
      requirementId: entry.requirementId,
      reason: UnsatisfiedRequirementReasonSchema.parse(
        entry.status === 'denied' ? entry.reason : 'failed',
      ),
    }));
    const remediation: RemediationActionV1[] = [];
    for (const entry of denied) {
      const requirement = byId.get(entry.requirementId);
      if (requirement !== undefined) {
        remediation.push(remediationForRequirement(requirement));
      }
    }
    if (waivable && denied.length > 0) {
      remediation.push({
        action: 'request_waiver',
        requirementIds: denied.map((entry) => entry.requirementId),
        phaseAttemptId,
      });
    }
    if (remediation.length === 0) {
      remediation.push({ action: 'retry_transition', phaseAttemptId });
    }
    return AdmissionDecisionRecordV1Schema.parse({
      ...base,
      outcome: 'deny',
      satisfiedRequirementIds,
      unsatisfiedRequirements,
      remediation,
    });
  }

  // indeterminate — fail closed, never rescued.
  const unresolved = evaluation.requirementEvaluations.filter(
    (entry) => entry.status === 'indeterminate',
  );
  const unresolvedRequirementIds = unresolved.map((entry) => entry.requirementId);
  const errors = unresolved.map((entry) => ({
    code: entry.status === 'indeterminate' ? entry.code : 'EVALUATOR_FAILED',
    message: `requirement ${entry.requirementId} could not be decided`,
  }));
  return AdmissionDecisionRecordV1Schema.parse({
    ...base,
    outcome: 'indeterminate',
    unresolvedRequirementIds,
    errors,
    remediation: [{ action: 'retry_transition', phaseAttemptId }],
  });
}

// ─── Event construction ───────────────────────────────────────────────────────

function decisionEvent(
  decision: AdmissionDecisionRecordV1,
  lifecycle: TransitionLifecycle,
  provenance: TransitionProvenance,
  operationId: OperationId,
): EventInput {
  const data = AdmissionTransitionDecidedData.parse({
    eventVersion: '1.0',
    subject: lifecycle.subject,
    decision,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
  return {
    type: ADMISSION_EVENT_TYPES.TRANSITION_DECIDED,
    data: data as unknown as Record<string, unknown>,
    operationId,
  };
}

function transitionLifecycleEvent(
  lifecycle: TransitionLifecycle,
  operationId: OperationId,
): EventInput {
  const data = WorkflowTransitionData.parse({
    from: lifecycle.fromPhase,
    to: lifecycle.toPhase,
    trigger: lifecycle.trigger,
    featureId: lifecycle.featureId,
    phaseAttemptId: lifecycle.phaseAttemptId,
  });
  return {
    type: 'workflow.transition',
    data: data as unknown as Record<string, unknown>,
    operationId,
  };
}

// ─── The chokepoint ───────────────────────────────────────────────────────────

interface AtomicDecisionResult {
  readonly decision: AdmissionDecisionRecordV1;
  readonly verdict: PolicyVerdict;
  readonly phaseChanged: boolean;
  readonly appendedEventTypes: readonly string[];
  readonly foldIntegrity: PhaseAttemptAdmissionFold['integrity'];
}

/**
 * Run a guarded phase transition through the sole admission chokepoint.
 *
 * Route legality is decided first and purely; an illegal edge returns without
 * touching the store. A legal edge is admitted, and the admission decision plus
 * (only under `allow`) the phase-transition lifecycle event are appended in ONE
 * atomic transaction. Retries with the same `operationId` return the identical
 * recorded decision; a stale `expectedVersion` raises a typed
 * {@link ConcurrencyError}.
 */
export async function runTransitionCommand(
  input: TransitionCommandInput,
): Promise<TransitionCommandResult> {
  // ─── 1. Route (topology legality) — pure, no persistence on rejection ──────
  const route = selectEdge(input.route.candidates, input.route.facts);
  if (route.outcome === 'no-match') {
    return { outcome: 'no-route', route };
  }
  if (route.outcome === 'blocked') {
    return { outcome: 'route-blocked', route };
  }

  // ─── 2. Admission (permission) — pure resolve → freeze → evaluate ──────────
  const resolved = resolveRequirements(input.admission.requirementContext);
  const frozen = freezeRequirements({
    resolved,
    phaseAttemptId: input.lifecycle.phaseAttemptId,
    subject: input.lifecycle.subject,
    ...(input.admission.approvalClass !== undefined
      ? { approvalClass: input.admission.approvalClass }
      : {}),
  });
  const evaluation = evaluatePolicy({
    requirements: frozen.requirements,
    obligations: resolved,
    activeEvidence: input.admission.activeEvidence,
    ...(input.admission.contradictions !== undefined
      ? { contradictions: input.admission.contradictions }
      : {}),
    ...(input.admission.waivers !== undefined
      ? { waivers: input.admission.waivers }
      : {}),
    authority: input.admission.authority,
    evaluatedAt: input.admission.evaluatedAt,
    freshnessHorizonMs: input.admission.freshnessHorizonMs,
  });

  const decision = buildDecisionRecord({
    operationId: input.operationId,
    phaseAttemptId: input.lifecycle.phaseAttemptId,
    evaluation,
    frozen,
    waivable: resolved.waivable,
    policyId: input.admission.policyId,
    policyVersion: input.admission.policyVersion,
    policyDigest: input.admission.policyDigest,
    evaluatedAt: input.admission.evaluatedAt,
    freshnessHorizonMs: input.admission.freshnessHorizonMs,
  });

  const phaseChanged = evaluation.verdict === 'allow';

  // The decision event ALWAYS records the attempt; the lifecycle event is its
  // sibling ONLY under an allow. deny / indeterminate fail closed (task 024).
  const events: EventInput[] = [
    decisionEvent(decision, input.lifecycle, input.provenance, input.operationId),
  ];
  if (phaseChanged) {
    events.push(transitionLifecycleEvent(input.lifecycle, input.operationId));
  }

  // ─── 3. Atomic append: decision + lifecycle siblings in ONE transaction ────
  const requestDigest = `sha256:${sha256Hex(
    canonicalJson({
      operationId: input.operationId,
      streamId: input.streamId,
      expectedVersion: input.expectedVersion,
      routeEdgeId: route.edgeId,
      routeIndex: route.index,
      lifecycle: {
        from: input.lifecycle.fromPhase,
        to: input.lifecycle.toPhase,
        trigger: input.lifecycle.trigger,
        featureId: input.lifecycle.featureId,
        phaseAttemptId: input.lifecycle.phaseAttemptId,
      },
      decision: decision as unknown as CanonicalJson,
    }),
  )}`;

  const atomic = await input.appender.decideOnce<AtomicDecisionResult>(
    input.operationId,
    requestDigest,
    (ctx) => {
      const snapshot = ctx.readStream(input.streamId);
      const fold = foldTransitionStream(snapshot.events);
      return {
        streamId: input.streamId,
        expectedSequence: input.expectedVersion,
        events: [...events],
        result: {
          decision,
          verdict: evaluation.verdict,
          phaseChanged,
          appendedEventTypes: events.map((event) => event.type),
          foldIntegrity: fold.integrity,
        },
      };
    },
  );

  const outcome: TransitionDecided['outcome'] =
    atomic.verdict === 'allow'
      ? 'admitted'
      : atomic.verdict === 'deny'
        ? 'denied'
        : 'indeterminate';

  return {
    outcome,
    verdict: atomic.verdict,
    phaseChanged: atomic.phaseChanged,
    decision: atomic.decision,
    route,
    evaluation,
    frozenRequirements: frozen.requirements,
    requirementSetDigest: frozen.requirementSetDigest,
    appendedEventTypes: atomic.appendedEventTypes,
    foldIntegrity: atomic.foldIntegrity,
  };
}

// ─── Cleanup — routed through the SAME atomic primitive (requirement #6) ──────

export interface CleanupCommandInput {
  readonly appender: AdmissionDecider;
  readonly streamId: string;
  readonly operationId: OperationId;
  readonly expectedVersion: number;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly trigger: string;
  readonly featureId: string;
  readonly phaseAttemptId?: PhaseAttemptId;
}

export interface CleanupCommandResult {
  readonly outcome: 'cleaned-up';
  readonly appendedEventTypes: readonly string[];
  readonly foldIntegrity: PhaseAttemptAdmissionFold['integrity'];
}

interface AtomicCleanupResult {
  readonly appendedEventTypes: readonly string[];
  readonly foldIntegrity: PhaseAttemptAdmissionFold['integrity'];
}

/**
 * Route a workflow cleanup phase mutation through the SAME atomic primitive the
 * transition chokepoint uses: one `decideOnce` transaction, the caller's
 * `expectedVersion` as the OCC gate, and `operationId` idempotency. There is no
 * second phase-mutation write path.
 */
export async function runCleanupCommand(
  input: CleanupCommandInput,
): Promise<CleanupCommandResult> {
  const cleanupData = WorkflowCleanupData.parse({
    from: input.fromPhase,
    to: input.toPhase,
    trigger: input.trigger,
    featureId: input.featureId,
    ...(input.phaseAttemptId !== undefined
      ? { phaseAttemptId: input.phaseAttemptId }
      : {}),
  });
  const cleanupEvent: EventInput = {
    type: 'workflow.cleanup',
    data: cleanupData as unknown as Record<string, unknown>,
    operationId: input.operationId,
  };

  const requestDigest = `sha256:${sha256Hex(
    canonicalJson({
      operationId: input.operationId,
      streamId: input.streamId,
      expectedVersion: input.expectedVersion,
      cleanup: cleanupData as unknown as CanonicalJson,
    }),
  )}`;

  const atomic = await input.appender.decideOnce<AtomicCleanupResult>(
    input.operationId,
    requestDigest,
    (ctx) => {
      const snapshot = ctx.readStream(input.streamId);
      const fold = foldTransitionStream(snapshot.events);
      return {
        streamId: input.streamId,
        expectedSequence: input.expectedVersion,
        events: [cleanupEvent],
        result: {
          appendedEventTypes: [cleanupEvent.type],
          foldIntegrity: fold.integrity,
        },
      };
    },
  );

  return {
    outcome: 'cleaned-up',
    appendedEventTypes: atomic.appendedEventTypes,
    foldIntegrity: atomic.foldIntegrity,
  };
}
