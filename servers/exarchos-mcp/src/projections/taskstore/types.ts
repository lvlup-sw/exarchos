/**
 * TaskStore projection state types (Task 2A.2 / #1284).
 *
 * The TaskStore is a **stream-scoped** projection — its reducer
 * (`task-store@v1`) folds `task.*` events from **one** workflow stream into an
 * indexed view of task records keyed by `taskId`. This is the canonical
 * replacement for the ad-hoc fold-in-view patterns previously living in
 * `views/task-detail-view.ts` and `views/workflow-status-view.ts` (see Task
 * 2A.7 for the wire-through).
 *
 * ## Why stream-scoped, and why that is not a tuning knob
 *
 * This reducer originally shipped `scope: 'global'`, folding every stream at
 * once. That was a defect, not a capability: `tasks` below is keyed by a bare
 * per-feature ordinal (`'001'`) and {@link TaskRecord} carries no `featureId`,
 * so a cross-stream fold silently merges feature-A's task `001` into
 * feature-B's. The key is only unique *within* a stream.
 *
 * It had zero consumers, which is what made the bug survivable — and what made
 * it easy to misread. When auditing a dormant surface, separate the two cases:
 *
 * - **Dormant-and-correct** — e.g. `withSession`: no consumers *by intent*.
 *   The surface is sound; adopting it is safe. Absence of callers is a
 *   roadmap fact.
 * - **Dormant-and-wrong** — e.g. `task-store@v1`-global: no consumers because
 *   adopting it would have **corrupted state**. Absence of callers is the only
 *   thing that kept the bug latent, and is evidence *against* adoption.
 *
 * An audit that cannot tell these apart reads "unused" as "under-adopted" and
 * files work to wire the broken one up. That is precisely how this epic went
 * wrong. The fix was to delete the global scope, not to find it callers: the
 * `ProjectionScope` alias in `projections/types.ts` is now a single literal,
 * which makes the corrupting fold unrepresentable at compile time. Re-widening
 * it re-arms the collision above and demands a state shape actually keyed by
 * stream.
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
 * nor `task.cancelled` exist in `event-store/schemas.ts`, and the TaskStore
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
 * from the corresponding event's `data` payload (see `event-store/schemas.ts`
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
  readonly tddPhase?: 'red' | 'green' | 'refactor';
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
