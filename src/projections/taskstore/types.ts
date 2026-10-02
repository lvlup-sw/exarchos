/**
 * State types for the TaskStore projection.
 *
 * The `task-store@v1` reducer folds the `task.*` events of one workflow stream into
 * task records keyed by `taskId`. A `taskId` is a per-feature ordinal such as `'001'`,
 * and a {@link TaskRecord} holds no `featureId`. So a key is unique only in one stream,
 * and the reducer scope is `'stream'`. The `scope` description in `projections/types.ts`
 * states the rule.
 *
 * Each status maps to one event: `assigned` to `task.assigned`, `claimed` to
 * `task.claimed`, `in-progress` to `task.progressed`, `completed` to `task.completed`,
 * and `failed` to `task.failed`. These workflow events include no pending or cancelled
 * event, so there is no such status. The `task.cancelled` event belongs to the
 * `task-store/<taskId>` streams, not to a workflow stream. Pending tasks from the plan
 * are in `taskProgress` of the rehydration document.
 */

/** The status of a {@link TaskRecord}. The file header maps each status to its event. */
export type TaskStatus =
  | 'assigned'
  | 'claimed'
  | 'in-progress'
  | 'completed'
  | 'failed';

/**
 * The projected state of one task. Each optional field is a copy from the `data` of
 * the event that its description names, so the record grows as events fold in.
 */
export interface TaskRecord {
  /** Stable identifier carried on every `task.*` event. */
  readonly taskId: string;

  /** Most-recently observed status (latest event wins, per fold). */
  readonly status: TaskStatus;

  /** Human-readable task title (from `task.assigned`). */
  readonly title?: string;
  /** Planned git branch (from `task.assigned`). */
  readonly branch?: string;
  /** Worktree path for task isolation (from `task.assigned`). */
  readonly worktree?: string;
  /** Initially-declared assignee (from `task.assigned`). */
  readonly assignee?: string;

  /** Agent that claimed the task (from `task.claimed`). */
  readonly agentId?: string;
  /** When the claim was issued (from `task.claimed`). */
  readonly claimedAt?: string;

  /** Most-recent TDD phase (from `task.progressed`). */
  readonly tddPhase?: 'red' | 'green' | 'refactor' | undefined;
  /** Free-form progress detail (from `task.progressed`). */
  readonly detail?: string;

  /** Artifact paths produced by the task (from `task.completed`). */
  readonly artifacts?: readonly string[];
  /** Wall-clock duration in ms (from `task.completed`). */
  readonly duration?: number;

  /** Failure reason (from `task.failed`). */
  readonly error?: string;
}

/**
 * The full projected state.
 *
 * `projectionSequence` counts the applied events. An unhandled event, or an event
 * without a `taskId`, does not increment it. `rehydration/reducer.ts` uses the same rule.
 */
export interface TaskStoreState {
  readonly projectionSequence: number;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
}
