// Wave 0 / Task D.8 — safety-semantics consumer contract.
//
// Design §2.4 commits that `annotations.safety` is consumed by this
// primitive and by `computeNextActions`. At D.8 implementation time
// the gating logic here keys off the per-transition `guard` attached
// to the HSM edge (composite / registered / custom guard), NOT off
// action.annotations.safety — these are different abstractions:
// transition guards gate phase-edges; action safety classifies the
// per-action side-effect profile. No refactor needed today.
//
// If a future requirement (e.g. "destructive actions cannot run in
// guarded read-only phases") arrives, the consumer here MUST read
// `findActionInRegistry(toolName, actionName)?.annotations.safety`
// from `../registry.js` — the registry is the single source of
// truth (DIM-1 Topology). Do NOT hand-code the safety enum or
// duplicate the §2.4 table in this primitive's prose. The smoke
// test `D.8 — annotations.safety is queryable from registry` in
// `next-actions-computer.test.ts` pins that contract.

// ─── HSMTransitionGuard.fail_closed (Primitive 3 — closes #1225) ─────────
//
// Single decision point for guarded HSM phase transitions. `workflow.set`
// in `tools.ts` delegates every `phase` update through `attempt`, which
// evaluates the composite guard and either appends `workflow.transition`
// (on guard pass) OR `workflow.guard-failed` (on guard fail) — never both
// for the same target in the same attempt. Non-phase updates remain on
// the existing `handleSet` field-only path; this primitive owns the
// dispatch contract for phase transitions only.
//
// Guard composition logic itself lives in `workflow/guards.ts`; this
// primitive reuses it via `executeTransition` rather than re-implementing
// it. The contract under #1259 is a strict-mode flag — once that lands,
// strict mode is the only mode and `workflow.set({ phase })` is removed.
// Until then, the routing here is the strict mode.

import type { EventStore } from '../event-store/store.js';
import type { GuardFailure } from './guards.js';
import {
  executeTransition,
  getHSMDefinition,
  findTransition,
  getValidTransitions,
} from './state-machine.js';
import type { HSMDefinition, ValidTransitionTarget } from './state-machine.js';
import type { PhaseKind, ResolvedGate, ResolveGateSetCtx } from './phase-kind.js';
import { applyPhaseSkips } from './phase-skip.js';
import { mapInternalToExternalType } from './events.js';
import { getRegisteredGuard } from '../config/register.js';
import { executeGuard } from '../config/guards.js';
import { buildValidatedEvent } from '../event-store/event-factory.js';
import type { EventType } from '../event-store/schemas.js';
import type { LegacyTransitionObservation } from './admission/shadow-decision.js';

// ─── HSM emission boundary — schema-checked data shaping (#1339) ───────────
//
// The HSM walk emits internal events (`transition`, `compound-entry`,
// `compound-exit`, `fix-cycle`, `guard-failed`, `circuit-open`, `cancel`,
// `cleanup`) with a uniform `{ from, to, trigger, metadata }` shape. The
// persisted-event boundary requires per-type `data` that conforms to
// `EVENT_DATA_SCHEMAS` (e.g. `fix-cycle` needs `count`, not `from/to/trigger`;
// `compound-entry` needs `compoundStateId`). Pre-#1339 these events were
// appended via the legacy `EventStore.append` path, which validates only the
// envelope and skips `EVENT_DATA_SCHEMAS`, laundering schema-invalid data onto
// the log. `buildHsmEventData` maps each internal event to its canonical
// external `data` shape so emission can route through `buildValidatedEvent`
// (which DOES run `EVENT_DATA_SCHEMAS`), closing the laundering hole.

interface HsmInternalEvent {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Build the canonical external `data` payload for an HSM-emitted event so it
 * validates against `EVENT_DATA_SCHEMAS`. `fixCycleOrdinal` supplies the
 * required `count` for `fix-cycle` events (the 1-based occurrence index).
 * `guardId` is folded in for `guard-failed` events to match the existing
 * event-store contract.
 */
export function buildHsmEventData(
  evt: HsmInternalEvent,
  featureId: string,
  opts: { guardId?: string; fixCycleOrdinal?: number; planRevisionOrdinal?: number },
): Record<string, unknown> {
  const metadata = evt.metadata ?? {};
  const compoundStateId = metadata.compoundStateId;

  switch (evt.type) {
    case 'fix-cycle':
      // WorkflowFixCycleData: { compoundStateId?, count, featureId }.
      // `compoundStateId` is optional (post-T-02) — omit when absent rather
      // than emitting it as `undefined`.
      return {
        ...(typeof compoundStateId === 'string'
          ? { compoundStateId }
          : {}),
        count: opts.fixCycleOrdinal ?? 1,
        featureId,
      };
    case 'plan-revision':
      // WorkflowPlanRevisionData: { compoundStateId?, count, featureId } (DR-1).
      // Identical shaping to fix-cycle — the count is the 1-based revise-cycle
      // ordinal supplied by the emission boundary; `compoundStateId` is omitted
      // when absent (plan-review is a top-level atomic phase).
      return {
        ...(typeof compoundStateId === 'string'
          ? { compoundStateId }
          : {}),
        count: opts.planRevisionOrdinal ?? 1,
        featureId,
      };
    case 'compound-entry':
      // WorkflowCompoundEntryData: { compoundStateId, featureId }.
      return {
        compoundStateId,
        featureId,
      };
    case 'compound-exit':
      // WorkflowCompoundExitData: { compoundStateId, featureId, from?, to?, trigger? }.
      return {
        compoundStateId: compoundStateId ?? evt.from,
        featureId,
        from: evt.from,
        to: evt.to,
        trigger: evt.trigger,
      };
    case 'circuit-open':
      // WorkflowCircuitOpenData: { featureId, compoundId, fixCycleCount?, maxFixCycles? }.
      return {
        featureId,
        compoundId:
          (typeof metadata.compoundId === 'string'
            ? metadata.compoundId
            : undefined) ??
          (typeof compoundStateId === 'string' ? compoundStateId : evt.from),
        ...(typeof metadata.fixCycleCount === 'number'
          ? { fixCycleCount: metadata.fixCycleCount }
          : {}),
        ...(typeof metadata.maxFixCycles === 'number'
          ? { maxFixCycles: metadata.maxFixCycles }
          : {}),
      };
    case 'guard-failed':
      // WorkflowGuardFailedData: { guard, from, to, featureId }.
      return {
        guard: opts.guardId ?? 'unknown',
        from: evt.from,
        to: evt.to,
        featureId,
      };
    case 'phase.entered':
      // PhaseEnteredData (DR-13): the resolve-then-freeze obligation, carried
      // verbatim in the HSM event's metadata. featureId is intentionally NOT
      // added — the schema is the obligation only (no from/to/trigger laundering).
      return {
        phase: metadata.phase ?? evt.to,
        kind: metadata.kind,
        resolver: metadata.resolver ?? null,
        resolvedGates: metadata.resolvedGates ?? [],
        policySource: metadata.policySource ?? 'builtin',
        mode: metadata.mode ?? 'enforce',
        posture: metadata.posture,
      };
    case 'phase.blocked': {
      // PhaseBlockedData (DR-7): the transition-boundary fail-closed record. The
      // state machine emits only { kind, reason } in metadata (state-machine.ts);
      // shape it into the canonical schema HERE so the resolver-fault event
      // round-trips as `phase.blocked` AND validates — never the unregistered
      // `workflow.phase.blocked` the `workflow.${type}` fallback would mint.
      const rawReason =
        typeof metadata.reason === 'string' && metadata.reason.length > 0
          ? metadata.reason
          : 'gate-set resolution failed';
      return {
        // The dispatch was blocked from ENTERING the target phase (evt.to),
        // whose kind's obligation faulted — keep `phase` and `kind` consistent.
        phase: typeof metadata.phase === 'string' ? metadata.phase : evt.to,
        kind: metadata.kind,
        reason: `phase transition blocked: ${String(metadata.kind)} gate-set resolution failed — ${rawReason}`,
        error: { code: 'PHASE_BLOCKED', message: rawReason },
      };
    }
    case 'phase.exited':
      // PhaseExitedData (DR-13): aggregate gate status on advance. Do NOT
      // `Boolean(...)`-coerce — a missing or non-boolean value must surface as
      // `undefined` so the required-boolean schema REJECTS it at the emission
      // boundary (a loud regression) instead of silently persisting `false`.
      return {
        phase: metadata.phase ?? evt.from,
        allRequiredGatesPassed:
          typeof metadata.allRequiredGatesPassed === 'boolean'
            ? metadata.allRequiredGatesPassed
            : undefined,
      };
    // transition / cancel / cleanup all share { from, to, trigger, featureId }
    // (cancel additionally allows an optional `reason`, preserved from metadata).
    default:
      return {
        from: evt.from,
        to: evt.to,
        trigger: evt.trigger,
        featureId,
        ...metadata,
      };
  }
}

/**
 * Count prior `workflow.fix-cycle` events on the stream (matching
 * `compoundStateId` when present) so the next fix-cycle event can carry a
 * 1-based `count` that satisfies `WorkflowFixCycleData`.
 */
async function nextFixCycleOrdinal(
  eventStore: EventStore,
  featureId: string,
  compoundStateId: unknown,
): Promise<number> {
  const prior = await eventStore.query(featureId, {
    type: 'workflow.fix-cycle' as EventType,
  });
  if (typeof compoundStateId === 'string') {
    const matching = prior.filter(
      (e) =>
        (e.data as Record<string, unknown> | undefined)?.compoundStateId ===
        compoundStateId,
    );
    return matching.length + 1;
  }
  return prior.length + 1;
}

/**
 * Count prior `workflow.plan-revision` events on the stream so the next
 * plan-revision event can carry a 1-based `count` that satisfies
 * `WorkflowPlanRevisionData` (DR-1). The plan-review revise loop is bounded by a
 * single workflow-level count, so — unlike fix cycles — the ordinal is NOT
 * scoped by `compoundStateId`; every prior plan-revision on the stream counts.
 */
async function nextPlanRevisionOrdinal(
  eventStore: EventStore,
  featureId: string,
): Promise<number> {
  const prior = await eventStore.query(featureId, {
    type: 'workflow.plan-revision' as EventType,
  });
  return prior.length + 1;
}

// ─── Public types ────────────────────────────────────────────────────────

/** Event payload appended on a successful attempt. */
export interface WorkflowTransitionEvent {
  readonly type: 'workflow.transition';
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly featureId: string;
  /** Sequence number assigned by the event store on append. */
  readonly sequence: number;
}

/**
 * Caller-supplied context for a transition attempt. Holds everything the
 * primitive needs to evaluate and emit, with no upward dependencies on
 * `tools.ts` or the orchestrator.
 */
export interface GuardContext {
  /** Live state object — guards read this directly. */
  readonly state: Record<string, unknown>;
  /** Workflow type used to look up the HSM definition. */
  readonly workflowType: string;
  /** Optional phase-skip overrides applied before transition lookup. */
  readonly skipPhases?: readonly string[] | undefined;
  /** Idempotency key suffix to deduplicate retried event appends. */
  readonly idempotencyKeySuffix?: string;
  /**
   * Event store the primitive writes to. Pure-evaluation callers can pass
   * `null` to skip emission and only learn the would-be outcome — useful
   * for the v3 substrate (#1259) where evaluation and emission split.
   */
  readonly eventStore: EventStore | null;
  /**
   * Phase-kind gate-set resolver (DR-10), forwarded to `executeTransition`.
   * Defaults to the real resolver when omitted; injectable so the fail-closed
   * `PHASE_BLOCKED` branch — unreachable through the real resolver for valid
   * inputs — is exercisable through the guard's full emission path.
   */
  readonly resolveGatesFn?: (
    kind: PhaseKind,
    ctx: ResolveGateSetCtx,
  ) => readonly ResolvedGate[];
  /**
   * P07-01 — a non-invasive shadow observer (Transition tasks 027/051). When
   * present, the primitive surfaces the AUTHORITATIVE legacy allow/deny outcome
   * of the composite-guard HSM walk to this callback AFTER the decision is made,
   * for side-by-side shadow comparison against the evidence-backed admission
   * engine. It is:
   *   - OPTIONAL and defaulted-off: no production caller sets it, so behaviour is
   *     byte-identical when it is absent (behaviour preservation);
   *   - ERROR-ISOLATED: any throw from the observer is swallowed — a shadow
   *     failure can never propagate into the production transition path;
   *   - PASSIVE: the observer receives the legacy outcome and cannot alter it.
   * All shadow adjudication, classification and recording live behind this seam
   * in `admission/shadow-decision.ts`, never in this primitive.
   */
  readonly shadowObserver?: (
    observation: LegacyTransitionObservation,
  ) => void;
  /**
   * DR-7 (INV-9) — admit the HSM's UNIVERSAL final-state edges.
   *
   * `cancelled` and `completed` are reachable from EVERY non-final phase
   * without an explicit edge in the HSM definition: `executeTransition`
   * special-cases them (`isCancel` / `isCleanup`) BEFORE its `findTransition`
   * lookup. This primitive's Step-1 lookup does not, which is precisely why
   * `cleanup.ts` and `cancel.ts` historically bypassed it and called
   * `executeTransition` directly — the bypass DR-7 closes.
   *
   * Opt-in rather than unconditional so the `exarchos_workflow transition`
   * path stays byte-identical: `workflow.set({ phase: 'cancelled' })` must
   * keep returning `no-transition-defined` instead of silently gaining the
   * ability to cancel a workflow without going through `handleCancel`. Only
   * the cleanup and cancel handlers set it, and they are the only two callers
   * that mutate a phase onto a universal final state.
   */
  readonly allowUniversalFinalTransition?: boolean;
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly transitionEvent: WorkflowTransitionEvent;
      /**
       * Whether this attempt was a no-op because the workflow was already
       * in `targetPhase`. The HSM treats this as a successful transition
       * (idempotent), but no events are emitted and no state mutation
       * is required.
       */
      readonly idempotent: boolean;
      /** Resolved phase after the transition (may equal currentPhase on idempotent). */
      readonly newPhase: string;
      /**
       * History updates the HSM walk produced (compound exit recording).
       * Caller merges these into `state._history` after a successful CAS
       * write. Empty on idempotent attempts.
       */
      readonly historyUpdates: Readonly<Record<string, string>>;
      /**
       * The full set of internal events emitted (including compound
       * entry/exit and fix-cycle events). Surfaced so the caller can
       * report structured `next_actions` without re-querying the store.
       */
      readonly emittedEvents: ReadonlyArray<{
        readonly type: string;
        readonly from: string;
        readonly to: string;
        readonly trigger: string;
        readonly metadata?: Record<string, unknown>;
      }>;
    }
  | {
      readonly ok: false;
      readonly reason: 'guard-failed';
      readonly failures: readonly GuardFailure[];
      /**
       * The guard id that failed (composite or atomic). Useful for
       * structured surfacing into MCP error responses.
       */
      readonly guardId: string;
      /** Stable error code used by `tools.ts` to surface failures over MCP. */
      readonly errorCode: 'GUARD_FAILED' | 'CIRCUIT_OPEN' | 'PHASE_BLOCKED';
      /** Human-readable error message. */
      readonly errorMessage: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'no-transition-defined';
      /**
       * Valid targets from `currentPhase`, enriched with the guard
       * metadata callers need to surface as MCP error context. Mirrors
       * `executeTransition`'s contract so `tools.ts` can pass the value
       * straight through.
       */
      readonly validTargets: readonly ValidTransitionTarget[];
      /** Stable error code used by `tools.ts`. */
      readonly errorCode: 'INVALID_TRANSITION';
      readonly errorMessage: string;
    };

export interface HSMTransitionGuard {
  attempt(
    featureId: string,
    currentPhase: string,
    targetPhase: string,
    context: GuardContext,
  ): Promise<TransitionResult>;
}

// ─── Implementation ──────────────────────────────────────────────────────

function resolveHSM(
  workflowType: string,
  skipPhases?: readonly string[],
): HSMDefinition {
  const base = getHSMDefinition(workflowType);
  if (!skipPhases || skipPhases.length === 0) return base;
  return applyPhaseSkips(base, skipPhases);
}

/**
 * Default `HSMTransitionGuard` implementation. Owns the entire dispatch
 * contract for guarded phase transitions:
 *
 *   1. Look up the transition definition (may be undefined for invalid
 *      target phases — returns `no-transition-defined`).
 *   2. Run any registered async/custom guards before the synchronous
 *      `executeTransition` call. A failure here emits
 *      `workflow.guard-failed` and returns `guard-failed` — the
 *      transition event is NEVER appended.
 *   3. Run `executeTransition` for the synchronous guard composition
 *      path. On guard fail, emit ONLY `workflow.guard-failed`. On
 *      success, emit ONLY `workflow.transition` (plus any compound
 *      entry/exit / fix-cycle siblings produced by the HSM walk).
 *
 * Atomicity guarantees:
 *   - Binary outcome atomicity: at most one of `workflow.transition` /
 *     `workflow.guard-failed` is appended per attempt outcome. The
 *     idempotency key on the event store dedups CAS retries.
 *   - Compound entry/exit events in the success path are NOT all-or-none:
 *     they are sequenced through `EventStore.append` independently, so a
 *     mid-loop throw can leave a partial trail. Stronger atomicity
 *     arrives in #1259's substrate refactor.
 */
/**
 * P07-01/P07-02 — fire the non-invasive shadow observer, if one is present, for
 * a single legacy transition outcome. Centralised so EVERY authoritative legacy
 * decision site (the composite HSM walk AND the custom-guard early-return deny
 * paths) surfaces to the observer through one error-isolated seam. Passive: it
 * only reads the already-computed outcome, never alters it, and a throw from the
 * observer is swallowed so a shadow failure can never propagate into the
 * production transition path. A no-op when no observer is wired (production
 * default), so behaviour is byte-identical.
 */
function notifyShadowObserver(
  context: GuardContext,
  observation: LegacyTransitionObservation,
): void {
  if (!context.shadowObserver) return;
  try {
    context.shadowObserver(observation);
  } catch {
    // Intentionally swallowed — shadow observation is never authoritative.
  }
}

/**
 * DR-7 — is `targetPhase` one of the HSM's UNIVERSAL final-state edges?
 *
 * Mirrors `executeTransition`'s own `isCancel` / `isCleanup` predicates
 * (state-machine.ts) exactly, so the primitive admits precisely the edge set
 * the HSM walk can actually resolve without an explicit `findTransition` hit.
 * Duplicating the predicate rather than exporting it keeps the walk's contract
 * the single authority on what those edges MEAN; this only decides whether the
 * Step-1 lookup may be skipped.
 */
function isUniversalFinalTarget(hsm: HSMDefinition, targetPhase: string): boolean {
  return (
    (targetPhase === 'cancelled' || targetPhase === 'completed') &&
    hsm.states[targetPhase]?.type === 'final'
  );
}

export class DefaultHSMTransitionGuard implements HSMTransitionGuard {
  async attempt(
    featureId: string,
    currentPhase: string,
    targetPhase: string,
    context: GuardContext,
  ): Promise<TransitionResult> {
    const hsm = resolveHSM(context.workflowType, context.skipPhases);

    // ─── Idempotency check ────────────────────────────────────────────
    // A no-op self-transition is a valid success case — no events, no
    // state mutation. Mirrors `executeTransition`'s behavior so callers
    // see a stable contract regardless of whether they reach the HSM
    // walk or short-circuit here.
    if (currentPhase === targetPhase) {
      return {
        ok: true,
        idempotent: true,
        newPhase: currentPhase,
        historyUpdates: {},
        emittedEvents: [],
        transitionEvent: {
          type: 'workflow.transition',
          from: currentPhase,
          to: currentPhase,
          trigger: 'execute-transition',
          featureId,
          sequence: -1,
        },
      };
    }

    // ─── Step 1: Lookup transition ────────────────────────────────────
    const transition = findTransition(hsm, currentPhase, targetPhase);
    // DR-7 — the universal `cancelled` / `completed` edges carry no explicit
    // definition; the HSM walk resolves them itself. Opt-in callers (cleanup /
    // cancel) skip the Step-1 short-circuit so their phase mutation runs
    // through THIS primitive instead of calling `executeTransition` directly.
    const universalFinal =
      transition === undefined &&
      context.allowUniversalFinalTransition === true &&
      isUniversalFinalTarget(hsm, targetPhase);
    if (!transition && !universalFinal) {
      // No definition for this target. The HSM is the source of truth on
      // valid edges — surface `no-transition-defined` so the caller can
      // surface a structured error. We do NOT emit any event here: this
      // is a programming error, not a guard failure, and emitting a
      // guard-failed for a non-existent edge would corrupt projections.
      // Enriched targets (phase + guard metadata) come from
      // `getValidTransitions` so callers can render actionable MCP
      // error responses.
      return {
        ok: false,
        reason: 'no-transition-defined',
        validTargets: getValidTransitions(hsm, currentPhase),
        errorCode: 'INVALID_TRANSITION',
        errorMessage: `No transition from '${currentPhase}' to '${targetPhase}'`,
      };
    }

    // ─── Step 2: Custom (async) guard pre-check ───────────────────────
    // Built-in guards remain inline in `executeTransition`. Custom guards
    // are async (shell-out) and registered via the project config; if
    // present, they must pass before the HSM walk runs. A failed custom
    // guard emits `workflow.guard-failed` and returns immediately.
    if (transition?.guard) {
      const registeredGuard = getRegisteredGuard(
        `${context.workflowType}:${transition.guard.id}`,
      );
      if (registeredGuard) {
        const customResult = await executeGuard(registeredGuard);
        if (!customResult.passed) {
          await emitGuardFailed(
            featureId,
            currentPhase,
            targetPhase,
            transition.guard.id,
            context,
          );
          const message = `Custom guard '${transition.guard.id}' failed: ${customResult.error ?? 'command exited non-zero'}`;
          // P07-02: extend the shadow seam to the custom-guard early-return deny
          // path — the legacy decision here is an authoritative `deny`, so the
          // observer must see it for coverage parity with the composite walk.
          notifyShadowObserver(context, {
            workflowType: context.workflowType,
            fromPhase: currentPhase,
            toPhase: targetPhase,
            legacyOutcome: 'deny',
            idempotent: false,
          });
          return {
            ok: false,
            reason: 'guard-failed',
            failures: [
              {
                passed: false,
                reason:
                  customResult.error ??
                  `Custom guard '${transition.guard.id}' failed`,
              },
            ],
            guardId: transition.guard.id,
            errorCode: 'GUARD_FAILED',
            errorMessage: message,
          };
        }
      } else if (transition.guard.custom) {
        // Fail-closed: a config-declared custom guard with no registry
        // entry is an unsatisfiable dependency. Treat it as a guard
        // failure (DIM-2 — explicit rejection, no silent drop). Note
        // we do NOT emit `workflow.guard-failed` here — this is a
        // configuration error, not a runtime guard failure, and
        // matches the pre-refactor `handleSet` behavior at #1225's
        // closure point.
        // P07-02: extend the shadow seam to the unregistered-custom-guard
        // fail-closed deny path as well (documented out-of-scope seam) — the
        // legacy decision is an authoritative `deny`.
        notifyShadowObserver(context, {
          workflowType: context.workflowType,
          fromPhase: currentPhase,
          toPhase: targetPhase,
          legacyOutcome: 'deny',
          idempotent: false,
        });
        return {
          ok: false,
          reason: 'guard-failed',
          failures: [
            {
              passed: false,
              reason: `Custom guard '${transition.guard.id}' is not registered`,
            },
          ],
          guardId: transition.guard.id,
          errorCode: 'GUARD_FAILED',
          errorMessage: `Custom guard '${transition.guard.id}' is not registered. Ensure registerCustomWorkflows() was called.`,
        };
      }
    }

    // ─── Step 3: Synchronous HSM walk (composite guard) ───────────────
    const result = executeTransition(
      hsm,
      context.state,
      targetPhase,
      context.resolveGatesFn,
    );

    // ─── P07-01: non-invasive shadow observation (Transition tasks 027/051) ──
    // Surface the AUTHORITATIVE legacy allow/deny to an injected observer for
    // side-by-side shadow comparison. Passive and error-isolated: it reads the
    // already-computed `result`, cannot alter it, and can never throw into this
    // path. Absent in every production caller, so behaviour is unchanged.
    notifyShadowObserver(context, {
      workflowType: context.workflowType,
      fromPhase: currentPhase,
      toPhase: targetPhase,
      legacyOutcome: result.success ? 'allow' : 'deny',
      idempotent: result.idempotent,
    });

    if (!result.success) {
      // DR-7 — on the universal-final path the walk itself owns the
      // route-legality verdict: if `mergeVerified` does not hold there may
      // still be no legal edge to `completed`, and `executeTransition`
      // reports that as INVALID_TRANSITION. Surface it as
      // `no-transition-defined` so the caller sees the same structured shape
      // (and the same `validTargets`) the Step-1 short-circuit produces,
      // rather than a guard failure for an edge that does not exist.
      if (universalFinal && result.errorCode === 'INVALID_TRANSITION') {
        return {
          ok: false,
          reason: 'no-transition-defined',
          validTargets: result.validTargets ?? getValidTransitions(hsm, currentPhase),
          errorCode: 'INVALID_TRANSITION',
          errorMessage:
            result.errorMessage ??
            `No transition from '${currentPhase}' to '${targetPhase}'`,
        };
      }
      // Emit any diagnostic events `executeTransition` produced
      // (typically a single `guard-failed`, possibly `circuit-open`).
      // We deliberately do NOT also append a `workflow.transition` —
      // this is the atomicity invariant the primitive enforces.
      if (context.eventStore) {
        for (const evt of result.events) {
          // #1339 (defense-in-depth, follows #1325 α-10): route HSM-emitted
          // events through `buildValidatedEvent` so `EVENT_DATA_SCHEMAS` runs
          // at the emission boundary. `buildHsmEventData` shapes the per-type
          // `data` (e.g. `compound-exit` carries `compoundStateId`,
          // `guard-failed` carries the offending guard id) so a schema-invalid
          // payload can never be laundered onto the log via the legacy path.
          const data = buildHsmEventData(evt, featureId, {
            ...(transition?.guard ? { guardId: transition.guard.id } : {}),
          });
          const validatedEvent = buildValidatedEvent(featureId, 1, {
            type: mapInternalToExternalType(evt.type) as EventType,
            correlationId: featureId,
            source: 'workflow',
            data,
          });
          await context.eventStore.appendValidated(featureId, validatedEvent);
        }
      }

      const guardFailures: GuardFailure[] = [
        {
          passed: false,
          reason: result.errorMessage ?? 'guard failed',
          ...(result.guardExpectedShape
            ? { expectedShape: result.guardExpectedShape }
            : {}),
          ...(result.guardSuggestedFix
            ? { suggestedFix: result.guardSuggestedFix }
            : {}),
        },
      ];

      // CIRCUIT_OPEN and PHASE_BLOCKED are surfaced under the same
      // `guard-failed` reason — from the dispatcher's perspective it's still
      // "transition not permitted" — but the distinct `errorCode` is PRESERVED,
      // not collapsed to GUARD_FAILED. PHASE_BLOCKED is the fail-closed
      // gate-set-resolution semantic (state-machine.ts); flattening it here
      // would hide a substrate-integrity failure behind a generic guard fault.
      const errorCode =
        result.errorCode === 'PHASE_BLOCKED'
          ? 'PHASE_BLOCKED'
          : result.errorCode === 'CIRCUIT_OPEN'
            ? 'CIRCUIT_OPEN'
            : 'GUARD_FAILED';
      return {
        ok: false,
        reason: 'guard-failed',
        failures: guardFailures,
        guardId: transition?.guard?.id ?? 'unknown',
        errorCode,
        errorMessage:
          result.errorMessage ?? `Transition failed to '${targetPhase}'`,
      };
    }

    // ─── Step 4: Success path — emit transition (+ siblings) ──────────
    // executeTransition returns one or more events on success: the
    // primary `transition` plus optional compound-entry/-exit and
    // fix-cycle events from the HSM walk. All of them belong to this
    // single attempt; the atomicity invariant is per-attempt, not
    // per-event-type.
    let transitionSequence = -1;
    if (context.eventStore) {
      for (const evt of result.events) {
        const idempotencyKey = context.idempotencyKeySuffix
          ? `${featureId}:${evt.type}:${evt.from}:${evt.to}:${context.idempotencyKeySuffix}`
          : undefined;
        // #1339 (defense-in-depth, follows #1325 α-10): route the success-path
        // emission (transition + compound-entry/-exit + fix-cycle siblings)
        // through `buildValidatedEvent` so `EVENT_DATA_SCHEMAS` runs at the
        // boundary. `fix-cycle` events need a `count` the HSM walk doesn't
        // carry; `nextFixCycleOrdinal` derives the 1-based occurrence index
        // from the store so the persisted `data` satisfies the schema.
        const fixCycleOrdinal =
          evt.type === 'fix-cycle'
            ? await nextFixCycleOrdinal(
                context.eventStore,
                featureId,
                evt.metadata?.compoundStateId,
              )
            : undefined;
        // DR-1 — plan-revision carries a 1-based ordinal `count` the HSM walk
        // doesn't supply, derived from prior plan-revision events on the stream
        // (the revise-loop analog of `fixCycleOrdinal`).
        const planRevisionOrdinal =
          evt.type === 'plan-revision'
            ? await nextPlanRevisionOrdinal(context.eventStore, featureId)
            : undefined;
        const data = buildHsmEventData(evt, featureId, {
          ...(transition?.guard ? { guardId: transition.guard.id } : {}),
          ...(fixCycleOrdinal !== undefined ? { fixCycleOrdinal } : {}),
          ...(planRevisionOrdinal !== undefined ? { planRevisionOrdinal } : {}),
        });
        const validatedEvent = buildValidatedEvent(featureId, 1, {
          type: mapInternalToExternalType(evt.type) as EventType,
          correlationId: featureId,
          source: 'workflow',
          data,
        });
        const appended = await context.eventStore.appendValidated(
          featureId,
          validatedEvent,
          idempotencyKey ? { idempotencyKey } : undefined,
        );
        // The state machine emits one primary lifecycle event per attempt:
        // 'transition' for normal phase moves, 'cancel' for user-cancel,
        // 'cleanup' for the universal mergeVerified→completed transition
        // (state-machine.ts:532, :578, :752). Capture the sequence on any of
        // these so the caller's _eventSequence projection cursor advances on
        // cancel/cleanup paths too. The DR-13 `phase.entered` freeze is appended
        // AFTER the transition (a higher sequence); advance the cursor to cover
        // it too (Math.max) so _eventSequence does not trail the log and trigger
        // a spurious reconcile of the just-frozen obligation.
        if (
          evt.type === 'transition' ||
          evt.type === 'cancel' ||
          evt.type === 'cleanup' ||
          evt.type === 'phase.entered' ||
          evt.type === 'phase.exited'
        ) {
          transitionSequence = Math.max(transitionSequence, appended.sequence);
        }
      }
    }

    return {
      ok: true,
      idempotent: result.idempotent === true,
      newPhase: result.newPhase ?? targetPhase,
      historyUpdates: { ...(result.historyUpdates ?? {}) },
      emittedEvents: result.events.map((e) => ({
        type: e.type,
        from: e.from,
        to: e.to,
        trigger: e.trigger,
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
      })),
      transitionEvent: {
        type: 'workflow.transition',
        from: currentPhase,
        to: result.newPhase ?? targetPhase,
        trigger: 'execute-transition',
        featureId,
        sequence: transitionSequence,
      },
    };
  }
}

/**
 * Emit a single `workflow.guard-failed` event. Best-effort: a failure to
 * persist the diagnostic must not mask the underlying guard failure
 * surfaced to the caller. The caller still returns `ok: false`.
 */
async function emitGuardFailed(
  featureId: string,
  fromPhase: string,
  targetPhase: string,
  guardId: string,
  context: GuardContext,
): Promise<void> {
  if (!context.eventStore) return;
  try {
    // Route through buildValidatedEvent for defense-in-depth Zod
    // validation (#1325). Sequence is a placeholder; the appender
    // assigns the authoritative value.
    const validatedEvent = buildValidatedEvent(featureId, 1, {
      type: 'workflow.guard-failed',
      correlationId: featureId,
      source: 'workflow',
      data: {
        from: fromPhase,
        to: targetPhase,
        guard: guardId,
        featureId,
      },
    });
    await context.eventStore.appendValidated(featureId, validatedEvent);
  } catch {
    // Diagnostic emission is best-effort. The structured failure in the
    // returned `TransitionResult` is the source of truth for the caller.
  }
}

// ─── Module-level singleton ──────────────────────────────────────────────
//
// One instance per process — the primitive is stateless beyond its
// dependencies, which arrive via `GuardContext`. Co-located with the
// implementation so callers don't have to manage construction. Tests
// can construct fresh `DefaultHSMTransitionGuard` instances if they
// need isolation.

export const hsmTransitionGuard: HSMTransitionGuard = new DefaultHSMTransitionGuard();
