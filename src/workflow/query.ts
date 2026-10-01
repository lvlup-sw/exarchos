import type {
  SummaryInput,
  ReconcileInput,
  TransitionsInput,
  WorkflowState,
} from './types.js';
import { ErrorCode } from './schemas.js';
import { resolveWorkflowState } from '../verbs/resolve-state.js';
import { buildCheckpointMeta } from './checkpoint.js';
import { getRecentEventsFromStore } from './events.js';
import { getHSMDefinition } from './state-machine.js';
import { checkCircuitBreakerFromStore } from './circuit-breaker.js';
import type { EventStore } from '../events/store.js';
import { stripNullish, type ToolResult } from '../format.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { resolveTasksDir } from '../utils/paths.js';

/** Returns the compound state that contains the phase, or undefined. */
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

/**
 * Summarizes a workflow: phase, task progress, artifacts, the last five events and the circuit breaker.
 * It folds the event store when one is available. It reads `.state.json` only when no event store exists.
 * `NO_STATE_SOURCE`, or a fold with no `featureId`, gives `STATE_NOT_FOUND`.
 * Other resolution errors pass through unchanged.
 */
export async function handleSummary(
  input: SummaryInput,
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  const resolved = await resolveWorkflowState({
    featureId: input.featureId,
    eventStore: eventStore ?? undefined,
    stateFile,
  });

  const notFound: ToolResult = {
    success: false,
    error: {
      code: ErrorCode.STATE_NOT_FOUND,
      message: `State not found for feature: ${input.featureId}`,
    },
  };

  if ('error' in resolved) {
    return resolved.error.error?.code === 'NO_STATE_SOURCE' ? notFound : resolved.error;
  }

  const state = resolved.state as unknown as WorkflowState;
  if (!state.featureId) {
    return notFound;
  }

  const tasks = state.tasks ?? [];
  const completedTasks = tasks.filter((t) => t.status === 'complete').length;

  const recentEvents = eventStore
    ? await getRecentEventsFromStore(eventStore, input.featureId, 5)
    : [];

  const compound = findCompoundForPhase(state.workflowType, state.phase);
  let circuitBreaker: Record<string, unknown> | undefined;
  if (compound && eventStore) {
    const cbState = await checkCircuitBreakerFromStore(
      eventStore,
      input.featureId,
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

export interface TaskDriftEntry {
  readonly taskId: string;
  readonly exarchosStatus: string | null;
  readonly nativeStatus: string | null;
  readonly recommendation: string;
}

export interface TaskDriftReport {
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly drift: readonly TaskDriftEntry[];
}

interface NativeTaskFile {
  readonly id: string;
  readonly subject?: string | undefined;
  readonly status: string;
}

/**
 * Reads the native task JSON files in a directory into a map by task id.
 * It skips a file without a string `id` and `status`. It returns null when the directory does not exist.
 */
async function readNativeTaskFiles(
  nativeTaskDir: string,
): Promise<Map<string, NativeTaskFile> | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(nativeTaskDir);
  } catch {
    return null;
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json'));
  const tasks = new Map<string, NativeTaskFile>();

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(nativeTaskDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (typeof parsed.id !== 'string' || typeof parsed.status !== 'string') {
        continue;
      }

      tasks.set(parsed.id, {
        id: parsed.id,
        subject: typeof parsed.subject === 'string' ? parsed.subject : undefined,
        status: parsed.status,
      });
    } catch {
      continue;
    }
  }

  return tasks;
}

/** Normalizes a status for comparison. Exarchos writes "complete" and native tasks can write "completed". */
function normalizeStatus(status: string): string {
  if (status === 'complete' || status === 'completed') return 'completed';
  return status;
}

/**
 * Compares native task statuses with the Exarchos tasks and returns a drift report.
 * It matches an Exarchos task by `nativeTaskId` and skips a task without one.
 * A native task without a match is untracked, unless an Exarchos task title equals its subject.
 * It reports status mismatches, untracked native tasks and missing native tasks.
 */
export async function reconcileTasks(
  exarchosTasks: ReadonlyArray<Record<string, unknown>>,
  nativeTaskDir: string,
): Promise<TaskDriftReport> {
  const nativeTasks = await readNativeTaskFiles(nativeTaskDir);

  if (nativeTasks === null) {
    return {
      skipped: true,
      skipReason: `Native task directory not found: ${nativeTaskDir}`,
      drift: [],
    };
  }

  const drift: TaskDriftEntry[] = [];
  const matchedNativeIds = new Set<string>();

  for (const exTask of exarchosTasks) {
    const taskId = typeof exTask.id === 'string' ? exTask.id : undefined;
    const nativeTaskId = typeof exTask.nativeTaskId === 'string' ? exTask.nativeTaskId : undefined;
    const exStatus = typeof exTask.status === 'string' ? exTask.status : 'unknown';

    if (!nativeTaskId) continue;

    const nativeTask = nativeTasks.get(nativeTaskId);

    if (!nativeTask) {
      drift.push({
        taskId: taskId ?? nativeTaskId,
        exarchosStatus: exStatus,
        nativeStatus: null,
        recommendation: `Native task missing (session may have ended) — native task '${nativeTaskId}' not found in task directory`,
      });
      continue;
    }

    matchedNativeIds.add(nativeTaskId);

    if (normalizeStatus(exStatus) !== normalizeStatus(nativeTask.status)) {
      const normalizedNative = normalizeStatus(nativeTask.status);
      const recommendation = normalizedNative === 'completed'
        ? `Update Exarchos task to complete — native task '${nativeTaskId}' shows completed`
        : `Status mismatch: Exarchos='${exStatus}', native='${nativeTask.status}' — investigate and reconcile`;

      drift.push({
        taskId: taskId ?? nativeTaskId,
        exarchosStatus: exStatus,
        nativeStatus: nativeTask.status,
        recommendation,
      });
    }
  }

  for (const [nativeId, nativeTask] of nativeTasks) {
    if (matchedNativeIds.has(nativeId)) continue;

    const matchedByTitle = exarchosTasks.some((t) => {
      const title = typeof t.title === 'string' ? t.title : '';
      return title === nativeTask.subject;
    });

    if (!matchedByTitle) {
      drift.push({
        taskId: nativeId,
        exarchosStatus: null,
        nativeStatus: nativeTask.status,
        recommendation: `Untracked native task '${nativeId}' (subject: '${nativeTask.subject ?? 'unknown'}') — consider adding to workflow state`,
      });
    }
  }

  return {
    skipped: false,
    drift,
  };
}

function defaultNativeTaskBaseDir(): string {
  return resolveTasksDir();
}

/**
 * Reports the path status of each worktree and, when a task has a `nativeTaskId`, the task drift.
 * It resolves the state like {@link handleSummary}.
 * The task drift reads `nativeTaskId` from the folded tasks.
 */
export async function handleReconcile(
  input: ReconcileInput,
  stateDir: string,
  eventStore: EventStore | null,
  nativeTaskBaseDir?: string,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  const resolved = await resolveWorkflowState({
    featureId: input.featureId,
    eventStore: eventStore ?? undefined,
    stateFile,
  });

  const notFound: ToolResult = {
    success: false,
    error: {
      code: ErrorCode.STATE_NOT_FOUND,
      message: `State not found for feature: ${input.featureId}`,
    },
  };

  if ('error' in resolved) {
    return resolved.error.error?.code === 'NO_STATE_SOURCE' ? notFound : resolved.error;
  }

  const state = resolved.state as unknown as WorkflowState;
  if (!state.featureId) {
    return notFound;
  }

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

  let taskDrift: TaskDriftReport | undefined;
  const tasks = (state.tasks ?? []) as Array<Record<string, unknown>>;
  const hasNativeTasks = tasks.some((t) => typeof t.nativeTaskId === 'string');
  if (hasNativeTasks) {
    const baseDir = nativeTaskBaseDir ?? defaultNativeTaskBaseDir();
    const nativeTaskDir = path.join(baseDir, input.featureId);
    taskDrift = await reconcileTasks(tasks, nativeTaskDir);
  }

  return {
    success: true,
    data: {
      featureId: state.featureId,
      worktrees: worktreeResults,
      ...(taskDrift && { taskDrift }),
    },
    _meta: buildCheckpointMeta(state._checkpoint),
  };
}

/** Lists the HSM states and transitions of a workflow type, optionally only those from `fromPhase`. Null fields are omitted. */
export async function handleTransitions(
  input: TransitionsInput,
  _stateDir: string,
  _eventStore: EventStore | null,
): Promise<ToolResult> {
  const hsm = getHSMDefinition(input.workflowType);

  const states = Object.values(hsm.states).map((s) =>
    stripNullish({
      id: s.id,
      type: s.type,
      parent: s.parent ?? null,
      initial: s.initial ?? null,
    }),
  );

  let transitions = hsm.transitions;
  if (input.fromPhase) {
    transitions = transitions.filter((t) => t.from === input.fromPhase);
  }

  const transitionData = transitions.map((t) =>
    stripNullish({
      from: t.from,
      to: t.to,
      guardDescription: t.guard?.description ?? null,
      guardId: t.guard?.id ?? null,
      isFixCycle: t.isFixCycle ?? false,
      effects: t.effects ?? [],
    }),
  );

  return {
    success: true,
    data: {
      workflowType: input.workflowType,
      states,
      transitions: transitionData,
    },
  };
}

