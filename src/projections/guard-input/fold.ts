/**
 * The ledger fold of the guard input.
 *
 * The fold is pure and synchronous over the migrated rows of one stream.
 * So a caller can fold the result of an event-store query or the rows of a settle snapshot.
 * No module of this directory imports `src/workflow/state-store.ts`.
 * That module reaches `resolveWorkflowState` through a dynamic import of the registry, so the import closes a runtime cycle.
 */
import type { WorkflowEvent } from '../../events/schemas.js';
import { workflowStateProjection, type WorkflowStateView } from '../views/workflow-state-projection.js';
import { isPlainObject } from '../../workflow/state-mutation.js';
import { injectGuardConfig, type GuardConfigOptions } from './config.js';
import { toGuardEvents } from './guard-events.js';

/** The state that a transition guard reads. A guard reads the input and does not change it. */
export type GuardInput = Readonly<Record<string, unknown>>;

/** The options of the guard fold and of the document side. */
export interface GuardInputOptions {
  /**
   * The handler options that the guard config reads. With this option, each side computes its config from its own state.
   * Without it, no config goes into the input. A caller with no handler options passes `{}`, because the handler injects the default review gates.
   */
  readonly config?: GuardConfigOptions;
  /** The cleanup evidence verdict of a state. With this option, the input gets `_cleanup.mergeVerified` from the verdict on that input. */
  readonly cleanupEvidence?: (state: GuardInput) => boolean;
  /** Underscore fields that the input gets as given, after each other step. They replace a field of the same name. */
  readonly ephemerals?: Readonly<Record<string, unknown>>;
}

/** The status that each task row gives its task. */
const ROW_STATUS: ReadonlyMap<string, string> = new Map([
  ['task.completed', 'complete'],
  ['task.failed', 'failed'],
]);

/** The status of a task that no completion row and no failure row names. */
const NO_ROW_STATUS = 'pending';

/**
 * Folds the rows of one stream through `workflowStateProjection` in row order, from the initial view of the projection.
 * The fold changes no row, and the same rows give an equal view.
 */
export function foldWorkflowState(rows: readonly WorkflowEvent[]): WorkflowStateView {
  let view = workflowStateProjection.init();
  for (const row of rows) {
    view = workflowStateProjection.apply(view, row);
  }
  return view;
}

/**
 * Returns the status that the rows give each task id. The rows apply in stream order, so the last completion or failure row of a task wins.
 * A row with no task id names no task, as in the projection.
 */
function rowStatusByTask(rows: readonly WorkflowEvent[]): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const row of rows) {
    const status = ROW_STATUS.get(row.type);
    const taskId = row.data?.taskId;
    if (status !== undefined && typeof taskId === 'string' && taskId.length > 0) {
      statuses.set(taskId, status);
    }
  }
  return statuses;
}

/**
 * Returns a new task list in which each task takes its status only from the task rows.
 * A task that no row names is `pending`. The list keeps each task of the fold and adds no task.
 * Each changed task is a new object, so the rows and the folded view stay unchanged.
 */
function overlayTaskStatus(tasks: unknown, statuses: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(tasks)) return tasks;
  const list: readonly unknown[] = tasks;
  return list.map((task) => {
    if (!isPlainObject(task)) return task;
    const id = task.id;
    const status = (typeof id === 'string' ? statuses.get(id) : undefined) ?? NO_ROW_STATUS;
    return { ...task, status };
  });
}

/**
 * Applies the steps that both sides share to `state` in place, in this order.
 * The guard config of `options.config`, then `_cleanup` from `options.cleanupEvidence`, then each field of `options.ephemerals`.
 */
function applySharedSteps(state: Record<string, unknown>, options: GuardInputOptions): void {
  if (options.config !== undefined) {
    injectGuardConfig(state, options.config);
  }
  if (options.cleanupEvidence !== undefined) {
    state._cleanup = { mergeVerified: options.cleanupEvidence(state) };
  }
  if (options.ephemerals !== undefined) {
    for (const [key, value] of Object.entries(options.ephemerals)) {
      state[key] = value;
    }
  }
}

/**
 * Gives the guard input from the rows of one stream.
 * The input is the base fold, with the status of each task from the task rows only and `_events` from the rows.
 * Then the steps of `options` apply. The fold changes no row, and the same rows and options give an equal input.
 */
export function foldGuardInput(rows: readonly WorkflowEvent[], options: GuardInputOptions = {}): GuardInput {
  const state: Record<string, unknown> = { ...foldWorkflowState(rows) };
  state.tasks = overlayTaskStatus(state.tasks, rowStatusByTask(rows));
  state._events = toGuardEvents(rows);
  applySharedSteps(state, options);
  return state;
}

/**
 * Gives the guard input of the state document, as the transition handler builds it.
 * The input is a clone of the document with `_events` from the rows. Then the steps of `options` apply.
 * The document keeps each task status as it is, and the function does not change the document.
 */
export function documentGuardInput(
  document: GuardInput,
  rows: readonly WorkflowEvent[],
  options: GuardInputOptions = {},
): GuardInput {
  const state: Record<string, unknown> = structuredClone(document);
  state._events = toGuardEvents(rows);
  applySharedSteps(state, options);
  return state;
}
