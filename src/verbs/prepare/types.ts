/**
 * The refusal codes of `prepare` and the receipt it returns.
 * Each refusal occurs before any effect, so a refused compilation writes nothing.
 */

import type { ExarchosCapsuleV1 } from '../../contract/capsule/exarchos-capsule.js';
import type { BundleRefV1 } from '../../events/bundle/digest-references.js';

export const PREPARE_REFUSAL_CODES = [
  /** No workflow is recorded for the subject. */
  'WORKFLOW_NOT_FOUND',
  /** The workflow type has no definition this compiler can lower. */
  'WORKFLOW_TYPE_UNSUPPORTED',
  /** The workflow is not in a phase whose work this compiler knows how to batch. */
  'PHASE_NOT_PREPARABLE',
  /** Every planned task is already complete, so there is no batch to compile. */
  'NOTHING_TO_PREPARE',
  /** Tasks are pending, but each waits on a task that is not complete. */
  'NO_READY_TASKS',
  /** The workflow records no integration branch, so no task has a base to be measured against. */
  'BASE_UNRESOLVED',
  /** A planned task id is not a stable id a capsule can name. */
  'INVALID_TASK_ID',
  /** A task waits on a task the plan does not contain. */
  'UNKNOWN_DEPENDENCY',
  /** A planner stamp on a task — its risk tier or boundary flag — is outside its vocabulary. */
  'INVALID_TASK_STAMP',
  /** The compiled capsule does not validate — a cyclic plan, or a compiler defect. */
  'CAPSULE_UNSOUND',
  /** The calling runtime lacks a capability the batch's execution profile requires. */
  'RUNTIME_UNFIT',
  /** The settlement bundle of a bound design revision cannot be read, or it lacks an accepted change that the row names. */
  'REVISION_UNREADABLE',
] as const;

export type PrepareRefusalCode = (typeof PREPARE_REFUSAL_CODES)[number];

export interface PrepareRefusal {
  readonly code: PrepareRefusalCode;
  readonly message: string;
}

/**
 * The recompile that a continuation prepare recorded, as its receipt names it. The versions and
 * the two task lists are those of the `capsule.recompiled` row. The capsule that the receipt
 * carries is the recompiled one.
 */
export interface PreparedRecompile {
  /** The capsule version of the latest prepared record before this prepare. */
  readonly priorCapsuleVersion: number;
  /** The design version before the first revision that this prepare is the continuation of. */
  readonly priorDesignVersion: number;
  /** The design version after the last of those revisions. The capsule is compiled under it. */
  readonly nextDesignVersion: number;
  /** The tasks that those revisions name, each one once, sorted. */
  readonly declaredTasks: readonly string[];
  /** The unfinished tasks that the change reaches, in plan order. A later prepare compiles each one that is not ready. */
  readonly invalidatedTasks: readonly string[];
}

/** What one `prepare` call returns: the capsule, and how to find it again. */
export interface PreparedCapsuleReceipt {
  readonly operationId: string;
  readonly streamId: string;
  readonly workflowId: string;
  readonly capsuleVersion: number;
  /** The capsule's content address. Settlement refuses a capsule that does not match it. */
  readonly capsuleDigest: string;
  readonly definitionVersion: string;
  readonly capsule: ExarchosCapsuleV1;
  readonly tailSequence: number;
  /**
   * Optional because a replay returns the receipt stored in the claim.
   * A claim that an older build wrote must not become an adapter error.
   */
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
  /**
   * On the first prepare after a design revision: the recompile that it recorded. It is present
   * exactly when the commit of this capsule held a `capsule.recompiled` row. A replay repeats it.
   */
  readonly recompile?: PreparedRecompile;
}
