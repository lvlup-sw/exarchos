/**
 * The shared response-economy kit for dispatch paths. A consumer applies two guards in order:
 *   1. A deterministic item cap when the caller omits `limit`.
 *   2. A measured-size summary. If the capped payload is still over
 *      `qualityHints.outputTokenThreshold`, the consumer returns counts by group and a small first
 *      page instead of each item.
 *
 * The guard fails open. If the threshold does not resolve to a finite positive number, only the
 * item cap applies.
 */

import { getQualityHintThreshold, type QualityHintsConfig } from '../../workflow/capabilities/resolver.js';
import type { NextAction } from '../../next-action.js';

/** The default item cap when the caller omits `limit`. */
export const DEFAULT_VIEW_ITEM_CAP = 50;

/**
 * The default window of the `pipeline` view. That view is read most often and its entries are
 * large, so its default is smaller than {@link DEFAULT_VIEW_ITEM_CAP}. An explicit `limit` overrides it.
 */
export const PIPELINE_DEFAULT_ITEM_CAP = 10;

/** How many detail rows the measured-size summary keeps as its first page. */
export const SUMMARY_FIRST_PAGE_ITEMS = 10;

/**
 * Estimate output tokens as `Math.ceil(byteLength / 4)` over `JSON.stringify(payload)`. It must stay
 * the same as the estimate in `projections/telemetry/middleware.ts`, so both agree on the threshold.
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
 * Resolve the output-token threshold, and fail open. It returns `null` when the threshold is not a
 * finite positive number or the resolver throws. The caller then uses only the item cap.
 */
export function resolveOutputTokenThreshold(config?: QualityHintsConfig): number | null {
  try {
    const threshold = getQualityHintThreshold('output_tokens', config);
    return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
  } catch {
    return null;
  }
}

/** Count each derived key across `items`, for the summary group counts. */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/**
 * The next action after the summary cut the output of an action that takes no `limit` and no
 * `offset`. The reason names the read that serves the rest, when the action declares one.
 * With no narrowing hint, a second call returns the same summary, and the reason says so.
 * A hint such as `--fields` narrows the next call, so the reason then makes no such claim.
 * `verb` is the name of the action itself.
 */
export function detailAffordance(
  verb: string,
  shown: number,
  total: number,
  detailRead?: string,
  cliHint?: string,
): NextAction {
  return {
    verb,
    reason:
      `Showing ${shown} of ${total}. ${verb} takes no limit or offset` +
      (cliHint !== undefined ? '.' : ', so a second call returns the same summary.') +
      (detailRead !== undefined ? ` ${detailRead}` : ''),
    ...(cliHint !== undefined ? { hint: cliHint } : {}),
  };
}

/**
 * The window parameters that the input of a paging action declares. Each value is also the text
 * of the reason. Only an input that declares `offset` can page.
 */
export type PagingWindow = 'limit/offset' | 'offset';

/**
 * The next action that tells the caller to narrow the query, after the item cap or the summary cut
 * the output. `verb` is the name of the action itself. `window` names the window parameters that
 * the input declares, and it must include `offset`. The CLI hint is added only when the caller
 * gives one, because a `.strict()` action rejects an undeclared flag.
 */
export function narrowAffordance(
  verb: string,
  shown: number,
  total: number,
  cliHint?: string,
  window: PagingWindow = 'limit/offset',
): NextAction {
  return {
    verb,
    reason: `Showing ${shown} of ${total} — narrow with ${window} (or a filter) to page through the rest.`,
    ...(cliHint !== undefined ? { hint: cliHint } : {}),
  };
}

/**
 * The next action after the cap cut the output of an action that takes `limit` and no `offset`.
 * A larger `limit` is capped again, so the call cannot page to the rest, and the reason says so.
 * The reason names the read that serves the rest, when the action declares one. A `--limit` hint
 * gives fewer items in full detail.
 */
export function limitOnlyAffordance(
  verb: string,
  shown: number,
  total: number,
  detailRead?: string,
  cliHint?: string,
): NextAction {
  return {
    verb,
    reason:
      `Showing ${shown} of ${total}. ${verb} takes limit and no offset, so it cannot page to the rest.` +
      (detailRead !== undefined ? ` ${detailRead}` : ''),
    ...(cliHint !== undefined ? { hint: cliHint } : {}),
  };
}
