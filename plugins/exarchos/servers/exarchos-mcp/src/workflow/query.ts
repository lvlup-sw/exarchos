import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  SummaryInput,
  ReconcileInput,
  TransitionsInput,
  WorkflowState,
} from './types.js';
import { ErrorCode } from './schemas.js';
import {
  readStateFile,
  StateStoreError,
} from './state-store.js';
import { buildCheckpointMeta } from './checkpoint.js';
import { getRecentEvents, getRecentEventsFromStore } from './events.js';
import { getHSMDefinition } from './state-machine.js';
import { getCircuitBreakerState, checkCircuitBreakerFromStore } from './circuit-breaker.js';
import type { EventStore } from '../event-store/store.js';
import { formatResult, type ToolResult } from '../format.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by query handlers. */
export function configureQueryEventStore(store: EventStore): void {
  moduleEventStore = store;
}

// ─── Compound State Lookup ──────────────────────────────────────────────────

/**
 * Find the compound state that contains the given phase, if any.
 * Returns { compoundId, maxFixCycles } or undefined.
 */
function findCompoundForPhase(
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

// ─── handleSummary ──────────────────────────────────────────────────────────

export async function handleSummary(
  input: SummaryInput,
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

  // Task progress
  const tasks = state.tasks ?? [];
  const completedTasks = tasks.filter((t) => t.status === 'complete').length;

  // Recent events (last 5) — prefer external store when available
  // Both paths return normalized { type, timestamp } shape
  let recentEvents: Array<{ type: string; timestamp: string }>;
  if (eventStore) {
    recentEvents = await getRecentEventsFromStore(eventStore, input.featureId, 5);
  } else {
    recentEvents = getRecentEvents(state._events, 5).map(e => ({
      type: e.type,
      timestamp: e.timestamp,
    }));
  }

  // Circuit breaker state for the relevant compound
  const compound = findCompoundForPhase(state.workflowType, state.phase);
  let circuitBreaker: Record<string, unknown> | undefined;
  if (compound) {
    const cbState = eventStore
      ? await checkCircuitBreakerFromStore(
          eventStore,
          input.featureId,
          compound.compoundId,
          compound.maxFixCycles,
        )
      : getCircuitBreakerState(
          state._events,
          compound.compoundId,
          compound.maxFixCycles,
        );
    circuitBreaker = {
      compoundId: cbState.compoundStateId,
      fixCycleCount: cbState.fixCycleCount,
      maxFixCycles: cbState.maxFixCycles,
      open: cbState.open,
    };
  }

  return {
    success: true,
    data: {
      featureId: state.featureId,
      workflowType: state.workflowType,
      phase: state.phase,
      taskProgress: {
        completed: completedTasks,
        total: tasks.length,
      },
      artifacts: state.artifacts,
      recentEvents,
      ...(circuitBreaker && { circuitBreaker }),
    },
  };
}

// ─── handleReconcile ────────────────────────────────────────────────────────

export async function handleReconcile(
  input: ReconcileInput,
  stateDir: string,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  // Read validated state for metadata and checkpoint
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

  // With .passthrough() on WorktreeSchema, path field is preserved through Zod parsing
  const worktrees = state.worktrees as Record<
    string,
    { branch: string; taskId?: string; tasks?: string[]; status: string; path?: string }
  >;

  const worktreeResults: Array<Record<string, unknown>> = [];

  for (const [id, wt] of Object.entries(worktrees)) {
    let pathStatus: 'OK' | 'MISSING' | 'NO_PATH' = 'NO_PATH';

    if (wt.path) {
      try {
        await fs.access(wt.path);
        pathStatus = 'OK';
      } catch {
        pathStatus = 'MISSING';
      }
    }

    const result: Record<string, unknown> = {
      id,
      branch: wt.branch,
      status: wt.status,
      path: wt.path ?? null,
      pathStatus,
    };
    if (wt.taskId !== undefined) result.taskId = wt.taskId;
    if (wt.tasks !== undefined) result.tasks = wt.tasks;

    worktreeResults.push(result);
  }

  return {
    success: true,
    data: {
      featureId: state.featureId,
      worktrees: worktreeResults,
    },
    _meta: buildCheckpointMeta(state._checkpoint),
  };
}

// ─── handleTransitions ──────────────────────────────────────────────────────

export async function handleTransitions(
  input: TransitionsInput,
  _stateDir: string,
): Promise<ToolResult> {
  const hsm = getHSMDefinition(input.workflowType);

  // Build states list
  const states = Object.values(hsm.states).map((s) => ({
    id: s.id,
    type: s.type,
    parent: s.parent ?? null,
    initial: s.initial ?? null,
  }));

  // Build transitions list, optionally filtered by fromPhase
  let transitions = hsm.transitions;
  if (input.fromPhase) {
    transitions = transitions.filter((t) => t.from === input.fromPhase);
  }

  const transitionData = transitions.map((t) => ({
    from: t.from,
    to: t.to,
    guardDescription: t.guard?.description ?? null,
    guardId: t.guard?.id ?? null,
    isFixCycle: t.isFixCycle ?? false,
    effects: t.effects ?? [],
  }));

  return {
    success: true,
    data: {
      workflowType: input.workflowType,
      states,
      transitions: transitionData,
    },
  };
}

// ─── Registration Function ──────────────────────────────────────────────────

const featureIdParam = z.string().min(1).regex(/^[a-z0-9-]+$/);

export function registerQueryTools(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_workflow_summary',
    'Get structured summary of workflow progress, events, and circuit breaker status',
    { featureId: featureIdParam },
    async (args) => formatResult(await handleSummary(args, stateDir)),
  );

  server.tool(
    'exarchos_workflow_reconcile',
    'Verify worktree paths and branches match state file',
    { featureId: featureIdParam },
    async (args) => formatResult(await handleReconcile(args, stateDir)),
  );

  server.tool(
    'exarchos_workflow_transitions',
    'Get available state machine transitions for a workflow type',
    {
      workflowType: z.enum(['feature', 'debug', 'refactor']),
      fromPhase: z.string().optional(),
    },
    async (args) => formatResult(await handleTransitions(args, stateDir)),
  );
}
