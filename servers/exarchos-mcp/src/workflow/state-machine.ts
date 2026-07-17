import type { Guard, GuardResult } from './guards.js';
import { guards } from './guards.js';
import { resolveGateSetFailClosed, KIND_OBLIGATIONS } from './phase-kind.js';
import type { PhaseKind, ResolvedGate, ResolveGateSetCtx } from './phase-kind.js';
import type { RiskTier } from './verification-policy.js';
import type { DesignDepth } from './plan-depth-policy.js';
import {
  createFeatureHSM,
  createDebugHSM,
  createRefactorHSM,
  createOneshotHSM,
  createDiscoveryHSM,
} from './hsm-definitions.js';

// Re-export guard types for consumers
export type { Guard, GuardResult };

// ─── HSM Types ──────────────────────────────────────────────────────────────

export type Effect = 'checkpoint' | 'log' | 'increment-fix-cycle';

// All shared/optional fields live on the base so existing `.initial` /
// `.maxFixCycles` / `.parent` reads keep compiling without narrowing. Only the
// `atomic` variant carries `kind` — an atomic state literal without `kind` is a
// COMPILE error (DR-2), while compound/final states are exempt (they have no
// kind in the obligation layer). See docs/designs/archive/2026-06-16-phase-kind-binding.md.
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
   * Marks a plan-review revise loop edge (DR-1). When traversed, the executor
   * emits one counted `plan-revision` event — the exact analog of `isFixCycle`
   * → `fix-cycle`. The `plan-review → plan` transition carries this so the
   * revise loop can be bounded (the projection folds the count into
   * `state.planReview.revisionCount`, the location the `revisionsExhausted`
   * guard reads). An `Effect` is deliberately NOT the mechanism — a counted
   * cycle must be an event so the count is event-derived and replay-stable.
   */
  readonly isRevision?: boolean;
}

export interface HSMDefinition {
  readonly id: string;
  readonly states: Record<string, State>;
  readonly transitions: readonly Transition[];
}

// ─── Transition Result ──────────────────────────────────────────────────────

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
   * The gate-set resolved for the target phase's kind at the transition
   * boundary (DR-10). Present on a successful transition into an atomic state;
   * absent for compound/final targets (cancel, cleanup) which carry no kind.
   * In S3 this is the structural PDP output; S4 freezes it as a `phase.entered`
   * event.
   */
  readonly resolvedGates?: readonly ResolvedGate[];
}

// ─── Serialization Types ────────────────────────────────────────────────────

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

// ─── HSM Registry ───────────────────────────────────────────────────────────

const BUILT_IN_TYPES = new Set(['feature', 'debug', 'refactor', 'oneshot', 'discovery']);

const hsmRegistry: Record<string, HSMDefinition> = {
  feature: createFeatureHSM(),
  debug: createDebugHSM(),
  refactor: createRefactorHSM(),
  oneshot: createOneshotHSM(),
  discovery: createDiscoveryHSM(),
};

const initialPhaseRegistry: Record<string, string> = {
  // DR-4 (#1581): GATHER (`ideate`) collapsed into PLAN — feature workflows now
  // start in `plan` (the unified design+plan phase). See createFeatureHSM.
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

// ─── Topology Serialization ─────────────────────────────────────────────────

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

// ─── Workflow Definition → HSM Conversion ────────────────────────────────────

import type { WorkflowDefinition, GuardDefinition } from '../config/define.js';

// Re-export for consumers that imported from here
export type { WorkflowDefinition };

/**
 * Create a Guard object from a config guard definition.
 * The guard shells out to the command and treats exit code 0 as pass.
 */
function createGuardFromDefinition(guardId: string, guardDef: GuardDefinition): Guard {
  return {
    id: guardId,
    custom: true,
    description: guardDef.description ?? `Custom guard: ${guardId}`,
    evaluate: (_state: Record<string, unknown>) => {
      // DESIGN: Custom config guards use a two-layer execution model:
      // 1. HSM layer (here): pass-through — returns true to allow the transition
      // 2. Orchestrator layer: calls executeGuard() from config/guards.ts
      //    before attempting the HSM transition, blocking if the guard fails.
      //
      // This split exists because HSM evaluate() is synchronous but custom
      // guards shell out to external commands (async). The orchestrator
      // checks getRegisteredGuard() and runs executeGuard() pre-transition.
      // Built-in guards (workflow/guards.ts) remain inline/synchronous.
      return true;
    },
  };
}

function convertToHSM(name: string, definition: WorkflowDefinition): HSMDefinition {
  let baseStates: Record<string, State> = {};
  let baseTransitions: readonly Transition[] = [];

  // Build guard lookup from definition
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
    // Deep clone the parent
    baseStates = Object.fromEntries(
      Object.entries(parent.states).map(([k, v]) => [k, { ...v }]),
    );
    baseTransitions = [...parent.transitions];
  }

  // Add custom phases as atomic states. A user-defined phase carries no
  // inherent kind, so it defaults to GATHER — the only kind whose obligation
  // row has `gates: null`, i.e. no kind-driven verification gates. This is
  // behavior-neutral: custom phases never had kind-driven gates before DR-2.
  for (const phase of definition.phases) {
    if (!baseStates[phase]) {
      baseStates[phase] = { id: phase, type: 'atomic', kind: 'GATHER' };
    }
  }

  // Ensure cancelled/completed final states exist
  if (!baseStates['cancelled']) {
    baseStates['cancelled'] = { id: 'cancelled', type: 'final' };
  }
  if (!baseStates['completed']) {
    baseStates['completed'] = { id: 'completed', type: 'final' };
  }

  // Convert transitions, resolving string guard IDs to Guard objects
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

  // Merge: custom transitions override base transitions with same from+to
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

// ─── Transition Algorithm (10 Steps) ────────────────────────────────────────

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
 * Count `plan-revision` events in the log (DR-1) — the revise-cycle analog of
 * `countFixCycles`. Unlike fix cycles (bounded per-compound by the circuit
 * breaker), plan-review revisions are bounded by a single workflow-level count
 * that `revisionsExhausted` reads from `state.planReview.revisionCount`, so the
 * count is global (not scoped to a compound). The projection folds these same
 * events into that nested field; this function derives the identical count
 * directly from the event log, so the bound is event-sourced and replay-stable.
 *
 * Accepts both the internal HSM-emitted shape (`type: 'plan-revision'`) and the
 * persisted external shape (`type: 'workflow.plan-revision'`) so a caller can
 * derive the count from either an in-flight `result.events` list or a rehydrated
 * event log.
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

  // Add universal cancel if not already present
  if (!seen.has('cancelled') && hsm.states['cancelled']) {
    targets.push({ phase: 'cancelled', universal: true });
  }

  // Add universal cleanup (completed) if not already present
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
 * Execute a transition in the HSM. This is a PURE function that computes
 * what should happen but does not perform I/O. The caller handles persistence.
 *
 * Returns diagnostic events in `result.events` even on failure (guard-failed,
 * circuit-open). The caller is responsible for emitting these to the event store
 * before returning the error to the client.
 */
export function executeTransition(
  hsm: HSMDefinition,
  state: Record<string, unknown>,
  targetPhase: string,
  // The phase-kind gate-set resolver (DR-10). Defaults to the real resolver;
  // injectable so the fail-closed branch is directly testable. The resolve runs
  // non-optionally at this single boundary — no phase can opt out of the PDP.
  resolveGatesFn?: (kind: PhaseKind, ctx: ResolveGateSetCtx) => readonly ResolvedGate[],
): TransitionResult {
  const currentPhase = state.phase as string;
  const events = (state._events as readonly Record<string, unknown>[]) ?? [];
  const history = (state._history as Record<string, string>) ?? {};

  // ─── Step 1: Idempotency Check ──────────────────────────────────────
  if (currentPhase === targetPhase) {
    return {
      success: true,
      idempotent: true,
      newPhase: currentPhase,
      effects: [],
      events: [],
    };
  }

  // ─── Step 2: Lookup transition ──────────────────────────────────────
  const isCancel =
    targetPhase === 'cancelled' && hsm.states['cancelled']?.type === 'final';
  const currentState = hsm.states[currentPhase];

  // Cannot transition from a final state
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

  // Handle universal cancel transition
  if (isCancel) {
    const exitEffects: Effect[] = [];
    const historyUpdates: Record<string, string> = {};

    // Step 5: Exit actions for current state and parent compounds
    const currentAncestors = getCompoundAncestors(hsm, currentPhase);
    if (currentState?.onExit) {
      exitEffects.push(...currentState.onExit);
    }
    for (const ancestor of currentAncestors) {
      if (ancestor.onExit) exitEffects.push(...ancestor.onExit);
      historyUpdates[ancestor.id] = currentPhase;
    }

    // If current state is in a compound, record history
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
        },
      ],
      historyUpdates:
        Object.keys(historyUpdates).length > 0 ? historyUpdates : undefined,
    };
  }

  // Handle universal cleanup transition (mergeVerified → completed)
  const isCleanup = targetPhase === 'completed' && hsm.states['completed']?.type === 'final';

  if (isCleanup) {
    // Evaluate mergeVerified guard
    const guardResult = guards.mergeVerified.evaluate(state);
    const guardPassed = typeof guardResult === 'boolean' ? guardResult : false;

    if (guardPassed) {
      const exitEffects: Effect[] = [];
      const historyUpdates: Record<string, string> = {};

      // Exit actions for current state and parent compounds (same pattern as cancel)
      const currentAncestors = getCompoundAncestors(hsm, currentPhase);
      if (currentState?.onExit) {
        exitEffects.push(...currentState.onExit);
      }
      for (const ancestor of currentAncestors) {
        if (ancestor.onExit) exitEffects.push(...ancestor.onExit);
        historyUpdates[ancestor.id] = currentPhase;
      }

      // If current state is in a compound, record history
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
          },
        ],
        historyUpdates:
          Object.keys(historyUpdates).length > 0 ? historyUpdates : undefined,
      };
    }
    // If mergeVerified guard fails, fall through to normal transition lookup
    // This allows existing transitions like synthesize → completed (prUrlExists) to work
  }

  // Find matching transition
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

  // ─── Step 3: Guard Evaluation ───────────────────────────────────────
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

  // ─── Step 4: Circuit Breaker Check ──────────────────────────────────
  if (transition.isFixCycle) {
    // Find the compound state that contains the current state
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

  // ─── Step 5: Exit Actions ──────────────────────────────────────────
  const effects: Effect[] = [];
  const historyUpdates: Record<string, string> = {};

  // Collect exit effects for current state
  if (currentState?.onExit) {
    effects.push(...currentState.onExit);
  }

  // Determine which compounds we're leaving
  const currentAncestors = getCompoundAncestors(hsm, currentPhase);
  const targetAncestors = getCompoundAncestors(hsm, targetPhase);
  const targetAncestorIds = new Set(targetAncestors.map((a) => a.id));

  // Exit effects for compounds being left (not shared with target)
  for (const ancestor of currentAncestors) {
    if (!targetAncestorIds.has(ancestor.id)) {
      if (ancestor.onExit) effects.push(...ancestor.onExit);
    }
  }

  // ─── Step 6: State Update (caller handles persistence) ─────────────
  const newPhase = targetPhase;

  // ─── Step 7: Entry Actions ─────────────────────────────────────────
  const currentAncestorIds = new Set(currentAncestors.map((a) => a.id));

  // Entry effects for compounds being entered (not shared with current)
  // Process outermost to innermost
  const targetAncestorsReversed = [...targetAncestors].reverse();
  for (const ancestor of targetAncestorsReversed) {
    if (!currentAncestorIds.has(ancestor.id)) {
      if (ancestor.onEntry) effects.push(...ancestor.onEntry);
    }
  }

  // Collect entry effects for target state
  const targetState = hsm.states[targetPhase];
  if (targetState?.onEntry) {
    effects.push(...targetState.onEntry);
  }

  // Add transition-specific effects
  if (transition.effects) {
    effects.push(...transition.effects);
  }

  // ─── Step 8: History Update ────────────────────────────────────────
  // Record last sub-state when leaving a compound
  for (const ancestor of currentAncestors) {
    if (!targetAncestorIds.has(ancestor.id)) {
      historyUpdates[ancestor.id] = currentPhase;
    }
  }

  // ─── Step 9: Event Append ──────────────────────────────────────────
  const transitionEvents: TransitionEvent[] = [
    {
      type: 'transition',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
    },
  ];

  // Add compound-entry event if entering a compound
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

  // Add compound-exit event if leaving a compound
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

  // If fix cycle, add fix-cycle event
  if (transition.isFixCycle) {
    const parent = getParentCompound(hsm, currentPhase);
    transitionEvents.push({
      type: 'fix-cycle',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
      // A top-level (non-compound) child has no parent compound. Omit the key
      // entirely rather than emitting `compoundStateId: undefined`, which would
      // violate WorkflowFixCycleData's optional-string contract (#1339).
      metadata: { ...(parent ? { compoundStateId: parent.id } : {}) },
    });
  }

  // If a plan-review revise cycle, add a counted plan-revision event (DR-1).
  // The exact analog of the fix-cycle emission above: a counted *event* (not an
  // Effect) so the revise count is event-derived and survives replay. The
  // emission boundary (hsm-transition-guard) folds in the 1-based ordinal as
  // `count` and the projection folds occurrences into
  // `state.planReview.revisionCount`. `compoundStateId` follows the same
  // omit-when-absent rule as fix-cycle (#1339) — plan-review is a top-level
  // atomic phase today, but mirroring keeps the shape stable if it is ever
  // nested in a compound.
  //
  // WLM-6 (DR-2): the standard feature `plan-review → plan` revise edge is
  // RETIRED as a counter source here. That loop is now counted at its
  // unskippable `prepare_review scope:plan` provisioning seam
  // (orchestrate/prepare-review.ts → `workflow.plan-review-dispatched`), closing
  // the skippable-edge bypass — so this edge must NOT also emit, or the count
  // would double when the prescribed flow both re-provisions AND transitions.
  // The retirement is scoped to that ONE edge (`plan-review → plan`): the
  // overhaul track's `overhaul-plan-review → overhaul-plan` revise edge is a
  // HUMAN CHECKPOINT (playbooks.ts) that never dispatches through
  // `prepare_review`, so it KEEPS its edge counter (belt: the Sentry-regression
  // class stays closed on that track). Scoped by edge here — NOT by removing the
  // `isRevision` flag from the definition (hsm-definitions.ts) — so the flag
  // stays a truthful "this is a revise edge" marker and any other `isRevision`
  // edge (incl. the overhaul edge and the test mechanism HSMs) still emits.
  // Gated on `hsm.id === 'feature'` so the retirement binds ONLY the standard
  // feature HSM: a custom/test HSM that happens to name phases `plan-review`/
  // `plan` (and never routes through the `prepare_review` seam) keeps its edge
  // counter instead of silently losing its `plan-revision` cap feed.
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

  // ─── Resolve-then-freeze: phase.exited on advance (DR-13) ─────────
  // Exiting `currentPhase` to advance to `targetPhase`. `allRequiredGatesPassed`
  // is the aggregate gate status derived structurally from the HSM walk: a
  // forward advance means the phase's required gates passed; a fix-cycle
  // (backward loop) is precisely "required gates did NOT pass — revise". Pushed
  // BEFORE the phase.entered freeze so the log/projection observe exit-then-enter
  // ordering. Cancel/cleanup return earlier and never reach this advance path.
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

  // ─── Step 9.5: Phase-Kind Gate-Set Resolution (DR-10, the PDP) ─────
  // Resolve the target kind's gate-set NON-OPTIONALLY at this single boundary.
  // Only atomic targets carry a `kind`; compound/final targets (handled by the
  // earlier cancel/cleanup returns) do not. A resolver fault fails CLOSED — the
  // transition is refused with PHASE_BLOCKED, never proceeds silently.
  let resolvedGates: readonly ResolvedGate[] | undefined;
  // Every production atomic state carries a `kind` (type-enforced on `State`).
  // The `&& targetState.kind` guard only short-circuits degenerate fixtures /
  // loosely-typed custom states with no kind, which have no obligation to resolve.
  if (targetState?.type === 'atomic' && targetState.kind) {
    // ─── Resolve half of resolve-then-freeze for `designDepth` (DR-3) ───
    // The per-FEATURE planning depth, the depth-axis analog of per-task
    // `riskTier`. Read loosely from the workflow state (an author override is
    // patched there before PLAN entry; absent ⇒ the behavior-neutral
    // `'standard'`). Once the first PLAN `phase.entered` freezes it onto the
    // projected state, this read is sticky — re-entering PLAN re-resolves the
    // SAME frozen value, so it is never re-resolved to a different depth.
    const resolvedDesignDepth: DesignDepth =
      (state.designDepth as DesignDepth | undefined) ?? 'standard';
    const obligation = resolveGateSetFailClosed(
      targetState.kind,
      {
        riskTier: (state.riskTier as RiskTier | undefined) ?? 'low',
        boundaryTouching: Boolean(state.boundaryTouching),
        workflowType: hsm.id,
        designDepth: resolvedDesignDepth,
      },
      resolveGatesFn,
    );
    if (!obligation.ok) {
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
            metadata: { kind: targetState.kind, reason: obligation.reason },
          },
        ],
        errorCode: 'PHASE_BLOCKED',
        errorMessage: `Gate-set resolution failed for ${targetState.kind} phase '${targetPhase}': ${obligation.reason}`,
      };
    }
    // F3 (#1546): per-phase kinds record their FULL resolved sequence; IMPLEMENT
    // defers its per-task sequences to the wave stamp (the design's two documented
    // resolution granularities), so it records NO phase-level sequence. Emptied
    // HERE — at the single source — so the frozen `phase.entered` event AND the
    // transition-result return field stay consistent: never the low-risk,
    // ctx-defaulted ladder a replay/left-fold consumer could mistake for the
    // authoritative per-task gate-set. The obligation was still resolved above
    // (the fail-closed check already ran), so IMPLEMENT blocking semantics are
    // intact — only the recorded sequence is deferred.
    resolvedGates = targetState.kind === 'IMPLEMENT' ? [] : obligation.gates;

    // ─── Resolve-THEN-FREEZE (DR-13, DR-10 freeze half) ───────────────
    // Append exactly one `phase.entered` carrying the obligation just resolved.
    // `resolvedGates` is snapshotted to plain `{family, gate}` value copies, so a
    // later policy-table edit cannot retroactively change this in-flight phase —
    // a left-fold of the log reconstructs the identical obligation a live HSM
    // observed (#1208-class single-trigger: `kind` is frozen here, never
    // re-derived downstream from the phase name).
    transitionEvents.push({
      type: 'phase.entered',
      from: currentPhase,
      to: targetPhase,
      trigger: 'execute-transition',
      metadata: {
        phase: targetPhase,
        kind: targetState.kind,
        resolver: KIND_OBLIGATIONS[targetState.kind].gates?.resolver ?? null,
        // Value-snapshot the frozen sequence — already emptied for IMPLEMENT at
        // the single source above (F3 #1546): the FULL sequence for per-phase
        // kinds, [] for IMPLEMENT (per-task sequences defer to the wave stamp).
        // resolver / posture / mode stay frozen for IMPLEMENT regardless.
        resolvedGates: resolvedGates.map((g) => ({ family: g.family, gate: g.gate })),
        // DR-14: freeze the kind's POLA posture (trust tier). The capability
        // bundle (capabilities/resolver.ts:mintCapabilitiesForKind) is derived
        // from this — a read-only kind's bundle can never hold fs:write.
        posture: KIND_OBLIGATIONS[targetState.kind].posture,
        // 'builtin'/'enforce' are the structural defaults frozen at this
        // foundational layer. Per-workflow IMPLEMENT graduation (oneshot→audit)
        // and config-overlay provenance are bound at the orchestrate gate layer
        // (Task 18 / DR-16), which owns `resolveImplementMode` — kept out of the
        // state machine to preserve the workflow→orchestrate dependency direction.
        policySource: 'builtin',
        mode: 'enforce',
        // ─── Freeze half: per-feature `designDepth` (DR-3) ──────────────
        // Carried ONLY on the PLAN phase's `phase.entered` (the single
        // per-feature freeze point — the analog of per-task `riskTier`'s wave
        // stamp). The projection folds this onto the view; the plan-structure
        // resolver reads the frozen value on every subsequent resolution. Other
        // kinds omit the field so the freeze has exactly one author.
        ...(targetState.kind === 'PLAN' ? { designDepth: resolvedDesignDepth } : {}),
      },
    });
  }

  // ─── Step 10: Return ───────────────────────────────────────────────
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
