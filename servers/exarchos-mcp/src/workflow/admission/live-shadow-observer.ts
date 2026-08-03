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
//   3. BEHAVIOUR-PRESERVING — no I/O, no event emission, no state mutation. The
//      sink is a bounded in-memory buffer, so wiring the observer changes no
//      observable production behaviour (return values, emitted events, persisted
//      state) — only the live-evidence buffer the RESERVED cutover gate reads.
//
// Enforcement still does NOT flip here: the cutover gate remains the only place
// that can approve enforcement, and only once its four conditions hold.

import type { PhaseKind } from '../phase-kind.js';
import type { LiveShadowAttempt } from './cutover-gate.js';
import {
  runShadowDecision,
  type DisagreementExplanation,
  type ExplainResolver,
  type LegacyDecision,
  type LegacyTransitionObservation,
  type ShadowAttempt,
  type ShadowDecisionRecord,
} from './shadow-decision.js';
import { getEdgeIR, edgeKey } from './built-in-workflow-ir.js';
import {
  adjudicateEdge,
  createTranslationAuthority,
  type TranslationContext,
} from './legacy-state-translation.js';

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
    deps.sink.record({ attempt: liveAttempt, decision: record, edgeKey: key });
  } catch {
    // Shadow observation is never authoritative — a failure is swallowed.
  }
}

// ─── Production singleton wiring ────────────────────────────────────────────────

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
 */
export function recordLiveTransition(
  observation: LegacyTransitionObservation,
  state: Record<string, unknown>,
): void {
  observeLiveTransition(observation, state, {
    sink: liveShadowSink,
    context: {
      authority: SHARED_TRANSLATION_AUTHORITY,
      evaluatedAt: new Date().toISOString(),
      freshnessHorizonMs: LIVE_FRESHNESS_HORIZON_MS,
    },
  });
}
