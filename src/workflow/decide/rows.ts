/**
 * Maps the internal events of a move to the rows that a store appends.
 *
 * Each internal event gets its external event type and a data payload that parses with the data schema of
 * that type. The fix-cycle and revise ordinals come from the stream rows, so a replay gives the same counts.
 *
 * The rows hold no idempotency key and no operation id. Each caller stamps them before the append.
 */

import { mapInternalToExternalType } from '../events.js';
import { validateEventData } from '../../events/event-validation.js';
import { EventTypes, type EventType } from '../../events/schemas.js';
import {
  fixCycleOrdinalOf,
  planRevisionOrdinalOf,
  type PhaseStreamRow,
  type TransitionEvent,
} from './emit.js';

/** One row of a move, ready for the stamp and the append. */
export type PhaseRow = {
  readonly type: EventType;
  readonly data: Record<string, unknown>;
  readonly correlationId: string;
  readonly source: 'workflow';
};

/** The context of the rows of one move: the guard of the edge and the stream rows before the move. */
export interface PhaseRowContext {
  readonly guardId?: string | undefined;
  readonly rows: readonly PhaseStreamRow[];
}

/**
 * Builds the external `data` payload of an HSM event, so it validates against `EVENT_DATA_SCHEMAS` in
 * `buildValidatedEvent`. Each persisted type needs its own fields. The ordinals give the 1-based `count`,
 * and `guardId` goes into `guard-failed`.
 *
 * The function omits an absent `compoundStateId`, `riskTier`, or `boundaryTouching`, and never writes
 * `undefined` for them. A non-boolean `allRequiredGatesPassed` stays `undefined`, so the schema rejects it
 * and does not store `false`. The `phase.entered` payload holds only the obligation, with no `featureId`.
 * `phase.blocked` gets its canonical shape here, so it validates as `phase.blocked`.
 */
export function buildHsmEventData(
  evt: TransitionEvent,
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

/** True when the name is a built-in event type. */
function isEventType(name: string): name is EventType {
  return EventTypes.some((type) => type === name);
}

/**
 * Maps the internal events of one move to rows, in event order. Each row has the external type of its
 * event and a payload that its data schema accepts.
 * @throws When an event maps to a type that is not a built-in event type, or when a payload does not parse.
 */
export function phaseRowsOf(
  events: readonly TransitionEvent[],
  featureId: string,
  context: PhaseRowContext,
): readonly PhaseRow[] {
  return events.map((event) => {
    const type = mapInternalToExternalType(event.type);
    if (!isEventType(type)) {
      throw new Error(`the event '${event.type}' maps to the unknown event type '${type}'`);
    }
    const data = buildHsmEventData(event, featureId, {
      ...(context.guardId === undefined ? {} : { guardId: context.guardId }),
      ...(event.type === 'fix-cycle'
        ? { fixCycleOrdinal: fixCycleOrdinalOf(context.rows, event.metadata?.compoundStateId) }
        : {}),
      ...(event.type === 'plan-revision' ? { planRevisionOrdinal: planRevisionOrdinalOf(context.rows) } : {}),
    });
    validateEventData(type, data);
    return { type, data, correlationId: featureId, source: 'workflow' };
  });
}
