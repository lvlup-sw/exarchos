// ─── What `settle` takes and what it hands back ──────────────────────────────
//
// `settle` takes a COMPILED capsule and one batch of claims. It does not take a
// workflow id and go looking for terms: the capsule carries the terms, pinned
// at compile time, and adjudicating against anything else would defeat the
// point of pinning them. The harness that ran the work is the one holding the
// capsule it ran under.
//
// The receipt is the verdict plus the identity of what was settled. It is
// returned on EVERY outcome, including a refusal, because a refused batch is
// the caller's next input — it says which claim to fix — and an action that
// answered a refusal with an error would make the reasons the caller's problem
// to reconstruct.

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
 * How one accepted claim's verification ran, as the settlement records it.
 *
 * `operationId` names the task-completion segment the task ran under, so a
 * caller can read that segment's own receipt back through `execute_intent`;
 * it is absent for a task the stream already showed complete, where nothing
 * ran. `bundleRefs` is the segment's run bundle, present when a segment ran
 * and committed a record.
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

/** A deviation a held batch waits on, named on the receipt for the decision to answer. */
export interface PendingDeviation {
  readonly deviationId: string;
  readonly deviationKind: string;
  readonly statement: string;
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
   * How each accepted claim was verified. Empty on a batch adjudication
   * refused or held before verification ran; optional for the reason
   * `bundleRefs` is — a receipt replayed from a claim an older build wrote
   * carries none.
   */
  readonly verification?: readonly SettlementVerificationTrace[];
  /**
   * Optional even though every fresh settlement stamps it: a replay returns the
   * receipt persisted in the operation claim, and requiring the field would
   * turn a claim written by an older build into an adapter-level error.
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
}
