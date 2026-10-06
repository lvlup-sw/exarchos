/**
 * Input and receipt types for `settle`. It takes a compiled capsule and one batch of claims, not a
 * workflow id. The capsule carries the terms that compile time pinned. The receipt returns on every
 * outcome, a refusal included, because a refused batch tells the caller which claim to fix.
 */

import type { BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { SettlementFinding, SettlementCensus, SettlementOutcome } from './adjudicate.js';

/** The settlement key: which compilation, and which batch of it. */
export interface SettledCapsuleIdentity {
  readonly workflowId: string;
  readonly definitionVersion: string;
  readonly designVersion: string;
  readonly capsuleVersion: number;
  readonly batchId: string;
}

/**
 * How the verification of one accepted claim ran. `operationId` names the task-completion segment,
 * so a caller can read its receipt through `execute_intent`. It is absent when the stream already
 * showed the task complete. `bundleRefs` is the run bundle of a segment that committed a record.
 */
export interface SettlementVerificationTrace {
  readonly taskId: string;
  readonly outcome: 'verified' | 'already-complete' | 'failed';
  readonly operationId?: string;
  readonly failedLeaf?: string;
  readonly message?: string;
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
}

/** A decision a settlement round carries for one deviation the batch waits on. */
export interface SettlementDecision {
  readonly deviationId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly actor: string;
  readonly rationale: string;
}

/**
 * The most deviations that one submitted batch carries. The bound is on the request only. A stored
 * batch has no bound, so a batch held by an earlier build still decodes.
 */
export const MAX_DEVIATIONS_PER_BATCH = 16;

/** The most affected tasks that one submitted deviation names. The bound is on the request only. */
export const MAX_AFFECTED_TASKS_PER_DEVIATION = 32;

/**
 * A deviation a held batch waits on, named on the receipt for the decision to answer.
 * `affectedTasks` is present when the deviation names tasks. The proposed change is not here: it
 * stays in the settlement bundle.
 */
export interface PendingDeviation {
  readonly deviationId: string;
  readonly deviationKind: string;
  readonly statement: string;
  readonly affectedTasks?: readonly string[];
}

/**
 * The design revision that a decision round recorded, as its receipt names it. The two versions
 * and the deviation ids are those of the `design.revised` row. The affected tasks stay on the row.
 */
export interface SettlementDesignRevision {
  readonly priorDesignVersion: number;
  readonly nextDesignVersion: number;
  readonly deviationIds: readonly string[];
}

/** What one `settle` call returns, on every outcome. */
export interface SettlementReceipt {
  readonly operationId: string;
  readonly streamId: string;
  readonly capsule: SettledCapsuleIdentity;
  readonly outcome: SettlementOutcome;
  readonly acceptedTasks: readonly string[];
  readonly findings: readonly SettlementFinding[];
  readonly adjudicated: SettlementCensus;
  readonly requestDigest: string;
  readonly tailSequence: number;
  /**
   * How each accepted claim was verified. It is empty when adjudication refused or held the batch
   * before verification. It is optional for the same reason as `bundleRefs`.
   */
  readonly verification?: readonly SettlementVerificationTrace[];
  /**
   * Every fresh settlement stamps it, but it stays optional. A replay returns the receipt stored in
   * the operation claim, and a claim from an older build does not carry the field.
   */
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
  /**
   * Which settlement round of the batch this is: 0 for the round that
   * submitted it, 1 for the round that decided its held deviations. Optional
   * for the reason `bundleRefs` is.
   */
  readonly round?: number;
  /** On a held batch: what the decision round has to decide, by id. */
  readonly pendingDeviations?: readonly PendingDeviation[];
  /** On a decision round: the decisions it recorded. */
  readonly decisions?: readonly SettlementDecision[];
  /**
   * On a decision round that accepted a material deviation: the design revision it recorded. It is
   * present exactly when the round committed a `design.revised` row, whatever the outcome.
   */
  readonly designRevision?: SettlementDesignRevision;
}
