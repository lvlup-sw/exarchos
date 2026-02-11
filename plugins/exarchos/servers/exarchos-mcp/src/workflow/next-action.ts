import type {
  NextActionInput,
  CheckpointMeta,
  WorkflowState,
} from './types.js';
import { ErrorCode } from './schemas.js';
import {
  readStateFile,
  StateStoreError,
} from './state-store.js';
import { buildCheckpointMeta } from './checkpoint.js';
import { getHSMDefinition } from './state-machine.js';
import { getCircuitBreakerState } from './circuit-breaker.js';
import * as path from 'node:path';

// ─── Tool Result Interface ──────────────────────────────────────────────────

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string; validTargets?: readonly string[] };
  readonly _meta?: CheckpointMeta;
}

// ─── Human Checkpoint Phases ────────────────────────────────────────────────

export const HUMAN_CHECKPOINT_PHASES: Record<string, ReadonlySet<string>> = {
  feature: new Set(['plan-review', 'synthesize']),
  debug: new Set(['hotfix-validate', 'synthesize']),
  refactor: new Set(['polish-update-docs', 'synthesize']),
};

// ─── Phase-to-Action Mapping ────────────────────────────────────────────────

export const PHASE_ACTION_MAP: Record<string, Record<string, string>> = {
  feature: {
    ideate: 'AUTO:plan',
    plan: 'AUTO:plan-review',
    'plan-review': 'AUTO:delegate',
    delegate: 'AUTO:review',
    review: 'AUTO:synthesize',
  },
  debug: {
    triage: 'AUTO:debug-investigate',
    investigate: 'AUTO:debug-rca',
    rca: 'AUTO:debug-design',
    design: 'AUTO:debug-implement',
    'debug-implement': 'AUTO:debug-validate',
    'debug-validate': 'AUTO:debug-review',
    'debug-review': 'AUTO:debug-synthesize',
    'hotfix-implement': 'AUTO:debug-validate',
  },
  refactor: {
    explore: 'AUTO:refactor-explore',
    brief: 'AUTO:refactor-brief',
    'polish-implement': 'AUTO:refactor-validate',
    'polish-validate': 'AUTO:refactor-update-docs',
    'overhaul-plan': 'AUTO:refactor-delegate',
    'overhaul-delegate': 'AUTO:refactor-review',
    'overhaul-review': 'AUTO:refactor-update-docs',
    'overhaul-update-docs': 'AUTO:refactor-synthesize',
  },
};

// ─── Compound State Lookup ──────────────────────────────────────────────────

/**
 * Find the compound state that contains the given phase, if any.
 * Returns { compoundId, maxFixCycles } or undefined.
 */
export function findCompoundForPhase(
  workflowType: string,
  phase: string,
): { compoundId: string; maxFixCycles: number } | undefined {
  const hsm = getHSMDefinition(workflowType);
  const state = hsm.states[phase];
  if (!state?.parent) return undefined;
  const parent = hsm.states[state.parent];
  if (!parent || parent.type !== 'compound') return undefined;
  return {
    compoundId: parent.id,
    maxFixCycles: parent.maxFixCycles ?? 3,
  };
}

// ─── handleNextAction ───────────────────────────────────────────────────────

export async function handleNextAction(
  input: NextActionInput,
  stateDir: string,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  let state: WorkflowState;
  try {
    state = await readStateFile(stateFile);
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_NOT_FOUND,
          message: `State not found for feature: ${input.featureId}`,
        },
      };
    }
    throw err;
  }

  // With .passthrough() on the schema, state now includes all dynamic fields
  const stateRecord = state as unknown as Record<string, unknown>;

  const currentPhase = state.phase;
  const workflowType = state.workflowType;

  // Check if completed
  const hsm = getHSMDefinition(workflowType);
  const currentState = hsm.states[currentPhase];
  if (currentState?.type === 'final') {
    return {
      success: true,
      data: { action: 'DONE', phase: currentPhase },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  }

  // Check human checkpoint phases
  const humanCheckpoints = HUMAN_CHECKPOINT_PHASES[workflowType];
  if (humanCheckpoints?.has(currentPhase)) {
    return {
      success: true,
      data: {
        action: `WAIT:human-checkpoint:${currentPhase}`,
        phase: currentPhase,
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  }

  // Check circuit breaker for fix-cycle transitions
  const compound = findCompoundForPhase(workflowType, currentPhase);
  if (compound) {
    const cbState = getCircuitBreakerState(
      state._events,
      compound.compoundId,
      compound.maxFixCycles,
    );

    // Check if any outbound transition is a fix-cycle that would be attempted
    const outboundTransitions = hsm.transitions.filter((t) => t.from === currentPhase);

    for (const transition of outboundTransitions) {
      let guardPassed = false;
      try {
        if (transition.isFixCycle && transition.guard) {
          const raw = transition.guard.evaluate(stateRecord);
          guardPassed = typeof raw === 'boolean' ? raw : raw.passed;
        }
      } catch (err) {
        return {
          success: false,
          error: {
            code: ErrorCode.GUARD_FAILED,
            message: `Guard evaluation threw for transition ${transition.from} → ${transition.to}: ${err instanceof Error ? err.message : String(err)}`,
          },
          _meta: buildCheckpointMeta(state._checkpoint),
        };
      }
      if (guardPassed) {
        // A fix-cycle transition's guard passes, check circuit breaker
        if (cbState.open) {
          return {
            success: true,
            data: {
              action: `BLOCKED:circuit-open:${compound.compoundId}`,
              phase: currentPhase,
              fixCycleCount: cbState.fixCycleCount,
              maxFixCycles: cbState.maxFixCycles,
            },
            _meta: buildCheckpointMeta(state._checkpoint),
          };
        }
      }
    }
  }

  // Evaluate guards to find first valid transition
  const outboundTransitions = hsm.transitions.filter((t) => t.from === currentPhase);

  for (const transition of outboundTransitions) {
    let guardPassed = false;
    try {
      if (transition.guard) {
        const raw = transition.guard.evaluate(stateRecord);
        guardPassed = typeof raw === 'boolean' ? raw : raw.passed;
      }
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.GUARD_FAILED,
          message: `Guard evaluation threw for transition ${transition.from} → ${transition.to}: ${err instanceof Error ? err.message : String(err)}`,
        },
        _meta: buildCheckpointMeta(state._checkpoint),
      };
    }
    if (guardPassed) {
      // Guard passes -- determine the action
      if (transition.isFixCycle) {
        return {
          success: true,
          data: {
            action: 'AUTO:delegate:--fixes',
            phase: currentPhase,
            target: transition.to,
          },
          _meta: buildCheckpointMeta(state._checkpoint),
        };
      }

      // Use the phase-to-action map, or derive from the target
      const actionMap = PHASE_ACTION_MAP[workflowType];
      const action = actionMap?.[currentPhase] ?? `AUTO:${transition.to}`;

      return {
        success: true,
        data: {
          action,
          phase: currentPhase,
          target: transition.to,
        },
        _meta: buildCheckpointMeta(state._checkpoint),
      };
    }
  }

  // No guard passes -- still in progress
  return {
    success: true,
    data: {
      action: `WAIT:in-progress:${currentPhase}`,
      phase: currentPhase,
    },
    _meta: buildCheckpointMeta(state._checkpoint),
  };
}
