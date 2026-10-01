/**
 * Response-economy declaration for `execute_intent`.
 * The budget is measured, not the registry default. A five-leaf receipt with two events for
 * each gate leaf serializes to about 375 estimated tokens. The budget is more than twice that
 * value, so a longer refusal message or a few more leaves stay under the cap.
 */

import { SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const EXECUTE_INTENT_ECONOMY_BUDGET_TOKENS = 1000;

/** The capped receipt shape. As the declared return type, it makes each field a compile-time obligation of the reducer. */
export interface IntentReceiptSummary {
  readonly summary: string;
  readonly counts: { readonly leaves: number; readonly shown: number; readonly total: number };
  readonly firstPage: ReadonlyArray<{
    readonly action: unknown;
    readonly status: unknown;
    readonly eventCount: number;
  }>;
  readonly operationId: unknown;
  readonly outcome: unknown;
  readonly failedLeaf: unknown;
  readonly tailSequence: unknown;
  /** The custody reference survives the cap: it is the only pointer to the run's interior. */
  readonly bundleRefs: unknown;
}

/**
 * Reduces an intent receipt to a capped summary. The receipt is not list-dominant, so the
 * generic list fallback fails open on it. The first page uses the registry page size, and
 * `counts` reports the omitted leaves. `operationId`, `outcome`, `failedLeaf`, `tailSequence`
 * and `bundleRefs` stay, because `CappedDataSchema` is `.passthrough()`.
 */
export function summarizeIntentReceipt(data: unknown): IntentReceiptSummary {
  const receipt = data as {
    readonly operationId?: unknown;
    readonly intent?: unknown;
    readonly outcome?: unknown;
    readonly failedLeaf?: unknown;
    readonly tailSequence?: unknown;
    readonly bundleRefs?: unknown;
    readonly leaves?: ReadonlyArray<{ readonly action?: unknown; readonly status?: unknown; readonly events?: ReadonlyArray<unknown> }>;
  };
  const leaves = Array.isArray(receipt.leaves) ? receipt.leaves : [];
  const firstPage = leaves.slice(0, SUMMARY_FIRST_PAGE_ITEMS).map((leaf) => ({
    action: leaf.action,
    status: leaf.status,
    eventCount: Array.isArray(leaf.events) ? leaf.events.length : 0,
  }));
  return {
    summary:
      `intent '${String(receipt.intent)}' ${String(receipt.outcome)}` +
      (receipt.failedLeaf !== undefined ? ` at leaf '${String(receipt.failedLeaf)}'` : '') +
      ` across ${leaves.length} leaf(ves)` +
      (leaves.length > firstPage.length ? `; ${firstPage.length} shown` : ''),
    counts: { leaves: leaves.length, shown: firstPage.length, total: leaves.length },
    firstPage,
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    failedLeaf: receipt.failedLeaf,
    tailSequence: receipt.tailSequence,
    bundleRefs: receipt.bundleRefs,
  };
}
