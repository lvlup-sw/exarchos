/**
 * The response-economy seam: `enforceResponseEconomy` and its helpers, in a leaf module.
 * `dispatch.ts` imports and re-exports it, and `projections/telemetry/middleware.ts` imports it.
 * A leaf module breaks the runtime import cycle between those two modules, because this module
 * imports neither of them.
 * This module owns the runtime cap decision. Adapters only render.
 */

import type { ToolResult, EconomyMeta } from '../../format.js';
import {
  ECONOMY_META_TRUNCATED,
  ECONOMY_META_DEGRADED,
} from '../../format.js';
import { findActionInRegistry, resolveEconomyBudget, type ToolAction } from '../../registry.js';
import {
  detailAffordance,
  estimateOutputTokens,
  limitOnlyAffordance,
  narrowAffordance,
  SUMMARY_FIRST_PAGE_ITEMS,
} from './economy.js';
import type { NextAction } from '../../next-action.js';

/**
 * The envelope carrier fields that the economy guard must not drop. Budgets measure only `data`.
 * The guard replaces `data` and adds to `_meta` and `next_actions` without overwriting them.
 */
export const ECONOMY_CARRIER_KEYS: ReadonlySet<string> = new Set([
  'success',
  'error',
  'warnings',
  'next_actions',
  '_meta',
  '_perf',
  '_eventHints',
  '_corrections',
  '_cacheHints',
]);

/**
 * The share of a response's estimated tokens that its largest array must hold for the payload to be
 * list-dominant. Only a list-dominant payload gets the generic list fallback.
 * Below this share, the arrays are incidental to a structured object, and a slice destroys the content.
 * The value is well above the array share of a state document and well below an inventory (about 1.0).
 */
const ECONOMY_LIST_DOMINANCE_RATIO = 0.6;

/**
 * Extracts items for the generic capped fallback and the shown and total counts.
 * An array `data` is the item list. For an object `data`, the largest array property is the list.
 * Any other value gives an empty list.
 */
function extractCappableItems(data: unknown): { items: readonly unknown[]; total: number } {
  if (Array.isArray(data)) return { items: data, total: data.length };
  if (data !== null && typeof data === 'object') {
    let best: readonly unknown[] | undefined;
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value) && (best === undefined || value.length > best.length)) {
        best = value;
      }
    }
    if (best !== undefined) return { items: best, total: best.length };
  }
  return { items: [], total: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The top-level keys of the Zod input shape of the action. A schema with no shape gives no key. */
function inputKeysOf(action: { readonly schema?: unknown }): ReadonlySet<string> {
  const schema = action.schema;
  const shape: unknown = isRecord(schema) ? schema['shape'] : undefined;
  return isRecord(shape) ? new Set(Object.keys(shape)) : new Set<string>();
}

/**
 * Builds the CLI flag for the steering hint from the top-level input keys of the action.
 * `limit` comes first, then `offset`, then `fields`. With none of them it returns `undefined`.
 * A `.strict()` action rejects an undeclared flag, so a hint for it gives an `INVALID_INPUT` step.
 */
function economyNarrowHint(keys: ReadonlySet<string>, actionName: string): string | undefined {
  if (keys.has('limit')) return `${actionName} --limit ${SUMMARY_FIRST_PAGE_ITEMS}`;
  if (keys.has('offset')) return `${actionName} --offset <n>`;
  if (keys.has('fields')) return `${actionName} --fields <comma,separated>`;
  return undefined;
}

/**
 * The sentence of the fallback summary that names the keys the input declares among `limit`,
 * `offset` and `fields`. Only `offset` pages. With none of the keys, the sentence is empty.
 */
function narrowSentence(keys: ReadonlySet<string>): string {
  const declared = ['limit', 'offset', 'fields'].filter((key) => keys.has(key));
  if (declared.length === 0) return '';
  const effect = keys.has('offset') ? 'page the detail' : 'read less detail';
  return ` Narrow with ${declared.join(' / ')} to ${effect}.`;
}

/**
 * The next action of a capped response. A strict parse refuses a key that the input does not
 * declare, so each reason names only declared keys. Only an input that declares `offset` gets the
 * paging affordance. An input that declares `limit` and no `offset` cannot page. It gets a reason
 * that says so and names the read it declares in `economy.detailRead`. Any other action gets
 * the windowless reason with that read.
 */
export function cappedAffordance(
  action: Pick<ToolAction, 'schema' | 'economy'>,
  actionName: string,
  shown: number,
  total: number,
): NextAction {
  const keys = inputKeysOf(action);
  const hint = economyNarrowHint(keys, actionName);
  const detailRead = action.economy?.detailRead;
  if (keys.has('offset')) {
    return narrowAffordance(actionName, shown, total, hint, keys.has('limit') ? 'limit/offset' : 'offset');
  }
  if (keys.has('limit')) return limitOnlyAffordance(actionName, shown, total, detailRead, hint);
  return detailAffordance(actionName, shown, total, detailRead, hint);
}

/**
 * Fails open: returns the uncapped payload with `_meta.economyDegraded: true` added to `_meta`.
 * The seam uses it for a budget that is not a positive finite number, a summarizer throw, or a
 * payload that is not list-dominant.
 */
function stampEconomyDegraded(result: ToolResult): ToolResult {
  const existingMeta =
    result._meta !== null && typeof result._meta === 'object'
      ? (result._meta as Record<string, unknown>)
      : {};
  const meta: Record<string, unknown> & EconomyMeta = {
    ...existingMeta,
    [ECONOMY_META_DEGRADED]: true,
  };
  return { ...result, _meta: meta };
}

/**
 * Enforces the registry-declared response-economy budget on a dispatched result. It does no I/O.
 * A failure, a success with no `data`, an unknown action, or `data` at or under budget returns
 * unchanged. Over budget, it returns {@link capResponse}. A bad budget fails open.
 */
export function enforceResponseEconomy(
  result: ToolResult,
  tool: string,
  actionName: string | undefined,
): ToolResult {
  if (!result.success || result.data === undefined) return result;
  if (actionName === undefined) return result;

  const action = findActionInRegistry(tool, actionName);
  if (action === undefined) return result;

  const budget = resolveEconomyBudget(action);
  if (!Number.isFinite(budget) || budget <= 0) {
    return stampEconomyDegraded(result);
  }

  if (estimateOutputTokens(result.data) <= budget) return result;
  return capResponse(result, tool, actionName);
}

/**
 * The capped form of a success result, as the cap returns it over the budget. It does not compare
 * the result with the budget. A failure, a success with no `data` or an unknown action returns unchanged.
 *
 * The declared `economy.summarize` replaces `data`. With no summarizer, a list-dominant payload
 * gets `{ summary, counts, firstPage }`, which is the `CappedDataSchema` shape.
 * A capped result gets `_meta.truncated` and a {@link cappedAffordance} entry first in `next_actions`.
 * A summarizer throw, or a payload that is not list-dominant, fails open.
 */
export function capResponse(result: ToolResult, tool: string, actionName: string): ToolResult {
  if (!result.success || result.data === undefined) return result;
  const action = findActionInRegistry(tool, actionName);
  if (action === undefined) return result;

  let cappedData: unknown;
  let total: number;
  const summarize = action.economy?.summarize;
  if (summarize !== undefined) {
    try {
      cappedData = summarize(result.data);
    } catch {
      return stampEconomyDegraded(result);
    }
    total = extractCappableItems(result.data).total;
  } else {
    const tokens = estimateOutputTokens(result.data);
    const { items, total: itemTotal } = extractCappableItems(result.data);
    const listDominant =
      Array.isArray(result.data) ||
      (items.length > 0 &&
        estimateOutputTokens(items) >= ECONOMY_LIST_DOMINANCE_RATIO * tokens);
    if (!listDominant) {
      return stampEconomyDegraded(result);
    }
    total = itemTotal;
    const firstPage = items.slice(0, SUMMARY_FIRST_PAGE_ITEMS);
    cappedData = {
      summary:
        `Response exceeded the ${resolveEconomyBudget(action)}-token economy budget ` +
        `(~${tokens} estimated tokens); showing a counts summary and the ` +
        `first ${firstPage.length} of ${total} item(s).` +
        narrowSentence(inputKeysOf(action)),
      counts: { total, shown: firstPage.length },
      firstPage,
    };
  }

  const shown = extractCappableItems(cappedData).total;
  const affordance = cappedAffordance(action, actionName, shown, total);
  const existingNextActions: readonly NextAction[] = result.next_actions ?? [];

  const existingMeta =
    result._meta !== null && typeof result._meta === 'object'
      ? (result._meta as Record<string, unknown>)
      : {};
  const meta: Record<string, unknown> & EconomyMeta = {
    ...existingMeta,
    [ECONOMY_META_TRUNCATED]: true,
  };

  return {
    ...result,
    data: cappedData,
    _meta: meta,
    next_actions: [affordance, ...existingNextActions],
  };
}
