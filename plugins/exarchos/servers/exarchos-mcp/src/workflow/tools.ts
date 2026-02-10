import type {
  InitInput,
  ListInput,
  GetInput,
  SetInput,
  SummaryInput,
  ReconcileInput,
  NextActionInput,
  TransitionsInput,
  CancelInput,
  CheckpointInput,
  CheckpointMeta,
  WorkflowState,
} from './types.js';
import { ErrorCode, isReservedField } from './schemas.js';
import {
  initStateFile,
  readStateFile,
  writeStateFile,
  applyDotPath,
  listStateFiles,
  StateStoreError,
} from './state-store.js';
import {
  buildCheckpointMeta,
  incrementOperations,
  resetCounter,
  isStale,
} from './checkpoint.js';
import { appendEvent, getRecentEvents } from './events.js';
import { getHSMDefinition, executeTransition, getValidTransitions } from './state-machine.js';
import { getCircuitBreakerState } from './circuit-breaker.js';
import { executeCompensation } from './compensation.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// ─── Tool Result Interface ──────────────────────────────────────────────────

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string; validTargets?: readonly string[] };
  readonly _meta?: CheckpointMeta;
}

// ─── handleInit ─────────────────────────────────────────────────────────────

export async function handleInit(
  input: InitInput,
  stateDir: string,
): Promise<ToolResult> {
  try {
    const { state } = await initStateFile(stateDir, input.featureId, input.workflowType);
    return {
      success: true,
      data: {
        featureId: state.featureId,
        workflowType: state.workflowType,
        phase: state.phase,
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_ALREADY_EXISTS) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_ALREADY_EXISTS,
          message: `State already exists for feature: ${input.featureId}`,
        },
      };
    }
    throw err;
  }
}

// ─── handleList ─────────────────────────────────────────────────────────────

export async function handleList(
  _input: ListInput,
  stateDir: string,
): Promise<ToolResult> {
  const entries = await listStateFiles(stateDir);

  const data = entries.map((entry) => ({
    featureId: entry.featureId,
    workflowType: entry.state.workflowType,
    phase: entry.state.phase,
    stateFile: entry.stateFile,
    stale: isStale(entry.state._checkpoint),
  }));

  return {
    success: true,
    data,
  };
}

// ─── handleGet ──────────────────────────────────────────────────────────────

export async function handleGet(
  input: GetInput,
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

  const meta = buildCheckpointMeta(state._checkpoint);

  if (!input.query) {
    return {
      success: true,
      data: state,
      _meta: meta,
    };
  }

  // Resolve dot-path query against the state object
  const value = resolveDotPath(state as unknown as Record<string, unknown>, input.query);
  return {
    success: true,
    data: value,
    _meta: meta,
  };
}

// ─── handleSet ──────────────────────────────────────────────────────────────

export async function handleSet(
  input: SetInput,
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

  // Work with a deep copy to avoid shared reference mutation
  const mutableState = structuredClone(state) as Record<string, unknown>;

  // ─── Field updates (applied first so phase guards see new state) ───
  if (input.updates) {
    // Check for reserved fields before applying any updates
    for (const dotPath of Object.keys(input.updates)) {
      if (isReservedField(dotPath)) {
        return {
          success: false,
          error: {
            code: ErrorCode.RESERVED_FIELD,
            message: `Cannot update reserved field: ${dotPath}`,
          },
        };
      }
    }

    for (const [dotPath, value] of Object.entries(input.updates)) {
      applyDotPath(mutableState, dotPath, value);
    }
  }

  // ─── Phase transition (guards evaluate against updated state) ──────
  if (input.phase) {
    const hsm = getHSMDefinition(state.workflowType);
    const result = executeTransition(hsm, mutableState, input.phase);

    if (!result.success) {
      const errorCode = result.errorCode ?? ErrorCode.INVALID_TRANSITION;
      return {
        success: false,
        error: {
          code: errorCode,
          message: result.errorMessage ?? `Transition failed to '${input.phase}'`,
          ...(result.validTargets?.length ? { validTargets: result.validTargets } : {}),
        },
      };
    }

    if (!result.idempotent && result.newPhase) {
      // Update phase
      mutableState.phase = result.newPhase;

      // Apply events from the transition
      let events = mutableState._events as WorkflowState['_events'];
      let eventSequence = mutableState._eventSequence as number;

      for (const transitionEvent of result.events) {
        const appended = appendEvent(
          events,
          eventSequence,
          transitionEvent.type as WorkflowState['_events'][number]['type'],
          transitionEvent.trigger,
          {
            from: transitionEvent.from,
            to: transitionEvent.to,
            metadata: transitionEvent.metadata,
          },
        );
        events = appended.events;
        eventSequence = appended.eventSequence;
      }

      mutableState._events = events;
      mutableState._eventSequence = eventSequence;

      // Apply history updates
      if (result.historyUpdates) {
        const history = { ...(mutableState._history as Record<string, string>) };
        for (const [key, value] of Object.entries(result.historyUpdates)) {
          history[key] = value;
        }
        mutableState._history = history;
      }

      // Reset checkpoint counter on phase transition
      mutableState._checkpoint = resetCounter(
        mutableState._checkpoint as WorkflowState['_checkpoint'],
        result.newPhase,
      );
    }
  }

  // Increment checkpoint operation counter
  mutableState._checkpoint = incrementOperations(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
  );

  // Update timestamp
  mutableState.updatedAt = new Date().toISOString();

  // Update lastActivityTimestamp on checkpoint
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Write back to disk
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: mutableState.phase as string,
      updatedAt: mutableState.updatedAt as string,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}

// ─── handleCancel ──────────────────────────────────────────────────────────

export async function handleCancel(
  input: CancelInput,
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

  // Check if already cancelled
  if (state.phase === 'cancelled') {
    return {
      success: false,
      error: {
        code: ErrorCode.ALREADY_CANCELLED,
        message: `Workflow '${input.featureId}' is already cancelled`,
      },
    };
  }

  const mutableState = structuredClone(state) as Record<string, unknown>;
  const currentPhase = state.phase;
  const events = (mutableState._events as WorkflowState['_events']) ?? [];
  const eventSequence = (mutableState._eventSequence as number) ?? 0;
  const dryRun = input.dryRun ?? false;

  // Execute compensation actions
  const compensationResult = await executeCompensation(
    mutableState,
    currentPhase,
    events,
    eventSequence,
    { dryRun, stateDir },
  );

  // If dry run, return what would happen without modifying state
  if (dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        actions: compensationResult.actions,
        currentPhase,
        wouldTransitionTo: 'cancelled',
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  }

  // Check if compensation had failures
  if (!compensationResult.success) {
    const failedActions = compensationResult.actions.filter((a) => a.status === 'failed');
    return {
      success: false,
      error: {
        code: ErrorCode.COMPENSATION_PARTIAL,
        message: `Compensation partially failed: ${failedActions.map((a) => a.message).join('; ')}`,
      },
    };
  }

  // Transition to cancelled via HSM
  const hsm = getHSMDefinition(state.workflowType);
  const transitionResult = executeTransition(hsm, mutableState, 'cancelled');

  if (!transitionResult.success) {
    return {
      success: false,
      error: {
        code: transitionResult.errorCode ?? ErrorCode.INVALID_TRANSITION,
        message: transitionResult.errorMessage ?? 'Failed to transition to cancelled',
      },
    };
  }

  // Apply phase change
  mutableState.phase = 'cancelled';

  // Build up events: start with existing events + compensation events
  let updatedEvents = [...events, ...compensationResult.events];
  let updatedSequence = eventSequence + compensationResult.events.length;

  // Append transition events from HSM
  for (const transitionEvent of transitionResult.events) {
    const appended = appendEvent(
      updatedEvents,
      updatedSequence,
      transitionEvent.type as WorkflowState['_events'][number]['type'],
      transitionEvent.trigger,
      {
        from: transitionEvent.from,
        to: transitionEvent.to,
        metadata: transitionEvent.metadata,
      },
    );
    updatedEvents = appended.events;
    updatedSequence = appended.eventSequence;
  }

  // Append cancel event with reason metadata
  const cancelMetadata: Record<string, unknown> = {};
  if (input.reason) {
    cancelMetadata.reason = input.reason;
  }
  cancelMetadata.compensationActions = compensationResult.actions.length;
  cancelMetadata.compensationSuccess = compensationResult.success;

  const cancelAppended = appendEvent(
    updatedEvents,
    updatedSequence,
    'cancel',
    'user-cancel',
    {
      from: currentPhase,
      to: 'cancelled',
      metadata: cancelMetadata,
    },
  );
  updatedEvents = cancelAppended.events;
  updatedSequence = cancelAppended.eventSequence;

  mutableState._events = updatedEvents;
  mutableState._eventSequence = updatedSequence;

  // Apply history updates from transition
  if (transitionResult.historyUpdates) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(transitionResult.historyUpdates)) {
      history[key] = value;
    }
    mutableState._history = history;
  }

  // Reset checkpoint counter
  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    'cancelled',
    'Workflow cancelled',
  );

  // Update timestamp
  mutableState.updatedAt = new Date().toISOString();

  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Write updated state
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: 'cancelled',
      actions: compensationResult.actions,
      previousPhase: currentPhase,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}

// ─── handleCheckpoint ──────────────────────────────────────────────────────

export async function handleCheckpoint(
  input: CheckpointInput,
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

  // Work with a deep copy to avoid shared reference mutation
  const mutableState = structuredClone(state) as Record<string, unknown>;

  // Reset checkpoint counter with current phase and optional summary
  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    state.phase,
    input.summary,
  );

  // Append checkpoint event to event log
  const trigger = input.summary ?? 'explicit checkpoint';
  const appended = appendEvent(
    mutableState._events as WorkflowState['_events'],
    mutableState._eventSequence as number,
    'checkpoint',
    trigger,
  );
  mutableState._events = appended.events;
  mutableState._eventSequence = appended.eventSequence;

  // Update lastActivityTimestamp
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Update top-level timestamp
  mutableState.updatedAt = new Date().toISOString();

  // Write back to disk
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: (mutableState._checkpoint as Record<string, unknown>).phase as string,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a dot-path against an object, returning the value at that path.
 * Returns undefined if the path does not exist.
 */
function resolveDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const segments = dotPath.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    // Handle array bracket notation: "tasks[0]"
    const bracketMatch = segment.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      current = (current as Record<string, unknown>)[bracketMatch[1]];
      if (!Array.isArray(current)) return undefined;
      current = current[parseInt(bracketMatch[2], 10)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

// ─── Human Checkpoint Phases ────────────────────────────────────────────────

const HUMAN_CHECKPOINT_PHASES: Record<string, ReadonlySet<string>> = {
  feature: new Set(['plan-review', 'synthesize']),
  debug: new Set(['hotfix-validate', 'synthesize']),
  refactor: new Set(['polish-update-docs', 'synthesize']),
};

// ─── Phase-to-Action Mapping ────────────────────────────────────────────────

const PHASE_ACTION_MAP: Record<string, Record<string, string>> = {
  feature: {
    ideate: 'AUTO:plan',
    plan: 'AUTO:plan-review',
    'plan-review': 'AUTO:delegate',
    delegate: 'AUTO:integrate',
    integrate: 'AUTO:review',
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
    'overhaul-delegate': 'AUTO:refactor-integrate',
    'overhaul-integrate': 'AUTO:refactor-review',
    'overhaul-review': 'AUTO:refactor-update-docs',
    'overhaul-update-docs': 'AUTO:refactor-synthesize',
  },
};

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

  // Recent events (last 5)
  const recentEvents = getRecentEvents(state._events, 5);

  // Circuit breaker state for the relevant compound
  const compound = findCompoundForPhase(state.workflowType, state.phase);
  let circuitBreaker: Record<string, unknown> | undefined;
  if (compound) {
    const cbState = getCircuitBreakerState(
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
      let guardResult = false;
      try {
        guardResult = (transition.isFixCycle ?? false) && (transition.guard?.evaluate(stateRecord) ?? false);
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
      if (guardResult) {
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
    let guardResult = false;
    try {
      guardResult = transition.guard?.evaluate(stateRecord) ?? false;
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
    if (guardResult) {
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
