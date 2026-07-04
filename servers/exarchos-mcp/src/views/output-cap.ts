// ─── Deterministic view output cap + measured-size summary (DR-3) ────────────
//
// Shared by the two inventory reads that can grow unbounded — `pipeline`
// (`views/tools.ts`) and `worktrees` (`orchestrate/worktree/handlers.ts`). Two
// guards, applied in order:
//
//   1. A DETERMINISTIC item-count cap when the caller omits `limit`, so a large
//      inventory never dumps every row.
//   2. A MEASURED-size summary: if the capped payload's serialized size —
//      estimated the SAME way the telemetry middleware does (`Math.ceil(bytes/4)`,
//      `telemetry/middleware.ts`) — still exceeds the resolved
//      `qualityHints.outputTokenThreshold`, return a counts-by-group summary
//      (plus a small first page) instead of per-item detail.
//
// Fail-open on presentation (DR-3): a threshold that cannot be resolved to a
// finite positive number degrades to the item cap — never an unbounded dump,
// never an inventory-hiding error.
// ─────────────────────────────────────────────────────────────────────────────

import { getQualityHintThreshold, type QualityHintsConfig } from '../capabilities/resolver.js';
import type { NextAction } from '../next-action.js';

/** Deterministic default item cap applied when the caller omits `limit`. */
export const DEFAULT_VIEW_ITEM_CAP = 50;

/** How many detail rows the measured-size summary keeps as its first page. */
export const SUMMARY_FIRST_PAGE_ITEMS = 10;

/**
 * Estimate output tokens the SAME way the telemetry middleware does:
 * `Math.ceil(byteLength / 4)` over `JSON.stringify(payload)`. Kept byte-for-byte
 * identical to `telemetry/middleware.ts` so the presentation guard and the D3
 * gate agree on what "over threshold" means.
 */
export function estimateOutputTokens(payload: unknown): number {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = '{}';
  }
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}

/**
 * Resolve the output-token threshold, FAIL-OPEN. Returns `null` when the
 * config yields a non-finite / non-positive threshold (or the resolver throws),
 * signalling the caller to degrade to the plain item cap — never a summary keyed
 * off a garbage threshold, and never an error that hides the inventory.
 */
export function resolveOutputTokenThreshold(config?: QualityHintsConfig): number | null {
  try {
    const threshold = getQualityHintThreshold('output_tokens', config);
    return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
  } catch {
    return null;
  }
}

/** Count occurrences of a derived key across `items` (summary group counts). */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/**
 * The narrow-your-query affordance surfaced on `next_actions[]` whenever the
 * default item cap truncated the inventory or the measured-size summary
 * replaced per-item detail. Uses the catch-all `NextAction` shape (verb =
 * the view's own name) so it validates against `NextActionSchema`.
 */
export function narrowAffordance(
  verb: 'pipeline' | 'worktrees',
  shown: number,
  total: number,
  cliHint: string,
): NextAction {
  return {
    verb,
    reason: `Showing ${shown} of ${total} — narrow with limit/offset (or a filter) to page through the rest.`,
    hint: cliHint,
  };
}
