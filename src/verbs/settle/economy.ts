/**
 * The response budget of `settle`.
 * The structural half of a receipt is small and fixed, but `findings` grows with the number of defects in the batch.
 * A settled batch of a dozen tasks with no findings is about 900 bytes, or about 225 estimated tokens.
 * Each finding adds about 150 bytes.
 * The budget is more than twice the settled shape, so a few findings show in full before the reducer pages.
 */

import { SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const SETTLE_ECONOMY_BUDGET_TOKENS = 1000;

/**
 * The shape of the capped receipt. It is declared, not inferred, so each field that a caller needs is a compile-time obligation of the reducer.
 */
export interface SettlementReceiptSummary {
  readonly summary: string;
  readonly counts: {
    readonly findings: number;
    readonly shown: number;
    readonly acceptedTasks: number;
  };
  readonly firstPage: ReadonlyArray<{
    readonly kind: unknown;
    readonly subject: unknown;
    readonly at: unknown;
  }>;
  readonly operationId: unknown;
  readonly outcome: unknown;
  readonly capsule: unknown;
  readonly adjudicated: unknown;
  readonly tailSequence: unknown;
  /**
   * How each accepted claim was verified, kept whole.
   * A caller of a rejected batch needs the operation id of the halted segment to read its receipt.
   * The task count of the batch bounds the list.
   */
  readonly verification: unknown;
  /** The custody reference survives the cap: it is the only pointer to the interior. */
  readonly bundleRefs: unknown;
}

/**
 * Page the findings and keep everything a caller needs to act.
 *
 * `adjudicated` stays whole, because the census tells zero findings apart from the first page of many.
 * The fields after `firstPage` pass through `CappedDataSchema`, which is `.passthrough()`.
 * The full findings stay in the referenced bundle.
 */
export function summarizeSettlementReceipt(data: unknown): SettlementReceiptSummary {
  const receipt = data as {
    readonly operationId?: unknown;
    readonly outcome?: unknown;
    readonly capsule?: { readonly batchId?: unknown; readonly capsuleVersion?: unknown };
    readonly adjudicated?: unknown;
    readonly tailSequence?: unknown;
    readonly verification?: unknown;
    readonly bundleRefs?: unknown;
    readonly acceptedTasks?: ReadonlyArray<unknown>;
    readonly findings?: ReadonlyArray<{
      readonly kind?: unknown;
      readonly subject?: unknown;
      readonly at?: unknown;
    }>;
  };
  const findings = Array.isArray(receipt.findings) ? receipt.findings : [];
  const accepted = Array.isArray(receipt.acceptedTasks) ? receipt.acceptedTasks : [];
  const firstPage = findings.slice(0, SUMMARY_FIRST_PAGE_ITEMS).map((finding) => ({
    kind: finding.kind,
    subject: finding.subject,
    at: finding.at,
  }));
  return {
    summary:
      `batch '${String(receipt.capsule?.batchId)}' of capsule v${String(receipt.capsule?.capsuleVersion)} ` +
      `${String(receipt.outcome)} — ${accepted.length} task(s) accepted, ${findings.length} finding(s)` +
      (findings.length > firstPage.length ? `; ${firstPage.length} shown` : ''),
    counts: { findings: findings.length, shown: firstPage.length, acceptedTasks: accepted.length },
    firstPage,
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    capsule: receipt.capsule,
    adjudicated: receipt.adjudicated,
    tailSequence: receipt.tailSequence,
    verification: receipt.verification,
    bundleRefs: receipt.bundleRefs,
  };
}
