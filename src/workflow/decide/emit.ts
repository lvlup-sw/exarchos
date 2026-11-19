/**
 * The emission over one compiled definition. It gives the events, the effects, the history and the gates
 * of one admitted move, in the result shape of the legacy executor.
 *
 * The legacy executor and this emission share one gate rule. The floor gates come first. Then come the
 * gates of the state coordinate, and then the gates of each floor coordinate. Each gate occurs once. The
 * `phase.entered` event freezes the list with the join of the coordinates.
 *
 * The ordinals and the frozen floor come from the stream rows. So a replay of the rows gives the same
 * values as the live run.
 *
 * This module reads no store, no clock and no legacy guard module.
 */

import { KIND_OBLIGATIONS, resolveGateSetFailClosed } from '../phase-kind.js';
import type { PhaseKind, ResolvedGate, ResolveGateSetCtx } from '../phase-kind.js';
import {
  dangerBoundaryTouching,
  joinDangerCoordinates,
  resolveDangerCoordinate,
  type DangerCoordinate,
} from '../admission/requirement-context.js';
import { readFrozenGateSequence } from '../admission/freeze-requirements.js';
import type { DesignDepth } from '../plan-depth-policy.js';
import type { Effect, ExarchosExtension } from '../definitions/extension.js';
import type { DecideDefinition, DecideEdge, UniversalMove } from './edges.js';

/** One internal event of a transition result. */
export interface TransitionEvent {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly metadata?: Record<string, unknown>;
}

/** One valid target of a phase, with the guard that the target needs. */
export interface ValidTransitionTarget {
  readonly phase: string;
  readonly guard?: { readonly id: string; readonly description: string };
  readonly universal?: boolean;
}

/**
 * The obligation floor of a transition. Both members are lower bounds, so they can only add gates.
 * The transition resolves at each coordinate and unions the results.
 * No single coordinate dominates, because the ladder escalates an unknown tier and the review roster treats it as no tier claim.
 */
export interface TransitionObligationFloor {
  /** Danger coordinates to ALSO resolve at, unioning the results. */
  readonly coordinates?: readonly DangerCoordinate[];
  /** Gates that a prior freeze of this phase recorded. They lead the union, so a policy edit between attempts cannot remove a frozen gate. */
  readonly gates?: readonly ResolvedGate[];
}

/** The result of one transition: the move, or the code and the diagnostic events of a refusal. */
export interface TransitionResult {
  readonly success: boolean;
  readonly idempotent: boolean;
  readonly newPhase?: string;
  readonly effects: readonly Effect[];
  readonly events: readonly TransitionEvent[];
  readonly historyUpdates?: Record<string, string> | undefined;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly guardDescription?: string;
  readonly validTargets?: readonly ValidTransitionTarget[];
  readonly guardExpectedShape?: Record<string, unknown>;
  readonly guardSuggestedFix?: {
    readonly tool: string;
    readonly params: Record<string, unknown>;
  };
  /**
   * The gate-set of the target kind. It is present after an advance into an atomic state with a kind, and empty for IMPLEMENT.
   * The `phase.entered` event freezes the same list.
   */
  readonly resolvedGates?: readonly ResolvedGate[];
}

/** The gate-set resolver of a phase kind. */
export type GateResolver = (kind: PhaseKind, ctx: ResolveGateSetCtx) => readonly ResolvedGate[];

/** The inputs of one entry into an atomic phase with a kind. */
export interface PhaseEntryRequest {
  readonly workflowType: string;
  readonly from: string;
  readonly to: string;
  readonly kind: PhaseKind;
  readonly stateCoordinate: DangerCoordinate;
  readonly designDepth: DesignDepth;
  readonly floor?: TransitionObligationFloor | undefined;
  readonly resolveGatesFn?: GateResolver | undefined;
}

/** The outcome of one entry: the gates and the `phase.entered` event, or the `PHASE_BLOCKED` result. */
export type PhaseEntry =
  | { readonly ok: true; readonly resolvedGates: readonly ResolvedGate[]; readonly event: TransitionEvent }
  | { readonly ok: false; readonly result: TransitionResult };

/** One stored row of a stream. Only the type and the data are read. */
export interface PhaseStreamRow {
  readonly type: string;
  readonly data?: unknown;
}

/** The key of a gate in the union. A gate occurs once for each family and name. */
function gateKey(gate: ResolvedGate): string {
  return `${gate.family}\u0000${gate.gate}`;
}

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the value is a planning depth. */
function isDesignDepth(value: unknown): value is DesignDepth {
  return value === 'thin' || value === 'standard' || value === 'deep';
}

/** The `(risk, boundary)` claim of a state object, or `null` when it makes none. */
export function statedCoordinate(state: Record<string, unknown> | undefined): DangerCoordinate | null {
  if (state === undefined) return null;
  if (state.riskTier === undefined && state.boundaryTouching === undefined) return null;
  return resolveDangerCoordinate({
    risk: state.riskTier,
    boundary: state.boundaryTouching,
  });
}

/**
 * Merges floor parts as a union, because each part is a lower bound. The floor raises the obligation of
 * one transition only. It is not written to state and does not carry across phases, because a
 * feature-wide floor makes one untiered transition escalate every later transition.
 */
export function mergeFloors(
  parts: readonly (TransitionObligationFloor | null)[],
): TransitionObligationFloor | undefined {
  const coordinates: DangerCoordinate[] = [];
  const gates: ResolvedGate[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part === null) continue;
    coordinates.push(...(part.coordinates ?? []));
    for (const gate of part.gates ?? []) {
      const key = gateKey(gate);
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

/** The union of the gates of one entry and the join of its coordinates, or the reason of a resolver fault. */
type GateUnion =
  | { readonly ok: true; readonly gates: readonly ResolvedGate[]; readonly frozenCoordinate: DangerCoordinate }
  | { readonly ok: false; readonly reason: string };

/**
 * Unions the gates of one entry. The floor gates come first, then the gates of the state coordinate, then
 * the gates of each floor coordinate. The order of the union is the order of evaluation.
 */
function unionGates(request: PhaseEntryRequest): GateUnion {
  const { floor, stateCoordinate } = request;
  const coordinates: readonly DangerCoordinate[] = [stateCoordinate, ...(floor?.coordinates ?? [])];
  const unioned: ResolvedGate[] = [];
  const seen = new Set<string>();
  let frozenCoordinate: DangerCoordinate = stateCoordinate;
  for (const gate of floor?.gates ?? []) {
    const key = gateKey(gate);
    if (seen.has(key)) continue;
    seen.add(key);
    unioned.push(gate);
  }
  for (const coordinate of coordinates) {
    const resolved = resolveGateSetFailClosed(
      request.kind,
      {
        riskTier: coordinate.risk,
        boundaryTouching: dangerBoundaryTouching(coordinate),
        workflowType: request.workflowType,
        designDepth: request.designDepth,
      },
      request.resolveGatesFn,
    );
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    for (const gate of resolved.gates) {
      const key = gateKey(gate);
      if (seen.has(key)) continue;
      seen.add(key);
      unioned.push(gate);
    }
    frozenCoordinate = joinDangerCoordinates(frozenCoordinate, coordinate);
  }
  return { ok: true, gates: unioned, frozenCoordinate };
}

/**
 * Resolves the obligation of one entry into an atomic phase, and builds its `phase.entered` event. The
 * event freezes the gates, the joined coordinate, the posture and, for PLAN, the planning depth. IMPLEMENT
 * records no phase-level gate sequence. A resolver fault gives the `PHASE_BLOCKED` result with its
 * `phase.blocked` event.
 */
export function phaseEntryOf(request: PhaseEntryRequest): PhaseEntry {
  const { from, to, kind } = request;
  const union = unionGates(request);
  if (!union.ok) {
    return {
      ok: false,
      result: {
        success: false,
        idempotent: false,
        effects: [],
        events: [
          {
            type: 'phase.blocked',
            from,
            to,
            trigger: 'execute-transition',
            metadata: { kind, reason: union.reason },
          },
        ],
        errorCode: 'PHASE_BLOCKED',
        errorMessage: `Gate-set resolution failed for ${kind} phase '${to}': ${union.reason}`,
      },
    };
  }
  const resolvedGates = kind === 'IMPLEMENT' ? [] : union.gates;
  return {
    ok: true,
    resolvedGates,
    event: {
      type: 'phase.entered',
      from,
      to,
      trigger: 'execute-transition',
      metadata: {
        phase: to,
        kind,
        resolver: KIND_OBLIGATIONS[kind].gates?.resolver ?? null,
        resolvedGates: resolvedGates.map((gate) => ({ family: gate.family, gate: gate.gate })),
        riskTier: union.frozenCoordinate.risk,
        boundaryTouching: dangerBoundaryTouching(union.frozenCoordinate),
        posture: KIND_OBLIGATIONS[kind].posture,
        policySource: 'builtin',
        mode: 'enforce',
        ...(kind === 'PLAN' ? { designDepth: request.designDepth } : {}),
      },
    },
  };
}

/** One group of a compiled definition. */
type DecideGroup = ExarchosExtension['groups'][number];

/** Returns the group of a phase, or `undefined` when the phase is in no group or is no step. */
function groupOf(def: DecideDefinition, phase: string): DecideGroup | undefined {
  const groupId = def.steps.find((step) => step.stepId === phase)?.groupId;
  return groupId === undefined ? undefined : def.groups.find((group) => group.groupId === groupId);
}

/** Returns the phase attempt id of the input, when the caller allocated one. */
function pendingAttemptOf(input: Record<string, unknown>): string | undefined {
  return typeof input._pendingPhaseAttemptId === 'string' ? input._pendingPhaseAttemptId : undefined;
}

/** Counts the `fix-cycle` events of the input for one group. */
function fixCyclesOf(input: Record<string, unknown>, groupId: string): number {
  const events: unknown = input._events;
  if (!Array.isArray(events)) return 0;
  return events.filter(
    (event) =>
      isRecord(event) &&
      event.type === 'fix-cycle' &&
      isRecord(event.metadata) &&
      event.metadata.compoundStateId === groupId,
  ).length;
}

/**
 * Returns the result of a move to a final step through a universal move. The exit effects of the group
 * run, and the group records the source phase as its history.
 */
function finalMoveOf(
  def: DecideDefinition,
  from: string,
  to: string,
  type: 'cancel' | 'cleanup',
  input: Record<string, unknown>,
): TransitionResult {
  const group = groupOf(def, from);
  const attempt = pendingAttemptOf(input);
  return {
    success: true,
    idempotent: false,
    newPhase: to,
    effects: group?.onExit === undefined ? [] : [...group.onExit],
    events: [
      {
        type,
        from,
        to,
        trigger: type === 'cancel' ? 'user-cancel' : 'cleanup',
        ...(attempt === undefined ? {} : { metadata: { phaseAttemptId: attempt } }),
      },
    ],
    historyUpdates: group === undefined ? undefined : { [group.groupId]: from },
  };
}

/** Returns the `CIRCUIT_OPEN` result of a fix-cycle edge whose group reached its cap, or `undefined`. */
function circuitOpenOf(edge: DecideEdge, group: DecideGroup | undefined, input: Record<string, unknown>): TransitionResult | undefined {
  if (edge.isFixCycle !== true || group?.maxFixCycles === undefined) return undefined;
  const fixCount = fixCyclesOf(input, group.groupId);
  if (fixCount < group.maxFixCycles) return undefined;
  return {
    success: false,
    idempotent: false,
    effects: [],
    events: [
      {
        type: 'circuit-open',
        from: edge.from,
        to: edge.to,
        trigger: 'execute-transition',
        metadata: {
          compoundStateId: group.groupId,
          compoundId: group.groupId,
          fixCycleCount: fixCount,
          maxFixCycles: group.maxFixCycles,
        },
      },
    ],
    errorCode: 'CIRCUIT_OPEN',
    errorMessage: `Fix cycle limit (${group.maxFixCycles}) reached for compound '${group.groupId}'`,
  };
}

/**
 * Returns the result of one admitted explicit edge. A group exit and a group entry each give their event
 * and their effects. A fix-cycle edge and a revise edge each add their counted event. The standard feature
 * `plan-review -> plan` edge adds no revise event.
 */
function explicitMoveOf(
  def: DecideDefinition,
  edge: DecideEdge,
  input: Record<string, unknown>,
  floor: TransitionObligationFloor | undefined,
  resolveGatesFn: GateResolver | undefined,
): TransitionResult {
  const { from, to } = edge;
  const sourceGroup = groupOf(def, from);
  const targetGroup = groupOf(def, to);
  const circuitOpen = circuitOpenOf(edge, sourceGroup, input);
  if (circuitOpen !== undefined) return circuitOpen;
  const leaves = sourceGroup !== undefined && sourceGroup.groupId !== targetGroup?.groupId;
  const enters = targetGroup !== undefined && targetGroup.groupId !== sourceGroup?.groupId;
  const attempt = pendingAttemptOf(input);
  const effects: Effect[] = [
    ...(leaves ? (sourceGroup.onExit ?? []) : []),
    ...(enters ? (targetGroup.onEntry ?? []) : []),
    ...(edge.effects ?? []),
  ];
  const events: TransitionEvent[] = [
    {
      type: 'transition',
      from,
      to,
      trigger: 'execute-transition',
      ...(attempt === undefined ? {} : { metadata: { phaseAttemptId: attempt } }),
    },
  ];
  if (enters) {
    events.push({
      type: 'compound-entry',
      from,
      to: targetGroup.groupId,
      trigger: 'execute-transition',
      metadata: { compoundStateId: targetGroup.groupId },
    });
  }
  if (leaves) {
    events.push({ type: 'compound-exit', from: sourceGroup.groupId, to, trigger: 'execute-transition' });
  }
  const groupMetadata = sourceGroup === undefined ? {} : { compoundStateId: sourceGroup.groupId };
  if (edge.isFixCycle === true) {
    events.push({ type: 'fix-cycle', from, to, trigger: 'execute-transition', metadata: { ...groupMetadata } });
  }
  const isStandardPlanReviseEdge = def.workflowType === 'feature' && from === 'plan-review' && to === 'plan';
  if (edge.isRevision === true && !isStandardPlanReviseEdge) {
    events.push({ type: 'plan-revision', from, to, trigger: 'execute-transition', metadata: { ...groupMetadata } });
  }
  events.push({
    type: 'phase.exited',
    from,
    to,
    trigger: 'execute-transition',
    metadata: { phase: from, allRequiredGatesPassed: edge.isFixCycle !== true },
  });
  const targetKind = def.steps.find((step) => step.stepId === to)?.kind;
  let resolvedGates: readonly ResolvedGate[] | undefined;
  if (targetKind !== undefined) {
    const entry = phaseEntryOf({
      workflowType: def.workflowType,
      from,
      to,
      kind: targetKind,
      stateCoordinate: resolveDangerCoordinate({ risk: input.riskTier, boundary: input.boundaryTouching }),
      designDepth: isDesignDepth(input.designDepth) ? input.designDepth : 'standard',
      floor,
      resolveGatesFn,
    });
    if (!entry.ok) return entry.result;
    resolvedGates = entry.resolvedGates;
    events.push(entry.event);
  }
  return {
    success: true,
    idempotent: false,
    newPhase: to,
    effects,
    events,
    historyUpdates: leaves ? { [sourceGroup.groupId]: from } : undefined,
    ...(resolvedGates === undefined ? {} : { resolvedGates }),
  };
}

/**
 * Returns the result of one admitted move on one guard input: the events, the effects, the history and the
 * gates. The source phase is `input.phase`. An explicit edge into the cancel target gives the cancel trail,
 * as the legacy executor does. The floor raises the gates of the target, and a test injects the resolver.
 */
export function phaseMoveEvents(
  def: DecideDefinition,
  input: Record<string, unknown>,
  move: DecideEdge | UniversalMove,
  floor?: TransitionObligationFloor,
  resolveGatesFn?: GateResolver,
): TransitionResult {
  const from = typeof input.phase === 'string' ? input.phase : '';
  if (move.edgeKind === 'cleanup') return finalMoveOf(def, from, move.to, 'cleanup', input);
  if (move.edgeKind === 'cancel' || move.to === def.cancel?.to) return finalMoveOf(def, from, move.to, 'cancel', input);
  return explicitMoveOf(def, move, input, floor, resolveGatesFn);
}

/**
 * Returns the `GUARD_FAILED` result of one denied explicit edge, with its one `guard-failed` event. The event
 * names the guard of the edge, or the transition id when the edge names no guard.
 */
export function denialEvents(from: string, edge: DecideEdge): TransitionResult {
  const guard = edge.guardId ?? edge.transitionId;
  return {
    success: false,
    idempotent: false,
    effects: [],
    events: [
      {
        type: 'guard-failed',
        from,
        to: edge.to,
        trigger: 'execute-transition',
        metadata: { guard },
      },
    ],
    errorCode: 'GUARD_FAILED',
    errorMessage: `Guard '${guard}' failed on the edge '${edge.transitionId}'`,
  };
}

/**
 * Returns the obligation that the last `phase.entered` row of the target froze, or `null`. A row with no
 * coordinate gives only its gates. An unreadable gate list gives no gates.
 */
export function frozenFloorOf(rows: readonly PhaseStreamRow[], target: string): TransitionObligationFloor | null {
  let latest: Record<string, unknown> | null = null;
  for (const row of rows) {
    if (row.type !== 'phase.entered' || !isRecord(row.data)) continue;
    if (row.data.phase !== target) continue;
    latest = row.data;
  }
  if (latest === null) return null;
  const coordinate =
    latest.riskTier === undefined && latest.boundaryTouching === undefined
      ? null
      : resolveDangerCoordinate({ risk: latest.riskTier, boundary: latest.boundaryTouching });
  const gates = Array.isArray(latest.resolvedGates) ? readFrozenGateSequence(latest.resolvedGates) : null;
  if (coordinate === null && (gates === null || gates.length === 0)) return null;
  return {
    ...(coordinate === null ? {} : { coordinates: [coordinate] }),
    ...(gates !== null && gates.length > 0 ? { gates } : {}),
  };
}

/**
 * Returns the 1-based ordinal of the next `workflow.fix-cycle` row. A string group id counts only the rows
 * of that group. Another value counts each row.
 */
export function fixCycleOrdinalOf(rows: readonly PhaseStreamRow[], compoundStateId: unknown): number {
  const prior = rows.filter((row) => row.type === 'workflow.fix-cycle');
  if (typeof compoundStateId !== 'string') return prior.length + 1;
  return prior.filter((row) => isRecord(row.data) && row.data.compoundStateId === compoundStateId).length + 1;
}

/** Returns the 1-based ordinal of the next `workflow.plan-revision` row. One count covers the workflow. */
export function planRevisionOrdinalOf(rows: readonly PhaseStreamRow[]): number {
  return rows.filter((row) => row.type === 'workflow.plan-revision').length + 1;
}
