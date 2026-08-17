/**
 * TaskStore projection state types (Task 2A.2 / #1284).
 *
 * The TaskStore is a **stream-scoped** projection — its reducer
 * (`task-store@v1`) folds `task.*` events from **one** workflow stream into an
 * indexed view of task records keyed by `taskId`. This is the canonical
 * replacement for the ad-hoc fold-in-view patterns previously living in
 * `projections/views/task-detail-view.ts` and `projections/views/workflow-status-view.ts` (see Task
 * 2A.7 for the wire-through).
 *
 * ## The key space
 *
 * `tasks` is keyed by `taskId` — a bare per-feature ordinal (`'001'`), minted
 * by `parseTaskBlocks` from `### Task 001` headers — and {@link TaskRecord}
 * carries no `featureId`. So the key is unique only *within* a stream.
 *
 * That is the fact this reducer's `scope` stamp answers to; the reducer-scope
 * rule itself, why this one is `'stream'`, and what re-widening would demand
 * are stated once, in the `scope` docstring in `projections/types.ts`. The
 * dormant-and-correct vs dormant-and-wrong posture lesson this epic turned on
 * lives in `docs/architecture/projections.md`.
 *
 * Status enum is the **production-realistic** transition surface (per the
 * plan's GREEN correction on line 355). The five values map 1:1 to the
 * registered `task.*` event types:
 *
 *   - `assigned`     ← `task.assigned`
 *   - `claimed`      ← `task.claimed`
 *   - `in-progress`  ← `task.progressed`
 *   - `completed`    ← `task.completed`
 *   - `failed`       ← `task.failed`
 *
 * There is intentionally no `pending` or `cancelled` — neither `task.pending`
 * nor `task.cancelled` exist in `events/schemas.ts`, and the TaskStore
 * projection's contract is "what the events say happened". Plan-derived
 * pending tasks live on the rehydration document's `taskProgress` (a
 * different projection with a different contract); they do NOT belong here.
 */

/** Status surface of a TaskRecord — see file header for the event mapping. */
export type TaskStatus =
  | 'assigned'
  | 'claimed'
  | 'in-progress'
  | 'completed'
  | 'failed';

/**
 * A single task's projected state. Pass-through fields are optional so the
 * record progressively gains shape as more events fold in. Fields are copied
 * from the corresponding event's `data` payload (see `events/schemas.ts`
 * — `TaskAssignedData`, `TaskClaimedData`, `TaskProgressedData`,
 * `TaskCompletedData`, `TaskFailedData`).
 */
export interface TaskRecord {
  /** Stable identifier carried on every `task.*` event. */
  readonly taskId: string;

  /** Most-recently observed status (latest event wins, per fold). */
  readonly status: TaskStatus;

  // ─── Passthrough fields from task.assigned ─────────────────────────────
  /** Human-readable task title (from `task.assigned`). */
  readonly title?: string;
  /** Planned git branch (from `task.assigned`). */
  readonly branch?: string;
  /** Worktree path for task isolation (from `task.assigned`). */
  readonly worktree?: string;
  /** Initially-declared assignee (from `task.assigned`). */
  readonly assignee?: string;

  // ─── Passthrough fields from task.claimed ──────────────────────────────
  /** Agent that claimed the task (from `task.claimed`; overwrites `assignee`). */
  readonly agentId?: string;
  /** When the claim was issued (from `task.claimed`). */
  readonly claimedAt?: string;

  // ─── Passthrough fields from task.progressed ───────────────────────────
  /** Most-recent TDD phase (from `task.progressed`). */
  readonly tddPhase?: 'red' | 'green' | 'refactor' | undefined;
  /** Free-form progress detail (from `task.progressed`). */
  readonly detail?: string;

  // ─── Passthrough fields from task.completed ────────────────────────────
  /** Artifact paths produced by the task (from `task.completed`). */
  readonly artifacts?: readonly string[];
  /** Wall-clock duration in ms (from `task.completed`). */
  readonly duration?: number;

  // ─── Passthrough fields from task.failed ───────────────────────────────
  /** Failure reason (from `task.failed`). */
  readonly error?: string;
}

/**
 * The full projected state.
 *
 * `projectionSequence` is the monotone count of folded-and-mutated events;
 * unhandled / no-op events MUST NOT bump it, matching the convention used by
 * sibling projections (see `rehydration/reducer.ts`). It is the canonical
 * stale-snapshot detector for cache-validation logic.
 *
 * `tasks` is keyed by `taskId`; values are `TaskRecord`s. Lookup is O(1);
 * iteration order is insertion order (the JS spec's `Record<string, _>`
 * guarantee for string keys).
 */
export interface TaskStoreState {
  readonly projectionSequence: number;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
}
