// ─── Shared response-economy kit (DR-1) ──────────────────────────────────────
//
// Generalized out of `projections/views/output-cap.ts` (DR-3): the deterministic
// output-cap + measured-size-summary primitives now live in the shared core so
// every dispatch path — not just the two inventory views — can reuse them. The
// `pipeline` (`projections/views/tools.ts`) and `worktrees`
// (`verbs/worktree/handlers.ts`) views are the first consumers, unchanged
// in behavior; `projections/views/output-cap.ts` remains as a re-export shim.
//
// Two guards, applied in order by a consumer:
//
//   1. A DETERMINISTIC item-count cap when the caller omits `limit`, so a large
//      inventory never dumps every row.
//   2. A MEASURED-size summary: if the capped payload's serialized size —
//      estimated the SAME way the telemetry middleware does (`Math.ceil(bytes/4)`,
//      `projections/telemetry/middleware.ts`) — still exceeds the resolved
//      `qualityHints.outputTokenThreshold`, return a counts-by-group summary
//      (plus a small first page) instead of per-item detail.
//
// Fail-open on presentation (DR-3): a threshold that cannot be resolved to a
// finite positive number degrades to the item cap — never an unbounded dump,
// never an inventory-hiding error.
// ─────────────────────────────────────────────────────────────────────────────

import { getQualityHintThreshold, type QualityHintsConfig } from '../../runtime/capabilities/resolver.js';
import type { NextAction } from '../../next-action.js';

/** Deterministic default item cap applied when the caller omits `limit`. */
export const DEFAULT_VIEW_ITEM_CAP = 50;

/**
 * DR-2 — pipeline-specific default window. The `pipeline` view is the highest-
 * traffic inventory read and its entries are token-heavy, so its no-`limit`
 * default is much smaller than the shared {@link DEFAULT_VIEW_ITEM_CAP} (which
 * the worktrees view keeps). An explicit `limit` overrides this.
 */
export const PIPELINE_DEFAULT_ITEM_CAP = 10;

/** How many detail rows the measured-size summary keeps as its first page. */
export const SUMMARY_FIRST_PAGE_ITEMS = 10;

/**
 * Estimate output tokens the SAME way the telemetry middleware does:
 * `Math.ceil(byteLength / 4)` over `JSON.stringify(payload)`. Kept byte-for-byte
 * identical to `projections/telemetry/middleware.ts` so the presentation guard and the D3
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
 * the action's own name) so it validates against `NextActionSchema`.
 *
 * DR-1: the `verb` type is any action name (`string`), not the former
 * `'pipeline' | 'worktrees'` union — every dispatch path can steer with a
 * narrow affordance, keyed on its own action name.
 */
export function narrowAffordance(
  verb: string,
  shown: number,
  total: number,
  cliHint?: string,
): NextAction {
  return {
    verb,
    reason: `Showing ${shown} of ${total} — narrow with limit/offset (or a filter) to page through the rest.`,
    // Only advertise a CLI flag when the caller actually has one. The
    // dispatch-core generic fallback omits it for actions whose schema declares
    // no windowing param (a `.strict()` action would reject `--limit`).
    ...(cliHint !== undefined ? { hint: cliHint } : {}),
  };
}
