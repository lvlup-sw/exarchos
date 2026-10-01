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
import { findActionInRegistry, resolveEconomyBudget } from '../../registry.js';
import {
  estimateOutputTokens,
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

/**
 * Builds the CLI flag for the steering hint from the top-level Zod shape of the action.
 * `limit` comes first, then `offset`, then `fields`. With none of them it returns `undefined`.
 * A `.strict()` action rejects an undeclared flag, so a hint for it gives an `INVALID_INPUT` step.
 */
function economyNarrowHint(
  action: { schema?: unknown } | undefined,
  actionName: string,
): string | undefined {
  const schema = action?.schema;
  const shape =
    schema !== null && typeof schema === 'object' && 'shape' in schema
      ? (schema as { shape?: unknown }).shape
      : undefined;
  if (shape === null || typeof shape !== 'object') return undefined;
  const keys = shape as Record<string, unknown>;
  if ('limit' in keys) return `${actionName} --limit ${SUMMARY_FIRST_PAGE_ITEMS}`;
  if ('offset' in keys) return `${actionName} --offset <n>`;
  if ('fields' in keys) return `${actionName} --fields <comma,separated>`;
  return undefined;
}

/**
 * Fails open: returns the uncapped payload with `_meta.economyDegraded: true` added to `_meta`.
 * The seam uses it when the budget is not a positive finite number or the summarizer throws.
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
 * A failure, a success with no `data`, or `data` at or under budget returns unchanged.
 *
 * Over budget, the declared `economy.summarize` replaces `data`. With no summarizer, a list-dominant
 * payload gets `{ summary, counts, firstPage }`, which is the `CappedDataSchema` shape.
 * A capped result gets `_meta.truncated` and a {@link narrowAffordance} entry first in `next_actions`.
 * A bad budget, a summarizer throw, or a payload that is not list-dominant fails open.
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

  const tokens = estimateOutputTokens(result.data);
  if (tokens <= budget) return result;

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
        `Response exceeded the ${budget}-token economy budget ` +
        `(~${tokens} estimated tokens); showing a counts summary and the ` +
        `first ${firstPage.length} of ${total} item(s). Narrow with ` +
        `limit / offset / fields to page the detail.`,
      counts: { total, shown: firstPage.length },
      firstPage,
    };
  }

  const shown = extractCappableItems(cappedData).total;
  const affordance = narrowAffordance(
    actionName,
    shown,
    total,
    economyNarrowHint(action, actionName),
  );
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
