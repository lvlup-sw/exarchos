// The HSM registry and the pure transition algorithm. `executeTransition` computes the result
// of a transition and does no I/O. The caller persists the state and appends the events.
//
// On an advance into an atomic state, the algorithm resolves the gate-set of the target kind.
// Then it freezes the result on one `phase.entered` event, with the danger coordinate, the posture
// and, for PLAN, the `designDepth`. A replay of the log gives the same obligation as the live run,
// and a later policy edit cannot change it. A resolver fault refuses the transition with `PHASE_BLOCKED`.

import type { Guard, GuardResult } from './guards.js';
import { guards } from './guards.js';
import { PHASE_EVENT_CONTRACTS, assertContractPhasesAreRegistered } from './topology/phase-events.js';
import { resolveGateSetFailClosed, KIND_OBLIGATIONS } from './phase-kind.js';
import type {
  PhaseKind,
  PhaseObligationOutcome,
  ResolvedGate,
  ResolveGateSetCtx,
} from './phase-kind.js';
import {
  dangerBoundaryTouching,
  joinDangerCoordinates,
  resolveDangerCoordinate,
  type DangerCoordinate,
} from './admission/requirement-context.js';
import type { DesignDepth } from './plan-depth-policy.js';
import {
  createFeatureHSM,
  createDebugHSM,
  createRefactorHSM,
  createOneshotHSM,
  createDiscoveryHSM,
} from './hsm-definitions.js';

export type { Guard, GuardResult };

export type Effect = 'checkpoint' | 'log' | 'increment-fix-cycle';

/**
 * The fields that every state variant shares, so a read of `.initial`, `.maxFixCycles` or `.parent` needs no narrowing.
 * Only the `atomic` variant of `State` carries `kind`, so an atomic state without `kind` is a compile error.
 */
interface StateBase {
  readonly id: string;
  readonly parent?: string;
  readonly initial?: string;
  readonly onEntry?: readonly Effect[];
  readonly onExit?: readonly Effect[];
  readonly maxFixCycles?: number;
}

export type State =
  | (StateBase & { readonly type: 'atomic'; readonly kind: PhaseKind })
  | (StateBase & { readonly type: 'compound' })
  | (StateBase & { readonly type: 'final' });

export interface Transition {
  readonly from: string;
  readonly to: string;
  readonly guard?: Guard | undefined;
  readonly effects?: readonly Effect[] | undefined;
  readonly isFixCycle?: boolean | undefined;
  /**
   * Marks a revise edge. The executor emits a counted `plan-revision` event for it, except on the standard feature `plan-review → plan` edge.
   * The count is an event and not an `Effect`, so it comes from the log and is stable on replay.
   * The projection folds it into `state.planReview.revisionCount`, which the `revisionsExhausted` guard reads.
   */
  readonly isRevision?: boolean;
}

export interface HSMDefinition {
  readonly id: string;
  readonly states: Record<string, State>;
  readonly transitions: readonly Transition[];
}

export interface TransitionEvent {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly metadata?: Record<string, unknown>;
}

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

export interface SerializedTopology {
  workflowType: string;
  initialPhase: string;
  states: Record<string, {
    id: string;
    type: 'atomic' | 'compound' | 'final';
    parent?: string;
    initial?: string;
    maxFixCycles?: number;
    onEntry?: readonly string[];
    onExit?: readonly string[];
  }>;
  transitions: Array<{
    from: string;
    to: string;
    guard?: { id: string; description: string };
    isFixCycle?: boolean;
    isRevision?: boolean;
    effects?: readonly string[];
  }>;
  tracks: Record<string, string[]>;
}

export interface WorkflowTypeSummary {
  workflowTypes: Array<{
    name: string;
    initialPhase: string;
    phaseCount: number;
    trackCount: number;
  }>;
}

const BUILT_IN_TYPES = new Set(['feature', 'debug', 'refactor', 'oneshot', 'discovery']);

/**
 * The HSM registry: the built-in types, and the custom types that `registerWorkflowType` adds.
 * At load, each phase in the phase event contract must be a state of a built-in HSM.
 */
const hsmRegistry: Record<string, HSMDefinition> = {
  feature: createFeatureHSM(),
  debug: createDebugHSM(),
  refactor: createRefactorHSM(),
  oneshot: createOneshotHSM(),
  discovery: createDiscoveryHSM(),
};

assertContractPhasesAreRegistered(
  PHASE_EVENT_CONTRACTS,
  new Set(Object.values(hsmRegistry).flatMap((hsm) => Object.keys(hsm.states))),
);

const initialPhaseRegistry: Record<string, string> = {
  /** Feature workflows start in `plan`, the unified design and plan phase. */
  feature: 'plan',
  debug: 'triage',
  refactor: 'explore',
  oneshot: 'plan',
  discovery: 'gathering',
};

export function isBuiltInWorkflowType(workflowType: string): boolean {
  return BUILT_IN_TYPES.has(workflowType);
}

export function getHSMDefinition(workflowType: string): HSMDefinition {
  const hsm = hsmRegistry[workflowType];
  if (!hsm) {
    throw new Error(`Unknown workflow type: ${workflowType}`);
  }
  return hsm;
}

export function getInitialPhase(workflowType: string): string {
  const phase = initialPhaseRegistry[workflowType];
  if (!phase) {
    throw new Error(`Unknown workflow type: ${workflowType}`);
  }
  return phase;
}

/**
 * Derive tracks from compound states: for each compound state, collect
 * its children (states where parent === compoundState.id).
 */
function deriveTracks(hsm: HSMDefinition): Record<string, string[]> {
  const tracks: Record<string, string[]> = {};
  for (const state of Object.values(hsm.states)) {
    if (state.type === 'compound') {
      tracks[state.id] = [];
    }
  }
  for (const state of Object.values(hsm.states)) {
    const parentTrack = state.parent ? tracks[state.parent] : undefined;
    if (parentTrack !== undefined) {
      parentTrack.push(state.id);
    }
  }
  return tracks;
}

/**
 * Serialize an HSM definition into a plain JSON-serializable object.
 * Strips evaluate functions from guards, derives tracks from compound states.
 */
export function serializeTopology(workflowType: string): SerializedTopology {
  const hsm = getHSMDefinition(workflowType);
  const initialPhase = getInitialPhase(workflowType);

  const states: SerializedTopology['states'] = {};
  for (const [id, state] of Object.entries(hsm.states)) {
    const entry: SerializedTopology['states'][string] = {
      id: state.id,
      type: state.type,
    };
    if (state.parent !== undefined) entry.parent = state.parent;
    if (state.initial !== undefined) entry.initial = state.initial;
    if (state.maxFixCycles !== undefined) entry.maxFixCycles = state.maxFixCycles;
    if (state.onEntry !== undefined) entry.onEntry = state.onEntry;
    if (state.onExit !== undefined) entry.onExit = state.onExit;
    states[id] = entry;
  }

  const transitions: SerializedTopology['transitions'] = hsm.transitions.map((t) => {
    const entry: SerializedTopology['transitions'][number] = {
      from: t.from,
      to: t.to,
    };
    if (t.guard) {
      entry.guard = { id: t.guard.id, description: t.guard.description };
    }
    if (t.isFixCycle !== undefined) entry.isFixCycle = t.isFixCycle;
    if (t.isRevision !== undefined) entry.isRevision = t.isRevision;
    if (t.effects !== undefined) entry.effects = t.effects;
    return entry;
  });

  const tracks = deriveTracks(hsm);

  return {
    workflowType,
    initialPhase,
    states,
    transitions,
    tracks,
  };
}

/**
 * List all registered workflow types with summary information.
 */
export function listWorkflowTypes(): WorkflowTypeSummary {
  const workflowTypes: WorkflowTypeSummary['workflowTypes'] = [];

  for (const name of Object.keys(hsmRegistry)) {
    const hsm = hsmRegistry[name];
    if (hsm === undefined) continue;
    const initialPhase = initialPhaseRegistry[name] ?? '';
    const phaseCount = Object.keys(hsm.states).length;
    const tracks = deriveTracks(hsm);
    const trackCount = Object.keys(tracks).length;

    workflowTypes.push({
      name,
      initialPhase,
      phaseCount,
      trackCount,
    });
  }

  return { workflowTypes };
}

import type { WorkflowDefinition, GuardDefinition } from '../config/define.js';

export type { WorkflowDefinition };

/**
 * Creates a pass-through Guard from a config guard definition. The HSM `evaluate` is synchronous, but a custom guard runs an external command.
 * Thus `hsm-transition-guard.ts` runs `executeGuard` from `config/guards.ts` before the transition, and blocks it when the guard fails.
 * Built-in guards in `workflow/guards.ts` evaluate inline and synchronously. Only custom guards need `executeGuard`.
 */
function createGuardFromDefinition(guardId: string, guardDef: GuardDefinition): Guard {
  return {
    id: guardId,
    custom: true,
    description: guardDef.description ?? `Custom guard: ${guardId}`,
    evaluate: (_state: Record<string, unknown>) => {
      return true;
    },
  };
}

/**
 * Converts a config workflow definition to an HSM. An `extends` definition starts from copies of the parent states and transitions.
 * A new custom phase becomes an atomic state of kind GATHER, which has no gates and a read-only posture.
 * The HSM gets `cancelled` and `completed` final states when they are absent. A custom transition replaces a base transition with the same `from` and `to`.
 */
function convertToHSM(name: string, definition: WorkflowDefinition): HSMDefinition {
  let baseStates: Record<string, State> = {};
  let baseTransitions: readonly Transition[] = [];

  const guardLookup = new Map<string, Guard>();
  if (definition.guards) {
    for (const [guardId, guardDef] of Object.entries(definition.guards)) {
      guardLookup.set(guardId, createGuardFromDefinition(guardId, guardDef));
    }
  }

  if (definition.extends) {
    const parent = hsmRegistry[definition.extends];
    if (!parent) {
      throw new Error(`Cannot extend unknown workflow type: ${definition.extends}`);
    }
    baseStates = Object.fromEntries(
      Object.entries(parent.states).map(([k, v]) => [k, { ...v }]),
    );
    baseTransitions = [...parent.transitions];
  }

  for (const phase of definition.phases) {
    if (!baseStates[phase]) {
      baseStates[phase] = { id: phase, type: 'atomic', kind: 'GATHER' };
    }
  }

  if (!baseStates['cancelled']) {
    baseStates['cancelled'] = { id: 'cancelled', type: 'final' };
  }
  if (!baseStates['completed']) {
    baseStates['completed'] = { id: 'completed', type: 'final' };
  }

  const customTransitions: Transition[] = definition.transitions.map((t) => {
    const base: { from: string; to: string; guard?: Guard } = { from: t.from, to: t.to };
    if (t.guard) {
      const resolved = guardLookup.get(t.guard);
      if (!resolved) {
        throw new Error(`Transition ${t.from} → ${t.to} references unknown guard '${t.guard}'. Define it in guards.`);
      }
      base.guard = resolved;
    }
    return base;
  });

  const transitionKey = (t: Transition): string => `${t.from}->${t.to}`;
  const mergedMap = new Map<string, Transition>();
  for (const t of baseTransitions) {
    mergedMap.set(transitionKey(t), t);
  }
  for (const t of customTransitions) {
    mergedMap.set(transitionKey(t), t);
  }

  return {
    id: name,
    states: baseStates,
    transitions: [...mergedMap.values()],
  };
}

export function registerWorkflowType(name: string, definition: WorkflowDefinition): void {
  if (BUILT_IN_TYPES.has(name)) {
    throw new Error(`Cannot override built-in workflow type: ${name}`);
  }
  const hsm = convertToHSM(name, definition);
  hsmRegistry[name] = hsm;
  initialPhaseRegistry[name] = definition.initialPhase;
}

/**
 * Remove a custom workflow type from the registry.
 * Only non-built-in types can be removed. Used for test cleanup.
 */
export function unregisterWorkflowType(name: string): void {
  if (BUILT_IN_TYPES.has(name)) {
    throw new Error(`Cannot unregister built-in workflow type: ${name}`);
  }
  delete hsmRegistry[name];
  delete initialPhaseRegistry[name];
}

/**
 * Find the parent compound state for a given state, if any.
 */
function getParentCompound(
  hsm: HSMDefinition,
  stateId: string
): State | undefined {
  const state = hsm.states[stateId];
  if (!state?.parent) return undefined;
  return hsm.states[state.parent];
}

/**
 * Get the chain of compound parents from innermost to outermost.
 */
function getCompoundAncestors(
  hsm: HSMDefinition,
  stateId: string
): readonly State[] {
  const ancestors: State[] = [];
  let current = hsm.states[stateId];
  while (current?.parent) {
    const parent = hsm.states[current.parent];
    if (parent) ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

/**
 * Count fix-cycle events for a given compound state.
 */
function countFixCycles(
  events: readonly Record<string, unknown>[],
  compoundId: string
): number {
  return events.filter((e) => {
    if (e.type !== 'fix-cycle') return false;
    const metadata = e.metadata as Record<string, unknown> | undefined;
    return metadata?.compoundStateId === compoundId;
  }).length;
}

/**
 * Counts `plan-revision` events in the log. The count is global and not scoped to a compound, because `revisionsExhausted` reads one workflow-level count.
 * The projection folds the same events into `state.planReview.revisionCount`.
 * It accepts the HSM shape (`plan-revision`) and the persisted shape (`workflow.plan-revision`), so it works on `result.events` and on a rehydrated log.
 */
export function countPlanRevisions(
  events: readonly Record<string, unknown>[]
): number {
  return events.filter(
    (e) => e.type === 'plan-revision' || e.type === 'workflow.plan-revision'
  ).length;
}

/**
 * Get all valid target phases for transitions from a given phase,
 * including the universal cancel and cleanup transitions.
 * Returns guard metadata for each target so agents can see prerequisites.
 */
export function getValidTransitions(
  hsm: HSMDefinition,
  fromPhase: string
): readonly ValidTransitionTarget[] {
  const state = hsm.states[fromPhase];
  if (!state || state.type === 'final') return [];

  const seen = new Set<string>();
  const targets: ValidTransitionTarget[] = [];

  for (const t of hsm.transitions) {
    if (t.from !== fromPhase || seen.has(t.to)) continue;
    seen.add(t.to);
    targets.push(
      t.guard
        ? { phase: t.to, guard: { id: t.guard.id, description: t.guard.description } }
        : { phase: t.to },
    );
  }

  if (!seen.has('cancelled') && hsm.states['cancelled']) {
    targets.push({ phase: 'cancelled', universal: true });
  }

  if (!seen.has('completed') && hsm.states['completed']) {
    targets.push({ phase: 'completed', guard: { id: guards.mergeVerified.id, description: guards.mergeVerified.description }, universal: true });
  }

  return targets;
}

/**
 * Find a transition in the HSM from one phase to another.
 * Returns undefined if no matching transition exists.
 */
export function findTransition(
  hsm: HSMDefinition,
  fromPhase: string,
  toPhase: string,
): Transition | undefined {
  return hsm.transitions.find(
    (t) => t.from === fromPhase && t.to === toPhase,
  );
}

/**
 * Computes a transition and does no I/O. A guard failure, an open circuit and a blocked phase return diagnostic events, and the caller must append them.
 * When the mergeVerified guard of the universal cleanup fails, the normal lookup runs, so an edge such as `synthesize → completed` still works.
 *
 * A fix-cycle edge records `phase.exited` with `allRequiredGatesPassed: false`. The `phase.exited` event comes before `phase.entered`.
 * A top-level phase has no parent, so `fix-cycle` and `plan-revision` omit `compoundStateId` and never set it to `undefined`.
 * The standard feature `plan-review → plan` edge emits no `plan-revision`, because `prepare_review` counts that loop.
 *
 * The gate union keeps the resolution order, because gate order is evaluation order. IMPLEMENT records no phase-level gate sequence, because the wave stamp holds its per-task sequences.
 * `policySource` and `mode` are fixed defaults. The orchestrate layer resolves the IMPLEMENT mode, so this module does not depend on that layer.
 * @param resolveGatesFn the gate-set resolver. A test injects it to reach the fail-closed branch.
 * @param floor the coordinates and the prior frozen gates that the resolution must also cover.
 */
export function executeTransition(
  hsm: HSMDefinition,
  state: Record<string, unknown>,
  targetPhase: string,
  resolveGatesFn?: (kind: PhaseKind, ctx: ResolveGateSetCtx) => readonly ResolvedGate[],
  floor?: TransitionObligationFloor,
): TransitionResult {
  const currentPhase = state.phase as string;
  const phaseAttemptId =
    typeof state._pendingPhaseAttemptId === 'string'
      ? state._pendingPhaseAttemptId
      : undefined;
  const events = (state._events as readonly Record<string, unknown>[]) ?? [];
  const history = (state._history as Record<string, string>) ?? {};

  if (currentPhase === targetPhase) {
    return {
      success: true,
      idempotent: true,
      newPhase: currentPhase,
      effects: [],
      events: [],
    };
  }

  const isCancel =
    targetPhase === 'cancelled' && hsm.states['cancelled']?.type === 'final';
  const currentState = hsm.states[currentPhase];

  if (currentState?.type === 'final') {
    return {
      success: false,
      idempotent: false,
      effects: [],
      events: [],
      errorCode: 'INVALID_TRANSITION',
      errorMessage: `Cannot transition from final state: ${currentPhase}`,
      validTargets: [],
    };
  }

  if (isCancel) {
    const exitEffects: Effect[] = [];
    const historyUpdates: Record<string, string> = {};

    const currentAncestors = getCompoundAncestors(hsm, currentPhase);
    if (currentState?.onExit) {
      exitEffects.push(...currentState.onExit);
    }
    for (const ancestor of currentAncestors) {
      if (ancestor.onExit) exitEffects.push(...ancestor.onExit);
      historyUpdates[ancestor.id] = currentPhase;
    }

    const parent = getParentCompound(hsm, currentPhase);
    if (parent) {
      historyUpdates[parent.id] = currentPhase;
    }

    return {
      success: true,
      idempotent: false,
      newPhase: 'cancelled',
      effects: exitEffects,
      events: [
        {
          type: 'cancel',
          from: currentPhase,
          to: 'cancelled',
          trigger: 'user-cancel',
          ...(phaseAttemptId ? { metadata: { phaseAttemptId } } : {}),
        },
      ],
      historyUpdates:
        Object.keys(historyUpdates).length > 0 ? historyUpdates : undefined,
    };
  }

  const isCleanup = targetPhase === 'completed' && hsm.states['completed']?.type === 'final';

  if (isCleanup) {
    const guardResult = guards.mergeVerified.evaluate(state);
    const guardPassed = typeof guardResult === 'boolean' ? guardResult : false;

    if (guardPassed) {
      const exitEffects: Effect[] = [];
      const historyUpdates: Record<string, string> = {};

      const currentAncestors = getCompoundAncestors(hsm, currentPhase);
      if (currentState?.onExit) {
        exitEffects.push(...currentState.onExit);
      }
      for (const ancestor of currentAncestors) {
        if (ancestor.onExit) exitEffects.push(...ancestor.onExit);
        historyUpdates[ancestor.id] = currentPhase;
      }

      const parent = getParentCompound(hsm, currentPhase);
      if (parent) {
        historyUpdates[parent.id] = currentPhase;
      }

      return {
        success: true,
        idempotent: false,
        newPhase: 'completed',
        effects: exitEffects,
        events: [
          {
            type: 'cleanup',
            from: currentPhase,
            to: 'completed',
            trigger: 'cleanup',
            ...(phaseAttemptId ? { metadata: { phaseAttemptId } } : {}),
          },
        ],
        historyUpdates:
          Object.keys(historyUpdates).length > 0 ? historyUpdates : undefined,
      };
    }
  }

  const transition = findTransition(hsm, currentPhase, targetPhase);

  if (!transition) {
    const validTargets = getValidTransitions(hsm, currentPhase);
    return {
      success: false,
      idempotent: false,
      effects: [],
      events: [],
      errorCode: 'INVALID_TRANSITION',
      errorMessage: `No transition from '${currentPhase}' to '${targetPhase}'`,
      validTargets,
    };
  }

  if (transition.guard) {
    let rawResult: GuardResult;
    try {
      rawResult = transition.guard.evaluate(state);
    } catch (err) {
      return {
        success: false,
        idempotent: false,
        effects: [],
        events: [{
          type: 'guard-failed',
          from: currentPhase,
          to: targetPhase,
          trigger: 'execute-transition',
          metadata: { guard: transition.guard.id },
        }],
        errorCode: 'GUARD_FAILED',
        errorMessage: `Guard '${transition.guard.id}' threw: ${(err as Error).message}`,
        guardDescription: transition.guard.description,
      };
    }
    const guardPassed = typeof rawResult === 'boolean' ? rawResult : rawResult.passed;
    const guardReason =
      typeof rawResult === 'object' && 'reason' in rawResult ? rawResult.reason : undefined;
    const guardExpectedShape =
      typeof rawResult === 'object' && 'expectedShape' in rawResult
        ? (rawResult as unknown as Record<string, unknown>).expectedShape as Record<string, unknown> | undefined
        : undefined;
    const guardSuggestedFix =
      typeof rawResult === 'object' && 'suggestedFix' in rawResult
        ? (rawResult as unknown as Record<string, unknown>).suggestedFix as { tool: string; params: Record<string, unknown> } | undefined
        : undefined;
    if (!guardPassed) {
      return {
        success: false,
        idempotent: false,
        effects: [],
        events: [{
          type: 'guard-failed',
          from: currentPhase,
          to: targetPhase,
          trigger: 'execute-transition',
          metadata: { guard: transition.guard.id },
        }],
        errorCode: 'GUARD_FAILED',
        errorMessage: guardReason
          ? `Guard '${transition.guard.id}' failed: ${guardReason}`
          : `Guard '${transition.guard.id}' failed: ${transition.guard.description}`,
        guardDescription: transition.guard.description,
        ...(guardExpectedShape ? { guardExpectedShape } : {}),
        ...(guardSuggestedFix ? { guardSuggestedFix } : {}),
      };
    }
  }

  if (transition.isFixCycle) {
    const parent = getParentCompound(hsm, currentPhase);
    if (parent?.maxFixCycles != null) {
      const fixCount = countFixCycles(events, parent.id);
      if (fixCount >= parent.maxFixCycles) {
        return {
          success: false,
          idempotent: false,
          effects: [],
          events: [{
            type: 'circuit-open',
            from: currentPhase,
            to: targetPhase,
            trigger: 'execute-transition',
            metadata: {
              compoundStateId: parent.id,
              compoundId: parent.id,
              fixCycleCount: fixCount,
              maxFixCycles: parent.maxFixCycles,
            },
          }],
          errorCode: 'CIRCUIT_OPEN',
          errorMessage: `Fix cycle limit (${parent.maxFixCycles}) reached for compound '${parent.id}'`,
        };
      }
    }
  }

  const effects: Effect[] = [];
  const historyUpdates: Record<string, string> = {};

  if (currentState?.onExit) {
    effects.push(...currentState.onExit);
  }

  const currentAncestors = getCompoundAncestors(hsm, currentPhase);
  const targetAncestors = getCompoundAncestors(hsm, targetPhase);
  const targetAncestorIds = new Set(targetAncestors.map((a) => a.id));

  for (const ancestor of currentAncestors) {
    if (!targetAncestorIds.has(ancestor.id)) {
      if (ancestor.onExit) effects.push(...ancestor.onExit);
    }
  }

  const newPhase = targetPhase;

  const currentAncestorIds = new Set(currentAncestors.map((a) => a.id));

  const targetAncestorsReversed = [...targetAncestors].reverse();
  for (const ancestor of targetAncestorsReversed) {
    if (!currentAncestorIds.has(ancestor.id)) {
      if (ancestor.onEntry) effects.push(...ancestor.onEntry);
    }
  }

  const targetState = hsm.states[targetPhase];
  if (targetState?.onEntry) {
    effects.push(...targetState.onEntry);
  }

  if (transition.effects) {
    effects.push(...transition.effects);
  }

  for (const ancestor of currentAncestors) {
    if (!targetAncestorIds.has(ancestor.id)) {
      historyUpdates[ancestor.id] = currentPhase;
    }
  }

  const transitionEvents: TransitionEvent[] = [
    {
      type: 'transition',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
      ...(phaseAttemptId ? { metadata: { phaseAttemptId } } : {}),
    },
  ];

  for (const ancestor of targetAncestorsReversed) {
    if (!currentAncestorIds.has(ancestor.id)) {
      transitionEvents.push({
        type: 'compound-entry',
        from: currentPhase,
        to: ancestor.id,
        trigger: 'execute-transition',
        metadata: { compoundStateId: ancestor.id },
      });
    }
  }

  for (const ancestor of currentAncestors) {
    if (!targetAncestorIds.has(ancestor.id)) {
      transitionEvents.push({
        type: 'compound-exit',
        from: ancestor.id,
        to: targetPhase,
        trigger: 'execute-transition',
      });
    }
  }

  if (transition.isFixCycle) {
    const parent = getParentCompound(hsm, currentPhase);
    transitionEvents.push({
      type: 'fix-cycle',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
      metadata: { ...(parent ? { compoundStateId: parent.id } : {}) },
    });
  }

  const isStandardPlanReviseEdge =
    hsm.id === 'feature' && currentPhase === 'plan-review' && targetPhase === 'plan';
  if (transition.isRevision && !isStandardPlanReviseEdge) {
    const parent = getParentCompound(hsm, currentPhase);
    transitionEvents.push({
      type: 'plan-revision',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
      metadata: { ...(parent ? { compoundStateId: parent.id } : {}) },
    });
  }

  transitionEvents.push({
    type: 'phase.exited',
    from: currentPhase,
    to: targetPhase,
    trigger: 'execute-transition',
    metadata: {
      phase: currentPhase,
      allRequiredGatesPassed: !transition.isFixCycle,
    },
  });

  let resolvedGates: readonly ResolvedGate[] | undefined;
  if (targetState?.type === 'atomic' && targetState.kind) {
    const resolvedDesignDepth: DesignDepth =
      (state.designDepth as DesignDepth | undefined) ?? 'standard';
    const stateCoordinate = resolveDangerCoordinate({
      risk: state.riskTier,
      boundary: state.boundaryTouching,
    });
    const resolutionCoordinates: readonly DangerCoordinate[] = [
      stateCoordinate,
      ...(floor?.coordinates ?? []),
    ];
    const unioned: ResolvedGate[] = [];
    const seenGateKeys = new Set<string>();
    let frozenCoordinate: DangerCoordinate = stateCoordinate;
    for (const gate of floor?.gates ?? []) {
      const key = `${gate.family}\u0000${gate.gate}`;
      if (seenGateKeys.has(key)) continue;
      seenGateKeys.add(key);
      unioned.push(gate);
    }
    for (const coordinate of resolutionCoordinates) {
      const resolved = resolveGateSetFailClosed(
        targetState.kind,
        {
          riskTier: coordinate.risk,
          boundaryTouching: dangerBoundaryTouching(coordinate),
          workflowType: hsm.id,
          designDepth: resolvedDesignDepth,
        },
        resolveGatesFn,
      );
      if (!resolved.ok) {
        return {
          success: false,
          idempotent: false,
          effects: [],
          events: [
            {
              type: 'phase.blocked',
              from: currentPhase,
              to: targetPhase,
              trigger: 'execute-transition',
              metadata: { kind: targetState.kind, reason: resolved.reason },
            },
          ],
          errorCode: 'PHASE_BLOCKED',
          errorMessage: `Gate-set resolution failed for ${targetState.kind} phase '${targetPhase}': ${resolved.reason}`,
        };
      }
      for (const gate of resolved.gates) {
        const key = `${gate.family}\u0000${gate.gate}`;
        if (seenGateKeys.has(key)) continue;
        seenGateKeys.add(key);
        unioned.push(gate);
      }
      frozenCoordinate = joinDangerCoordinates(frozenCoordinate, coordinate);
    }
    const obligation: PhaseObligationOutcome = { ok: true, gates: unioned };
    resolvedGates = targetState.kind === 'IMPLEMENT' ? [] : obligation.gates;

    transitionEvents.push({
      type: 'phase.entered',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
      metadata: {
        phase: targetPhase,
        kind: targetState.kind,
        resolver: KIND_OBLIGATIONS[targetState.kind].gates?.resolver ?? null,
        resolvedGates: resolvedGates.map((g) => ({ family: g.family, gate: g.gate })),
        riskTier: frozenCoordinate.risk,
        boundaryTouching: dangerBoundaryTouching(frozenCoordinate),
        posture: KIND_OBLIGATIONS[targetState.kind].posture,
        policySource: 'builtin',
        mode: 'enforce',
        ...(targetState.kind === 'PLAN' ? { designDepth: resolvedDesignDepth } : {}),
      },
    });
  }

  return {
    success: true,
    idempotent: false,
    newPhase,
    effects,
    events: transitionEvents,
    historyUpdates:
      Object.keys(historyUpdates).length > 0 ? historyUpdates : undefined,
    ...(resolvedGates ? { resolvedGates } : {}),
  };
}
