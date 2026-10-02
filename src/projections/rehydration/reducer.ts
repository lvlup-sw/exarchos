/**
 * Rehydration projection reducer. It folds the `WorkflowEvent` stream into a {@link RehydrationDocument}.
 *
 * - `task.assigned`, `task.completed` and `task.failed` set `taskProgress`.
 * - `workflow.started` and `workflow.transition` set `workflowState`.
 * - `workflow.checkpoint` and `workflow.handoff_summarized` set `latestHandoff` and `recentHandoffs`.
 * - `state.patched` sets `artifacts` and the plan tasks in `taskProgress`.
 * - A blocked `review.completed`, `review.escalated` and `workflow.guard-failed` add `blockers`.
 * - The terminal `merge.*` events end the `merge-pending` detour.
 *
 * The reducer handles no event that writes `decisions`, so that list stays empty.
 * A handler returns `state` unchanged for a malformed or unactionable event, so `projectionSequence` counts only handled events.
 * The `./index.ts` barrel registers the reducer.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from './schema.js';
import {
  STATUS_RANK,
  extractPlanTasksFromPatch,
  rankOf,
  type ExtractedPlanTask,
  type TaskStatus,
} from '../shared/task-status-fold.js';
import {
  extractTaskId,
  extractString,
} from '../shared/event-data-extractors.js';

/**
 * Task status in `taskProgress`. It uses the `TaskSchema.status` values of `workflow/schemas.ts`, so a consumer compares statuses with no translation.
 * The `task.*` events set `in_progress`, `complete` and `failed`. The plan tasks of `state.patched` add entries with their plan status, often `pending`.
 * A plan status never lowers the rank of an entry, so a repeated plan stamp does not move a started task back to `pending`.
 */
type TaskProgressStatus = TaskStatus;

/** Structural shape of a single taskProgress entry in the rehydration doc. */
type TaskProgressEntry = RehydrationDocument['taskProgress'][number];

/**
 * Initial document, with empty volatile sections and empty stable strings. A fold over an empty stream returns this value.
 * The `.parse` call runs at module load, so a schema drift fails on import.
 */
const initialRehydrationDocument: RehydrationDocument = RehydrationDocumentSchema.parse({
  v: 4,
  projectionSequence: 0,
  workflowState: {
    featureId: '',
    phase: '',
    workflowType: '',
  },
  taskProgress: [],
  decisions: [],
  artifacts: {},
  blockers: [],
  recentHandoffs: [],
  /** The rehydrate handler composes `phasePlaybook` when it reads the document, so the reducer leaves it `null`. */
  phasePlaybook: null,
});

/**
 * The diff in `data.patch.artifacts` of a `state.patched` event.
 * `set` holds the string upserts. `unset` holds the keys that the patch clears with `null`.
 */
interface ExtractedArtifactsPatch {
  readonly set: Record<string, string>;
  readonly unset: readonly string[];
}

/**
 * Decodes `data.patch.artifacts` of a `state.patched` event into an upsert and clear diff.
 * It returns `undefined` when the event has no actionable entry.
 * A `null` value clears the entry, so a stale path does not stay after `workflow set { artifacts: { design: null } }`.
 * It ignores other values, such as `''`, objects and arrays, because the `Record<string, string>` map cannot hold them.
 */
function extractArtifactsPatch(
  data: WorkflowEvent['data'],
): ExtractedArtifactsPatch | undefined {
  if (!data) return undefined;
  const patch = data['patch'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return undefined;
  }
  const artifacts = (patch as Record<string, unknown>)['artifacts'];
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return undefined;
  }

  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(
    artifacts as Record<string, unknown>,
  )) {
    if (typeof value === 'string' && value.length > 0) {
      set[key] = value;
    } else if (value === null) {
      unset.push(key);
    }
  }

  if (Object.keys(set).length === 0 && unset.length === 0) {
    return undefined;
  }
  return { set, unset };
}

/**
 * Sets the status of the `taskId` entry, or appends a new entry. It keeps the other fields of an existing entry.
 * It always returns a new array, so a caller that compares references sees a handled event.
 */
function upsertTaskProgress(
  progress: readonly TaskProgressEntry[],
  taskId: string,
  status: TaskProgressStatus,
): TaskProgressEntry[] {
  const existingIdx = progress.findIndex((entry) => entry.id === taskId);
  if (existingIdx === -1) {
    return [...progress, { id: taskId, status }];
  }
  const next = progress.slice();
  next[existingIdx] = { ...next[existingIdx], id: taskId, status };
  return next;
}

/**
 * Decodes `data.patch.tasks` of a `state.patched` event into `{ id, status }` entries with `TaskSchema.status` values.
 * The pipeline view uses the same extractor from `../shared/task-status-fold.ts`, so both projections fold plan tasks the same way.
 */
const extractPlanTasks = extractPlanTasksFromPatch;

/**
 * Folds the task list of a plan into `taskProgress`. A new plan id is appended with its plan status.
 * A plan status replaces an entry status only when its rank is higher. Thus a plan can promote `in_progress` to `complete`, but it cannot lower a status.
 *
 * `patch.tasks` is the full plan, so the fold drops an entry that the plan does not list, but only while that entry is `pending`.
 * An entry with any other status stays, because it shows real work.
 * The check uses the literal status, because `rankOf` gives an unknown status the rank of `pending`.
 */
function foldPlanTasks(
  progress: readonly TaskProgressEntry[],
  planTasks: readonly ExtractedPlanTask[],
): TaskProgressEntry[] {
  const planIds = new Set(planTasks.map((planTask) => planTask.id));
  const next = progress.filter(
    (entry) => planIds.has(entry.id) || entry.status !== 'pending',
  );
  const indexById = new Map(next.map((entry, idx) => [entry.id, idx]));
  for (const planTask of planTasks) {
    const existingIdx = indexById.get(planTask.id);
    if (existingIdx === undefined) {
      next.push({ id: planTask.id, status: planTask.status });
      indexById.set(planTask.id, next.length - 1);
      continue;
    }
    const existing = next[existingIdx];
    if (existing === undefined) continue;
    if (rankOf(planTask.status) > rankOf(existing.status)) {
      next[existingIdx] = { ...existing, status: planTask.status };
    }
  }
  return next;
}

void STATUS_RANK;

/**
 * True when the event `data` has a non-blank `worktree` or `worktreePath` string.
 * The HSM `mergePendingEntry` guard in `workflow/hsm-definitions.ts` uses it too, so both see the same trigger.
 * A whitespace-only string does not count, so it cannot start the `merge-pending` detour.
 */
export function eventDataHasWorktreeAssociation(
  data: WorkflowEvent['data'],
): boolean {
  if (!data) return false;
  const w = data['worktree'];
  const p = data['worktreePath'];
  return (
    (typeof w === 'string' && w.trim().length > 0) ||
    (typeof p === 'string' && p.trim().length > 0)
  );
}

/**
 * Folds a `task.*` event into `taskProgress` with `status`. An event with no `taskId` returns `state` unchanged.
 * A `task.completed` with a worktree association also starts the `merge-pending` detour. The phase becomes `merge-pending`, and `mergeOrchestrator` gets a `pending` entry.
 * The detour applies only to a `feature` workflow in phase `''`, `delegate` or `merge-pending`, because only `createFeatureHSM()` defines `merge-pending`.
 * The phase `''` is allowed because production flows reach `delegate` with no `workflow.transition` event.
 *
 * It skips the detour when another task has a `pending` merge, so a later terminal merge event cannot apply to the wrong task.
 * It also skips it when the same task already has a terminal merge phase, so a replayed event does not offer `merge_orchestrate` again.
 */
function applyTaskEvent(
  state: RehydrationDocument,
  event: WorkflowEvent,
  status: TaskProgressStatus,
): RehydrationDocument {
  const taskId = extractTaskId(event.data);
  if (!taskId) {
    return state;
  }
  let nextWorkflowState = state.workflowState;
  const detourablePhase =
    state.workflowState.phase === '' ||
    state.workflowState.phase === 'delegate' ||
    state.workflowState.phase === 'merge-pending';
  if (
    status === 'complete' &&
    state.workflowState.workflowType === 'feature' &&
    detourablePhase &&
    eventDataHasWorktreeAssociation(event.data)
  ) {
    const existing = state.workflowState.mergeOrchestrator;
    const conflictsWithActiveOther =
      existing !== undefined &&
      existing.taskId !== taskId &&
      existing.phase === 'pending';
    const sameTaskTerminal =
      existing !== undefined &&
      existing.taskId === taskId &&
      existing.phase !== 'pending';
    if (!conflictsWithActiveOther && !sameTaskTerminal) {
      nextWorkflowState = {
        ...state.workflowState,
        phase: 'merge-pending',
        mergeOrchestrator: { taskId, phase: 'pending' },
      };
    }
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    taskProgress: upsertTaskProgress(state.taskProgress, taskId, status),
    workflowState: nextWorkflowState,
  };
}

/**
 * Handles `merge.executed`, `merge.recovered`, the retired `merge.rollback` and `merge.aborted`.
 * It sets `terminalPhase` on `mergeOrchestrator` and sets the phase to `delegate` from any phase, like the HSM `mergePendingExit` guard.
 * With no `mergeOrchestrator` entry, it returns `state` unchanged, so a stray merge event does not invent one.
 *
 * A repeat of the same terminal phase while the phase is `delegate` returns `state` unchanged, so it does not advance `projectionSequence`.
 * It reads no event field, so `merge.recovered` and `merge.rollback` fold the same. In an old log with both events, the second event changes nothing.
 */
function applyMergeTerminalEvent(
  state: RehydrationDocument,
  event: WorkflowEvent,
  terminalPhase: 'completed' | 'rolled-back' | 'aborted',
): RehydrationDocument {
  const existing = state.workflowState.mergeOrchestrator;
  if (!existing) return state;
  if (
    existing.phase === terminalPhase &&
    state.workflowState.phase === 'delegate'
  ) {
    return state;
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    workflowState: {
      ...state.workflowState,
      phase: 'delegate',
      mergeOrchestrator: { taskId: existing.taskId, phase: terminalPhase },
    },
  };
}

/**
 * Handles `workflow.started`: sets `featureId` and `workflowType` of `workflowState`.
 * It does not set `phase`, because the event has no phase. An event with no `featureId` or `workflowType` returns `state` unchanged.
 */
function applyWorkflowStarted(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const featureId = extractString(event.data, 'featureId');
  const workflowType = extractString(event.data, 'workflowType');
  if (!featureId || !workflowType) {
    return state;
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    workflowState: {
      ...state.workflowState,
      featureId,
      workflowType,
    },
  };
}

/**
 * Handles `workflow.transition`: sets `workflowState.phase` to `to`, and keeps `featureId` and `workflowType`.
 * An event with no `to` returns `state` unchanged.
 */
function applyWorkflowTransition(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const to = extractString(event.data, 'to');
  if (!to) {
    return state;
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    workflowState: {
      ...state.workflowState,
      phase: to,
    },
  };
}

/**
 * Handles `workflow.guard-failed`: adds a blocker for the rejected transition.
 * Unlike the other handlers, it also folds an event with missing fields, because the event itself shows that a guard fired.
 * A missing `guard` becomes `'unknown-guard'`. It copies `from` and `to` only when they are present.
 */
function applyWorkflowGuardFailed(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const guard = extractString(event.data, 'guard') ?? 'unknown-guard';
  const from = extractString(event.data, 'from');
  const to = extractString(event.data, 'to');
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    blockers: [
      ...state.blockers,
      {
        source: 'workflow.guard-failed',
        guard,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
    ],
  };
}

/**
 * Handles `state.patched`, the event behind `exarchos_workflow set`.
 * It folds `data.patch.artifacts` into `artifacts` and `data.patch.tasks` into `taskProgress`. The event can have one, both or neither.
 * Planners stamp the full task list before the first `task.assigned`, so the plan tasks show the pending tasks.
 * An event with no actionable subtree returns `state` unchanged. Otherwise `projectionSequence` advances once.
 */
function applyStatePatched(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const artifactsPatch = extractArtifactsPatch(event.data);
  const planTasks = extractPlanTasks(event.data);
  if (!artifactsPatch && !planTasks) {
    return state;
  }

  let nextArtifacts: Record<string, string> = state.artifacts;
  if (artifactsPatch) {
    nextArtifacts = { ...state.artifacts };
    for (const key of artifactsPatch.unset) {
      delete nextArtifacts[key];
    }
    for (const [key, value] of Object.entries(artifactsPatch.set)) {
      nextArtifacts[key] = value;
    }
  }

  const nextTaskProgress = planTasks
    ? foldPlanTasks(state.taskProgress, planTasks)
    : state.taskProgress;

  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    artifacts: nextArtifacts,
    taskProgress: nextTaskProgress,
  };
}

/**
 * Handles `review.completed`: only the `blocked` verdict adds a blocker.
 * Other verdicts, such as `pass` and `fail`, return `state` unchanged. A `fail` verdict means findings to fix, not a hard stop.
 */
function applyReviewCompleted(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const verdict = extractString(event.data, 'verdict');
  if (verdict !== 'blocked') {
    return state;
  }
  const summary = extractString(event.data, 'summary') ?? 'review blocked';
  const stage = extractString(event.data, 'stage') ?? 'review';
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    blockers: [
      ...state.blockers,
      { source: 'review.completed', stage, summary },
    ],
  };
}

/**
 * Handles `workflow.checkpoint`: folds `data.handoff` into `latestHandoff` and the front of `recentHandoffs`.
 * `recentHandoffs` holds at most 3 entries, newest first, to limit the token cost of the envelope.
 * An event with no actionable handoff returns `state` unchanged. The reducer does not project the other checkpoint fields.
 * The entry has `source: 'operator'`, and it always replaces `latestHandoff`.
 * `eventRef` holds only `sequence` and `timestamp`, because the strict `HandoffEntrySchemaV2` rejects an `id` key.
 */
function applyWorkflowCheckpoint(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const handoff = extractHandoff(event.data);
  if (!handoff) {
    return state;
  }
  const entry: RehydrationDocument['recentHandoffs'][number] = {
    ...(handoff.context !== undefined ? { context: handoff.context } : {}),
    ...(handoff.nextSteps !== undefined ? { nextSteps: handoff.nextSteps } : {}),
    ...(handoff.suggestions !== undefined
      ? { suggestions: handoff.suggestions }
      : {}),
    eventRef: {
      sequence: event.sequence,
      timestamp: event.timestamp,
    },
    source: 'operator',
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    latestHandoff: entry,
    recentHandoffs: [entry, ...state.recentHandoffs].slice(0, 3),
  };
}

/**
 * Handles `workflow.handoff_summarized`: folds the summarized handoff with `source: 'auto'`.
 * It applies only when `latestHandoff` is absent or already `'auto'`, so an operator handoff always wins.
 * An entry with no `source` counts as an operator entry. When the summary does not apply, it returns `state` unchanged.
 * The summary text comes from the stored event, so a replay does not run the summarizer again.
 */
function applyWorkflowHandoffSummarized(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const handoff = extractHandoff(event.data);
  if (!handoff) {
    return state;
  }
  const current = state.latestHandoff;
  if (current !== undefined && current.source !== 'auto') {
    return state;
  }
  const entry: RehydrationDocument['recentHandoffs'][number] = {
    ...(handoff.context !== undefined ? { context: handoff.context } : {}),
    ...(handoff.nextSteps !== undefined ? { nextSteps: handoff.nextSteps } : {}),
    ...(handoff.suggestions !== undefined
      ? { suggestions: handoff.suggestions }
      : {}),
    eventRef: {
      sequence: event.sequence,
      timestamp: event.timestamp,
    },
    source: 'auto',
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    latestHandoff: entry,
    recentHandoffs: [entry, ...state.recentHandoffs].slice(0, 3),
  };
}

/**
 * The actionable fields of a handoff.
 * The arrays are mutable because the Zod-inferred entry type uses `string[]`. The reducer does not mutate them.
 */
interface ExtractedHandoff {
  readonly context?: string;
  readonly nextSteps?: string[];
  readonly suggestions?: string[];
}

/**
 * Decodes `data.handoff` of an event, and keeps only non-empty strings.
 * It returns `undefined` when no `context`, `nextSteps` or `suggestions` value remains, so the caller does not advance `projectionSequence`.
 * An empty array counts as a missing field and is left out of the result, because some emitters write empty handoffs.
 */
function extractHandoff(
  data: WorkflowEvent['data'],
): ExtractedHandoff | undefined {
  if (!data) return undefined;
  const raw = data['handoff'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const h = raw as Record<string, unknown>;
  const context =
    typeof h['context'] === 'string' && h['context'].length > 0
      ? (h['context'] as string)
      : undefined;
  const nextSteps = Array.isArray(h['nextSteps'])
    ? (h['nextSteps'] as unknown[]).filter(
        (e): e is string => typeof e === 'string' && e.length > 0,
      )
    : undefined;
  const suggestions = Array.isArray(h['suggestions'])
    ? (h['suggestions'] as unknown[]).filter(
        (e): e is string => typeof e === 'string' && e.length > 0,
      )
    : undefined;

  const hasContext = context !== undefined;
  const hasNextSteps = nextSteps !== undefined && nextSteps.length > 0;
  const hasSuggestions = suggestions !== undefined && suggestions.length > 0;
  if (!hasContext && !hasNextSteps && !hasSuggestions) return undefined;

  return {
    ...(hasContext ? { context } : {}),
    ...(hasNextSteps ? { nextSteps } : {}),
    ...(hasSuggestions ? { suggestions } : {}),
  };
}

/** Handles `review.escalated`: adds a blocker with the escalation reason, because an escalation always blocks. */
function applyReviewEscalated(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const reason = extractString(event.data, 'reason') ?? 'review escalated';
  const triggeringFinding = extractString(event.data, 'triggeringFinding');
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    blockers: [
      ...state.blockers,
      {
        source: 'review.escalated',
        reason,
        ...(triggeringFinding ? { triggeringFinding } : {}),
      },
    ],
  };
}

/**
 * The `rehydration@v1` reducer. An unknown event type returns `state` unchanged.
 * It maps `task.assigned`, `task.completed` and `task.failed` to the `TaskSchema.status` values `in_progress`, `complete` and `failed`.
 */
export const rehydrationReducer: ProjectionReducer<RehydrationDocument, WorkflowEvent> = {
  id: 'rehydration@v1',
  version: 1,
  scope: 'stream' as const,
  initial: initialRehydrationDocument,
  apply(state: RehydrationDocument, event: WorkflowEvent): RehydrationDocument {
    switch (event.type) {
      case 'task.assigned':
        return applyTaskEvent(state, event, 'in_progress');
      case 'task.completed':
        return applyTaskEvent(state, event, 'complete');
      case 'task.failed':
        return applyTaskEvent(state, event, 'failed');

      case 'workflow.started':
        return applyWorkflowStarted(state, event);
      case 'workflow.transition':
        return applyWorkflowTransition(state, event);
      case 'workflow.guard-failed':
        return applyWorkflowGuardFailed(state, event);
      case 'workflow.checkpoint':
        return applyWorkflowCheckpoint(state, event);
      case 'workflow.handoff_summarized':
        return applyWorkflowHandoffSummarized(state, event);

      case 'state.patched':
        return applyStatePatched(state, event);

      case 'review.completed':
        return applyReviewCompleted(state, event);
      case 'review.escalated':
        return applyReviewEscalated(state, event);

      case 'merge.executed':
        return applyMergeTerminalEvent(state, event, 'completed');
      case 'merge.recovered':
      case 'merge.rollback':
        return applyMergeTerminalEvent(state, event, 'rolled-back');
      case 'merge.aborted':
        return applyMergeTerminalEvent(state, event, 'aborted');

      default:
        return state;
    }
  },
};

export type { RehydrationDocument } from './schema.js';
