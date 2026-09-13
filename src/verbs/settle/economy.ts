// ─── Response-economy declaration for `settle` ───────────────────────────────
//
// A measured budget, not the registry-wide default, and the thing being bounded
// here is different from the executor's. A receipt's structural half is small
// and fixed — the capsule identity, the outcome, the census, two digests, and
// the accepted task ids — while `findings` grows with how badly the batch went.
// That is exactly the axis a budget has to bound: an action whose response size
// is a function of how much went wrong hands its worst answer to the caller
// least able to afford it.
//
// The measured shape: a settled batch of a dozen tasks with no findings
// serializes to roughly 900 bytes / ~225 estimated tokens (`estimateOutputTokens`,
// byte length over 4). A rejected batch carries one finding per defect, each
// with a path and a sentence, at roughly 150 bytes apiece. The budget sits at
// well over twice the settled shape — room for a handful of findings in full
// before the reducer pages — while still bounding a batch that produced dozens.

import { SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const SETTLE_ECONOMY_BUDGET_TOKENS = 1000;

/**
 * The capped receipt's shape. Declared rather than inferred so the fields a
 * caller needs in order to act on the verdict are a compile-time obligation of
 * this reducer: a field added to the receipt and forgotten here is a type
 * error, not a silently narrower response.
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
  /** The custody reference survives the cap: it is the only pointer to the interior. */
  readonly bundleRefs: unknown;
}

/**
 * Page the findings and keep everything a caller needs to act.
 *
 * `adjudicated` is pinned rather than paged for the reason the record itself
 * carries it: a capped response showing zero findings and a capped response
 * showing the first five of forty must not read the same, and the census is
 * what separates them once the list is cut. The findings themselves stay
 * retrievable in full from the referenced bundle.
 */
export function summarizeSettlementReceipt(data: unknown): SettlementReceiptSummary {
  const receipt = data as {
    readonly operationId?: unknown;
    readonly outcome?: unknown;
    readonly capsule?: { readonly batchId?: unknown; readonly capsuleVersion?: unknown };
    readonly adjudicated?: unknown;
    readonly tailSequence?: unknown;
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
    // Pinned outside the capped shape's `summary`/`counts`/`firstPage` fields —
    // `CappedDataSchema` is `.passthrough()`, so these ride alongside them
    // rather than being lost to the cap.
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    capsule: receipt.capsule,
    adjudicated: receipt.adjudicated,
    tailSequence: receipt.tailSequence,
    bundleRefs: receipt.bundleRefs,
  };
}
