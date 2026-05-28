/**
 * `merge-orchestrator@v1` projection state (Wave 2B.1 / #1304).
 *
 * Captures the per-feature-stream lifecycle of a merge as a fold over the
 * `merge.*` event family. Replaces the in-memory side-database that pre-
 * preview.2 `merge-orchestrate.ts` carried; mirrors the durable event-source-
 * of-truth pattern Wave 2A applies to TaskStore.
 *
 * ## Phase machine
 *
 *   idle ──merge.preflight──▶ preflight
 *                              │
 *                              ├──merge.requested──▶ requested   (audit §F1.2)
 *                              │                       │
 *                              │                       ▼
 *                              │                   merge.executed
 *                              │                       │
 *                              │                       ▼
 *                              ▼                    executed ──merge.completed──▶ completed
 *                          (legacy
 *                          path,
 *                          merge.executed
 *                          directly)
 *
 *   any ──merge.rollback / merge.recovered──▶ recovering
 *
 * The `requested` phase (audit findings §F1.2) is the durable INTENT recorded
 * BEFORE the non-idempotent side effect (e.g., GitHub merge API). Wave 4's
 * two-event split commits `merge.requested` purely under `withStateRetry`,
 * fires the side effect OUTSIDE the retry boundary, then commits
 * `merge.executed`. This reducer's `preflight → requested → executed`
 * transition is the projection's view of that split: the projection sees
 * intent before outcome, never one without the other (after Wave 4 migrates
 * the call sites — preview.2 still allows legacy `preflight → executed`
 * sequences for streams predating the migration).
 *
 * ## Naming note (#1306 rename tracker)
 *
 * Preview.2 ships `merge.rollback` (the canonical name in this worktree's
 * `event-store/schemas.ts`); #1306 will rename it to `merge.recovered` in a
 * follow-up epic. The reducer handles whichever name is registered; the
 * projection state captures the outcome (`recovering` phase) identically
 * regardless of which event type fired the transition.
 */

/**
 * Lifecycle phase for a merge on the feature stream.
 *
 * - `idle`        — initial; no merge activity observed yet.
 * - `preflight`   — `merge.preflight` was folded; the gate ran (passed or
 *                   failed; consult `preflight.passed` for the verdict).
 * - `requested`   — `merge.requested` was folded; durable intent is recorded.
 *                   This is the audit §F1.2 phase: the side effect has NOT
 *                   yet fired. Wave 4's Phase B reads this state.
 * - `executed`    — `merge.executed` was folded; the merge has been performed
 *                   on the target branch (mergeSha is durable).
 * - `recovering`  — `merge.rollback` (or post-#1306 `merge.recovered`) was
 *                   folded; rollback is in flight or completed.
 * - `completed`   — `merge.completed` was folded; the orchestrator has
 *                   formally terminated the lifecycle. Terminal phase.
 */
export type MergeOrchestratorPhase =
  | 'idle'
  | 'preflight'
  | 'requested'
  | 'executed'
  | 'recovering'
  | 'completed';

/**
 * Preflight gate metadata captured from `merge.preflight`. Reflects the
 * outcome of the pre-merge guard run (ancestry, branch protection, worktree
 * cleanliness, drift). Failure reasons surface the operator-facing diagnostic
 * the preflight subroutine produced.
 */
export interface MergePreflightMetadata {
  /** True iff every preflight sub-check passed. */
  readonly passed: boolean;
  /**
   * Operator-facing failure description (e.g., the `describePreflightFailure`
   * output). Absent on `passed === true`; present otherwise.
   */
  readonly reason?: string;
}

/**
 * Merge action metadata captured across the `requested → executed` split.
 *
 * Fields appear progressively as events fold:
 *
 *   - `taskId`, `sourceBranch`, `targetBranch`, `strategy` are first set on
 *     `merge.requested` (Wave 4) OR `merge.executed` (legacy / preview.1).
 *   - `mergeSha`, `rollbackSha` are first set on `merge.executed`.
 *
 * All fields are `readonly` on `MergeOrchestratorState`; mutation only occurs
 * via a fresh reducer output (DR-1 purity contract).
 */
export interface MergeActionMetadata {
  /** Originating task id (matches `task.completed.taskId` for the worktree). */
  readonly taskId?: string;
  /** Feature/work branch being merged in. */
  readonly sourceBranch?: string;
  /** Target branch the merge lands on. */
  readonly targetBranch?: string;
  /** Operator-selected strategy (Wave 4's `merge.requested` carries this). */
  readonly strategy?: 'squash' | 'rebase' | 'merge';
  /** Pull-request number (Wave 4 only; preview.2 may have no PR yet). */
  readonly prNumber?: number;
  /** Resulting commit sha on the target branch (set on `merge.executed`). */
  readonly mergeSha?: string;
  /**
   * Parent commit captured prior to the merge so a rollback can
   * `git reset --hard <rollbackSha>` deterministically.
   */
  readonly rollbackSha?: string;
}

/**
 * Recovery context captured from `merge.rollback` (or post-#1306 `merge.recovered`).
 *
 * `reason` is a closed enum on the event-store schema (`merge-failed` /
 * `verification-failed` / `timeout`); we widen to `string` here so that the
 * #1306 rename can extend the enum without re-shaping the projection's state
 * type. `error` is the rollback-side failure detail when `git reset --hard`
 * itself fell over (presence signals an indeterminate worktree).
 */
export interface MergeRecoveryContext {
  /** Cause of the rollback (e.g., `'merge-failed'`, `'verification-failed'`). */
  readonly reason?: string;
  /** Rollback-side error detail when `git reset --hard` itself failed. */
  readonly error?: string;
}

/**
 * Per-feature-stream projection state for `merge-orchestrator@v1`.
 *
 * Folded by {@link mergeOrchestratorReducer} over the `merge.*` event family.
 * `phase` is the discriminator; the metadata sub-records (`preflight`,
 * `merge`, `recovery`) are populated as the corresponding events fold and
 * preserved across subsequent transitions (a `merge.executed` does not blank
 * out the preflight outcome — observability replay needs both).
 *
 * `projectionSequence` is the standard monotonic counter (DR-3 contract): it
 * increments exactly once per *handled* event, so downstream consumers (snapshot
 * cadence, fingerprint comparisons) can detect "did anything change" without
 * deep equality.
 */
export interface MergeOrchestratorState {
  /**
   * Monotonic counter — bumped once per handled `merge.*` event. Unhandled
   * event types (or events the reducer treats as no-ops) leave this unchanged
   * so the counter tracks truth-of-handled-events, not truth-of-stream.
   */
  readonly projectionSequence: number;
  /** Current lifecycle phase; see {@link MergeOrchestratorPhase}. */
  readonly phase: MergeOrchestratorPhase;
  /** Preflight gate metadata; populated on `merge.preflight`. */
  readonly preflight?: MergePreflightMetadata;
  /** Merge action metadata; populated across `merge.requested` + `merge.executed`. */
  readonly merge?: MergeActionMetadata;
  /** Recovery context; populated on `merge.rollback` / `merge.recovered`. */
  readonly recovery?: MergeRecoveryContext;
}

/**
 * Canonical initial state for `merge-orchestrator@v1`. Folding the reducer over
 * an empty event stream MUST yield this value (DR-1 reducer contract).
 *
 * Exported so tests can compare against the canonical value rather than
 * re-declaring an identical literal.
 */
export const initialMergeOrchestratorState: MergeOrchestratorState = {
  projectionSequence: 0,
  phase: 'idle',
};
