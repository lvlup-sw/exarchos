import type { Guard, GuardResult } from './guards.js';
import { guards } from './guards.js';
import { createFeatureHSM, createDebugHSM, createRefactorHSM } from './hsm-definitions.js';

// Re-export guard types for consumers
export type { Guard, GuardResult };

// ─── HSM Types ──────────────────────────────────────────────────────────────

export type Effect = 'checkpoint' | 'log' | 'increment-fix-cycle';

export interface State {
  readonly id: string;
  readonly type: 'atomic' | 'compound' | 'final';
  readonly parent?: string;
  readonly initial?: string;
  readonly onEntry?: readonly Effect[];
  readonly onExit?: readonly Effect[];
  readonly maxFixCycles?: number;
}

export interface Transition {
  readonly from: string;
  readonly to: string;
  readonly guard?: Guard;
  readonly effects?: readonly Effect[];
  readonly isFixCycle?: boolean;
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

export interface TransitionResult {
  readonly success: boolean;
  readonly idempotent: boolean;
  readonly newPhase?: string;
  readonly effects: readonly Effect[];
  readonly events: readonly TransitionEvent[];
  readonly historyUpdates?: Record<string, string>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly guardDescription?: string;
  readonly validTargets?: readonly string[];
}

// ─── HSM Registry ───────────────────────────────────────────────────────────

const hsmRegistry: Record<string, HSMDefinition> = {
  feature: createFeatureHSM(),
  debug: createDebugHSM(),
  refactor: createRefactorHSM(),
};

export function getHSMDefinition(workflowType: string): HSMDefinition {
  const hsm = hsmRegistry[workflowType];
  if (!hsm) {
    throw new Error(`Unknown workflow type: ${workflowType}`);
  }
  return hsm;
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
 * Get all valid target phases for transitions from a given phase,
 * including the universal cancel transition.
 */
export function getValidTransitions(
  hsm: HSMDefinition,
  fromPhase: string
): readonly string[] {
  const state = hsm.states[fromPhase];
  if (!state || state.type === 'final') return [];

  const targets = hsm.transitions
    .filter((t) => t.from === fromPhase)
    .map((t) => t.to);

  // Add universal cancel if not already present
  if (!targets.includes('cancelled') && hsm.states['cancelled']) {
    targets.push('cancelled');
  }

  // Add universal cleanup (completed) if not already present
  if (!targets.includes('completed') && hsm.states['completed']) {
    targets.push('completed');
  }

  return [...new Set(targets)];
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
  targetPhase: string
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
  const transition = hsm.transitions.find(
    (t) => t.from === currentPhase && t.to === targetPhase
  );

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
      metadata: { compoundStateId: parent?.id },
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
  };
}
