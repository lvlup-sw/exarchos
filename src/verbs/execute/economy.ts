// ─── Response-economy declaration for `execute_intent` ──────────────────────
//
// A measured budget, not the registry-wide default. Three intents ship —
// `task-completion` (five leaves), `quality-evaluation` (five) and
// `plan-closeout` (three) — and the budget is measured against the largest of
// them: a five-leaf receipt carrying two events per gate leaf serializes to
// ~1,200 bytes / ~300 estimated tokens (`estimateOutputTokens`, byte length
// over 4). `EXECUTE_INTENT_ECONOMY_BUDGET_TOKENS` sits at roughly three times
// that measured shape — enough headroom for a failure receipt's longer refusal
// message or a runbook with a few more leaves without tripping the cap on
// ordinary use, while still bounding a genuinely oversized response instead of
// inheriting the registry-wide default unmeasured.

import { SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const EXECUTE_INTENT_ECONOMY_BUDGET_TOKENS = 1000;

/**
 * The fields a capped response must keep regardless of budget: the four the
 * caller needs to know what happened without the full per-leaf detail —
 * `operationId` to correlate, `outcome` and `failedLeaf` to know what
 * happened, `tailSequence` to keep querying the log from where this call left
 * off. Declared as a reducer (not the generic list fallback) because the
 * receipt's payload is NOT list-dominant — `leaves` is one property among
 * several structural fields — so the generic fallback would fail open rather
 * than cap it (`response-economy.ts`'s list-dominance guard).
 */
/**
 * A reducer that mapped EVERY leaf into `firstPage` was not a reducer: a
 * segment with a hundred-odd leaves summarized to well over the budget above,
 * so the cap declared a ceiling its own reducer could not hold to. A page is a
 * page — `counts` says how much was not shown, and the leaves themselves stay
 * retrievable from the log by the derived per-leaf operation id.
 *
 * The page size is the registry-wide one rather than a local number, so this
 * reducer pages the way every generic capped response does.
 */
export function summarizeIntentReceipt(data: unknown): unknown {
  const receipt = data as {
    readonly operationId?: unknown;
    readonly intent?: unknown;
    readonly outcome?: unknown;
    readonly failedLeaf?: unknown;
    readonly tailSequence?: unknown;
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
    // Pinned outside the capped shape's `summary`/`counts`/`firstPage` fields —
    // `CappedDataSchema` is `.passthrough()`, so these ride alongside them
    // rather than being lost to the cap.
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    failedLeaf: receipt.failedLeaf,
    tailSequence: receipt.tailSequence,
  };
}
