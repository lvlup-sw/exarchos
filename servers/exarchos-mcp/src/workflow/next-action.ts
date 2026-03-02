import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  NextActionInput,
  WorkflowState,
} from './types.js';
import { ErrorCode } from './schemas.js';
import {
  readStateFile,
  StateStoreError,
} from './state-store.js';
import { buildCheckpointMeta } from './checkpoint.js';
import { getHSMDefinition } from './state-machine.js';
import { checkCircuitBreakerFromStore } from './circuit-breaker.js';
import type { EventStore } from '../event-store/store.js';
import { formatResult, type ToolResult } from '../format.js';
import * as path from 'node:path';

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by next-action handlers. */
export function configureNextActionEventStore(store: EventStore | null): void {
  moduleEventStore = store;
}

// ─── Human Checkpoint Phases ────────────────────────────────────────────────

export const HUMAN_CHECKPOINT_PHASES: Record<string, ReadonlySet<string>> = {
  feature: new Set(['plan-review', 'synthesize']),
  debug: new Set(['hotfix-validate', 'synthesize']),
  refactor: new Set(['overhaul-plan-review', 'polish-update-docs', 'synthesize']),
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
  const eventStore = moduleEventStore;
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

  // Check circuit breaker for fix-cycle transitions.
  // Circuit breaker requires EventStore; always configured via configureNextActionEventStore
  // in index.ts. Guard retained for test isolation where module-level store may not be set.
  const compound = findCompoundForPhase(workflowType, currentPhase);
  if (compound && eventStore) {
    const cbState = await checkCircuitBreakerFromStore(
      eventStore,
      input.featureId,
      compound.compoundId,
      compound.maxFixCycles,
    );

    // Check if any outbound transition is a fix-cycle that would be attempted
    const outboundTransitions = hsm.transitions.filter((t) => t.from === currentPhase);

    for (const transition of outboundTransitions) {
      if (!transition.isFixCycle) continue;
      let guardPassed = !transition.guard;
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
    let guardPassed = !transition.guard;
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

      // Derive action from the HSM target phase
      const action = `AUTO:${transition.to}`;

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

// ─── Registration Function ──────────────────────────────────────────────────

export function registerNextActionTool(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_workflow_next_action',
    'Determine the next auto-continue action based on current phase and guards',
    { featureId: z.string().min(1).regex(/^[a-z0-9-]+$/) },
    async (args) => formatResult(await handleNextAction(args, stateDir)),
  );
}
