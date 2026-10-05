/**
 * `merge-orchestrator@v1` projection state: the merge lifecycle of one feature stream, as a fold over `merge.*` events.
 *
 * The expected event order gives these phases:
 * - idle -> preflight (merge.preflight)
 * - preflight -> requested (merge.requested) -> executed (merge.executed) -> completed (merge.completed)
 * - preflight -> executed (merge.executed), for old streams with no merge.requested
 * - any phase -> recovering (merge.recovered, or the retired merge.rollback)
 *
 * The reducer does not check the order. Each event sets its own phase.
 * `requested` is the durable intent, recorded before a side effect that is not idempotent, such as the GitHub merge API.
 */

/**
 * Lifecycle phase of a merge on the feature stream.
 * - `idle`: no merge event folded yet.
 * - `preflight`: the gate ran. `preflight.passed` holds the verdict.
 * - `requested`: the intent is durable, and the merge side effect did not run yet.
 * - `executed`: the merge is on the target branch.
 * - `recovering`: a recovery event folded.
 * - `completed`: the terminal phase.
 */
export type MergeOrchestratorPhase =
  | 'idle'
  | 'preflight'
  | 'requested'
  | 'executed'
  | 'recovering'
  | 'completed';

/** Outcome of the pre-merge gate, from `merge.preflight`. */
export interface MergePreflightMetadata {
  /** True when every preflight sub-check passed. */
  readonly passed: boolean;
  /** Failure description for the operator. It is absent when `passed` is true. */
  readonly reason?: string;
}

/**
 * Merge fields that the merge events set.
 * A later event overwrites each field that it has and keeps the others.
 */
export interface MergeActionMetadata {
  /** Originating task id (matches `task.completed.taskId` for the worktree). */
  readonly taskId?: string;
  /** Feature/work branch being merged in. */
  readonly sourceBranch?: string;
  /** Target branch the merge lands on. */
  readonly targetBranch?: string;
  /** Merge strategy that the operator selected. */
  readonly strategy?: 'squash' | 'rebase' | 'merge';
  /** Pull-request number, when a pull request exists. */
  readonly prNumber?: number;
  /** Resulting commit sha on the target branch (set on `merge.executed`). */
  readonly mergeSha?: string;
  /**
   * Parent commit recorded before the merge. Recovery runs `git merge --abort`,
   * then `git reset --keep <rollbackSha>`, and never `--hard`.
   */
  readonly rollbackSha?: string;
}

/**
 * Recovery context from `merge.recovered` or the retired `merge.rollback`.
 * The event schema gives `reason` a closed enum, and this type widens it to `string`.
 * `recoveryError` is absent on a clean recovery.
 */
export interface MergeRecoveryContext {
  /** Cause of the rollback, for example `'merge-failed'`. */
  readonly reason?: string;
  /**
   * Recovery outcome of an indeterminate worktree, as a closed enum so that consumers do not parse prose.
   * `reset-keep-blocked`: `git reset --keep` refused to discard local work.
   * `reset-failed`: the reset failed.
   * `unexpected-mid-merge-drift`: HEAD is not the anchor after recovery.
   */
  readonly recoveryError?:
    | 'reset-keep-blocked'
    | 'reset-failed'
    | 'unexpected-mid-merge-drift';
  /** Failure detail from the `rollbackError` field of the event, for triage only. */
  readonly error?: string;
}

/**
 * Projection state of `merge-orchestrator@v1` for one feature stream.
 * `phase` is the discriminator. Each metadata sub-record stays across later transitions.
 */
export interface MergeOrchestratorState {
  /** Increments once for each handled `merge.*` event. Other event types leave it unchanged. */
  readonly projectionSequence: number;
  /** Current lifecycle phase. */
  readonly phase: MergeOrchestratorPhase;
  /** Preflight gate metadata from `merge.preflight`. */
  readonly preflight?: MergePreflightMetadata | undefined;
  /** Merge metadata. `merge.preflight`, `merge.requested` and `merge.executed` set it. */
  readonly merge?: MergeActionMetadata | undefined;
  /** Recovery context from `merge.recovered` or `merge.rollback`. */
  readonly recovery?: MergeRecoveryContext | undefined;
}

/** Initial state of `merge-orchestrator@v1`. A fold over an empty stream returns this value. */
export const initialMergeOrchestratorState: MergeOrchestratorState = {
  projectionSequence: 0,
  phase: 'idle',
};
