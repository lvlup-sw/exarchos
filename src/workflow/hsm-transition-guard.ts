/**
 * The guarded HSM transition primitive, the single decision point for phase transitions.
 *
 * `handleSet` routes each `phase` update of `workflow.set` through `attempt`. A guard pass
 * appends `workflow.transition`, and a guard failure appends `workflow.guard-failed`,
 * never both for one attempt. The guard composition lives in `workflow/guards.ts`, and
 * this primitive reuses it through `executeTransition`.
 *
 * Transition guards gate phase edges and do not read `annotations.safety`. A future
 * safety check here must read `findActionInRegistry(toolName, actionName)?.annotations.safety`,
 * because the registry is the single source of truth. A test in
 * `next-actions-computer.test.ts` pins that the registry exposes this field.
 */
import type { EventStore } from '../events/store.js';
import type { GuardFailure } from './guards.js';
import {
  executeTransition,
  getHSMDefinition,
  findTransition,
  getValidTransitions,
} from './state-machine.js';
import type { HSMDefinition, ValidTransitionTarget } from './state-machine.js';
import type { TransitionObligationFloor } from './state-machine.js';
import type { PhaseKind, ResolvedGate, ResolveGateSetCtx } from './phase-kind.js';
import { applyPhaseSkips } from './phase-skip.js';
import { mapInternalToExternalType } from './events.js';
import { getRegisteredGuard } from '../config/register.js';
import { executeGuard } from '../config/guards.js';
import { buildValidatedEvent } from '../events/event-factory.js';
import type { EventType } from '../events/schemas.js';
import type { LegacyTransitionObservation } from './admission/shadow-decision.js';
import {
  resolveDangerCoordinate,
  type DangerCoordinate,
} from './admission/requirement-context.js';
import { readFrozenGateSequence } from './admission/freeze-requirements.js';

interface HsmInternalEvent {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Build the external `data` payload for an HSM event, so it validates against
 * `EVENT_DATA_SCHEMAS` in `buildValidatedEvent`. Each persisted type needs its own
 * fields. The ordinals give the 1-based `count`, and `guardId` goes into `guard-failed`.
 *
 * When absent, the optional `compoundStateId`, `riskTier`, and `boundaryTouching` are
 * omitted, not written as `undefined`. A `phase.exited` value that is not a boolean stays `undefined`, so the schema rejects
 * it and does not store `false`. `phase.blocked` gets its canonical shape here, so it
 * validates as `phase.blocked`.
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
      return {
        ...(typeof compoundStateId === 'string'
          ? { compoundStateId }
          : {}),
        count: opts.fixCycleOrdinal ?? 1,
        featureId,
      };
    case 'plan-revision':
      return {
        ...(typeof compoundStateId === 'string'
          ? { compoundStateId }
          : {}),
        count: opts.planRevisionOrdinal ?? 1,
        featureId,
      };
    case 'compound-entry':
      return {
        compoundStateId,
        featureId,
      };
    case 'compound-exit':
      return {
        compoundStateId: compoundStateId ?? evt.from,
        featureId,
        from: evt.from,
        to: evt.to,
        trigger: evt.trigger,
      };
    case 'circuit-open':
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
      return {
        guard: opts.guardId ?? 'unknown',
        from: evt.from,
        to: evt.to,
        featureId,
      };
    case 'phase.entered':
      return {
        phase: metadata.phase ?? evt.to,
        kind: metadata.kind,
        resolver: metadata.resolver ?? null,
        resolvedGates: metadata.resolvedGates ?? [],
        policySource: metadata.policySource ?? 'builtin',
        mode: metadata.mode ?? 'enforce',
        posture: metadata.posture,
        ...(metadata.riskTier !== undefined ? { riskTier: metadata.riskTier } : {}),
        ...(typeof metadata.boundaryTouching === 'boolean'
          ? { boundaryTouching: metadata.boundaryTouching }
          : {}),
      };
    case 'phase.blocked': {
      const rawReason =
        typeof metadata.reason === 'string' && metadata.reason.length > 0
          ? metadata.reason
          : 'gate-set resolution failed';
      return {
        phase: typeof metadata.phase === 'string' ? metadata.phase : evt.to,
        kind: metadata.kind,
        reason: `phase transition blocked: ${String(metadata.kind)} gate-set resolution failed — ${rawReason}`,
        error: { code: 'PHASE_BLOCKED', message: rawReason },
      };
    }
    case 'phase.exited':
      return {
        phase: metadata.phase ?? evt.from,
        allRequiredGatesPassed:
          typeof metadata.allRequiredGatesPassed === 'boolean'
            ? metadata.allRequiredGatesPassed
            : undefined,
      };
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
 * Count prior `workflow.plan-revision` events, so the next one carries a 1-based
 * `count`. Unlike fix cycles, the count is not scoped by `compoundStateId`, because
 * one workflow-level count bounds the revise loop.
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
   * The event store for emission. With `null`, the primitive emits nothing and only
   * returns the outcome.
   */
  readonly eventStore: EventStore | null;
  /**
   * The phase-kind gate-set resolver for `executeTransition`. It defaults to the real
   * resolver. A test can inject one to reach the fail-closed `PHASE_BLOCKED` branch.
   */
  readonly resolveGatesFn?: (
    kind: PhaseKind,
    ctx: ResolveGateSetCtx,
  ) => readonly ResolvedGate[];
  /**
   * Optional shadow observer. The guard calls it once per decision with the
   * legacy allow or deny outcome and the event store, so it can record durable
   * shadow evidence. It cannot change the outcome, and a throw or a rejected
   * promise is ignored. When it returns a promise, the guard waits for that
   * promise before it returns. So no write that the observer started is still
   * running when the caller closes the store (#2026).
   */
  readonly shadowObserver?: (
    observation: LegacyTransitionObservation,
    eventStore: EventStore | null,
  ) => unknown;
  /**
   * Admit the universal final edges, `cancelled` and `completed`. They have no explicit
   * HSM edge, and `executeTransition` resolves them itself. Only the cleanup and cancel
   * handlers set this flag. Without it, `workflow.set({ phase: 'cancelled' })` returns
   * `no-transition-defined`, so a workflow cannot cancel without `handleCancel`.
   */
  readonly allowUniversalFinalTransition?: boolean;
  /**
   * The workflow state before the field updates of this call. `handleSet` evaluates the
   * transition against the updated copy. Without a floor, a `riskTier` stamp in the same
   * call can lower the obligation of the transition that it comes with. This state gives
   * a monotonic floor. When it is omitted, only a frozen floor from the log can apply.
   */
  readonly priorState?: Record<string, unknown> | undefined;
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly transitionEvent: WorkflowTransitionEvent;
      /**
       * Whether the workflow was already in `targetPhase`. This is a success that
       * emits no events and needs no state change.
       */
      readonly idempotent: boolean;
      /** The phase after the transition. It equals `currentPhase` on an idempotent attempt. */
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

function resolveHSM(
  workflowType: string,
  skipPhases?: readonly string[],
): HSMDefinition {
  const base = getHSMDefinition(workflowType);
  if (!skipPhases || skipPhases.length === 0) return base;
  return applyPhaseSkips(base, skipPhases);
}

/**
 * Call the shadow observer, if one is set, and wait for any promise it returns.
 * Every legacy decision site goes through this one function. It forwards
 * `context.eventStore`, so the observer can make its evidence durable.
 * `live-shadow-observer.test.ts` fails if the store is not forwarded. A throw or
 * a rejection is ignored, because shadow observation never decides a transition.
 */
async function notifyShadowObserver(
  context: GuardContext,
  observation: LegacyTransitionObservation,
): Promise<void> {
  if (!context.shadowObserver) return;
  try {
    await context.shadowObserver(observation, context.eventStore);
  } catch {
  }
}

/**
 * Tell if `targetPhase` is a universal final edge. It mirrors the `isCancel` and
 * `isCleanup` predicates of `executeTransition`. It only decides if the edge lookup can
 * be skipped, and the walk keeps the authority on the meaning of the edge.
 */
function isUniversalFinalTarget(hsm: HSMDefinition, targetPhase: string): boolean {
  return (
    (targetPhase === 'cancelled' || targetPhase === 'completed') &&
    hsm.states[targetPhase]?.type === 'final'
  );
}

/** The `(risk, boundary)` claim a state object carries, or `null` if it makes none. */
function statedCoordinate(
  state: Record<string, unknown> | undefined,
): DangerCoordinate | null {
  if (state === undefined) return null;
  if (state.riskTier === undefined && state.boundaryTouching === undefined) return null;
  return resolveDangerCoordinate({
    risk: state.riskTier,
    boundary: state.boundaryTouching,
  });
}

/**
 * Read the obligation that the last `phase.entered` for the target phase froze. The
 * coordinate and the gates come from the durable log, not from current state. A record
 * without a coordinate gives only its gates. An unreadable gate list gives no gates.
 */
async function readFrozenFloorForPhase(
  eventStore: EventStore,
  featureId: string,
  targetPhase: string,
): Promise<TransitionObligationFloor | null> {
  const entered = await eventStore.query(featureId, {
    type: 'phase.entered' as EventType,
  });
  let latest: Record<string, unknown> | null = null;
  for (const event of entered) {
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined) continue;
    if (data.phase !== targetPhase) continue;
    latest = data;
  }
  if (latest === null) return null;
  const coordinate =
    latest.riskTier === undefined && latest.boundaryTouching === undefined
      ? null
      : resolveDangerCoordinate({
          risk: latest.riskTier,
          boundary: latest.boundaryTouching,
        });
  const gates = Array.isArray(latest.resolvedGates)
    ? readFrozenGateSequence(latest.resolvedGates)
    : null;
  if (coordinate === null && (gates === null || gates.length === 0)) return null;
  return {
    ...(coordinate !== null ? { coordinates: [coordinate] } : {}),
    ...(gates !== null && gates.length > 0 ? { gates } : {}),
  };
}

/**
 * Merge floor parts as a union, because each part is a lower bound. The floor raises
 * the obligation of this transition only. It is not written to state and does not
 * carry across phases.
 */
function mergeFloors(
  parts: readonly (TransitionObligationFloor | null)[],
): TransitionObligationFloor | undefined {
  const coordinates: DangerCoordinate[] = [];
  const gates: ResolvedGate[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part === null) continue;
    coordinates.push(...(part.coordinates ?? []));
    for (const gate of part.gates ?? []) {
      const key = `${gate.family}\u0000${gate.gate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gates.push(gate);
    }
  }
  if (coordinates.length === 0 && gates.length === 0) return undefined;
  return {
    ...(coordinates.length > 0 ? { coordinates } : {}),
    ...(gates.length > 0 ? { gates } : {}),
  };
}

/**
 * The default `HSMTransitionGuard`. It looks up the edge, runs registered custom guards,
 * then runs the synchronous `executeTransition` walk. An undefined edge returns
 * `no-transition-defined` and emits no event, also when the walk rejects a universal
 * final edge. A failure emits the diagnostic events of the walk, never
 * `workflow.transition`. A success appends the walk events one at a time, so a throw in
 * the loop can leave a partial trail.
 */
export class DefaultHSMTransitionGuard implements HSMTransitionGuard {
  /**
   * Decide a request `target` against the HSM definition. ActionId admission does not
   * name this edge, so this primitive is the only authority on its legality.
   *
   * An unregistered custom guard fails closed without a `guard-failed` event, because it
   * is a config error. The obligation floor comes from `priorState` and the last
   * `phase.entered` for the target phase. `CIRCUIT_OPEN` and `PHASE_BLOCKED` keep their
   * codes. The returned sequence is the highest sequence of the lifecycle and phase events.
   */
  async attempt(
    featureId: string,
    currentPhase: string,
    targetPhase: string,
    context: GuardContext,
  ): Promise<TransitionResult> {
    const hsm = resolveHSM(context.workflowType, context.skipPhases);

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

    const transition = findTransition(hsm, currentPhase, targetPhase);
    const universalFinal =
      transition === undefined &&
      context.allowUniversalFinalTransition === true &&
      isUniversalFinalTarget(hsm, targetPhase);
    if (!transition && !universalFinal) {
      return {
        ok: false,
        reason: 'no-transition-defined',
        validTargets: getValidTransitions(hsm, currentPhase),
        errorCode: 'INVALID_TRANSITION',
        errorMessage: `No transition from '${currentPhase}' to '${targetPhase}'`,
      };
    }

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
          await notifyShadowObserver(context, {
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
        await notifyShadowObserver(context, {
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

    const priorCoordinate = statedCoordinate(context.priorState);
    const floor = mergeFloors([
      priorCoordinate === null ? null : { coordinates: [priorCoordinate] },
      context.eventStore === null
        ? null
        : await readFrozenFloorForPhase(context.eventStore, featureId, targetPhase),
    ]);
    const result = executeTransition(
      hsm,
      context.state,
      targetPhase,
      context.resolveGatesFn,
      floor,
    );

    await notifyShadowObserver(context, {
      workflowType: context.workflowType,
      fromPhase: currentPhase,
      toPhase: targetPhase,
      legacyOutcome: result.success ? 'allow' : 'deny',
      idempotent: result.idempotent,
    });

    if (!result.success) {
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
      if (context.eventStore) {
        for (const evt of result.events) {
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

    let transitionSequence = -1;
    if (context.eventStore) {
      for (const evt of result.events) {
        const idempotencyKey = context.idempotencyKeySuffix
          ? `${featureId}:${evt.type}:${evt.from}:${evt.to}:${context.idempotencyKeySuffix}`
          : undefined;
        const fixCycleOrdinal =
          evt.type === 'fix-cycle'
            ? await nextFixCycleOrdinal(
                context.eventStore,
                featureId,
                evt.metadata?.compoundStateId,
              )
            : undefined;
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
  }
}

/**
 * The process-wide instance. The primitive has no state beyond `GuardContext`. Tests
 * can construct a fresh `DefaultHSMTransitionGuard` for isolation.
 */
export const hsmTransitionGuard: HSMTransitionGuard = new DefaultHSMTransitionGuard();
