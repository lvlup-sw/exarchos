// ─── What `prepare` refuses, and what it hands back ──────────────────────────
//
// Every refusal happens before any effect. A compilation that cannot produce a
// sound capsule writes nothing: no bytes into custody, no prepared record, no
// claim. The codes separate the questions a caller has to answer differently —
// "there is no such workflow", "this workflow cannot be compiled yet", and "the
// plan itself is unsound" are three different repairs.

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
  /** A planned task id is not a stable id a capsule can name. */
  'INVALID_TASK_ID',
  /** A task waits on a task the plan does not contain. */
  'UNKNOWN_DEPENDENCY',
  /** The compiled capsule does not validate — a cyclic plan, or a compiler defect. */
  'CAPSULE_UNSOUND',
] as const;

export type PrepareRefusalCode = (typeof PREPARE_REFUSAL_CODES)[number];

export interface PrepareRefusal {
  readonly code: PrepareRefusalCode;
  readonly message: string;
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
   * Optional for the reason the settlement receipt's is: a replay returns the
   * receipt persisted in the claim, and a claim written by an older build must
   * not become an adapter-level error.
   */
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
}
