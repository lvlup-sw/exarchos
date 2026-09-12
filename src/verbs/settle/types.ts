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
   * Optional even though every fresh settlement stamps it: a replay returns the
   * receipt persisted in the operation claim, and requiring the field would
   * turn a claim written by an older build into an adapter-level error.
   */
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
}
