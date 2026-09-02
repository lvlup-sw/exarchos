// ─── Response-Economy Seam (leaf module) ────────────────────────────────────
//
// The response-economy cap decision (`enforceResponseEconomy`) and its private
// helpers, extracted here (DR-4, debloat task 009) to break the runtime import
// cycle between `dispatch/core/dispatch.ts` and `projections/telemetry/middleware.ts`. `dispatch.ts`
// dynamic-imports the middleware (its telemetry-ON wrap arm); the middleware
// value-imported `enforceResponseEconomy` straight back from `dispatch.ts` — a
// genuine mutual runtime cycle (dependency-cruiser SCC, dynamic-import counted).
//
// This module is a LEAF relative to that pair: it depends on `../format.js`,
// `./economy.js`, `../registry.js`, and `../next-action.js` — none of which
// import `dispatch.ts` or the middleware — so nothing here re-enters either
// side. `dispatch.ts` imports + re-exports these symbols (its existing callers
// and the seam tests are unaffected); the middleware imports `enforceResponseEconomy`
// straight from here. Behavior is byte-identical to the pre-extraction
// definitions (INV-2: the seam simply lives at the leaf both callers share, no
// adapter indirection and no behavior moved to dodge the edge).
//
// Discipline (design §"Presentation seam"): capping/economy logic lives in the
// shared core, never in an adapter. Adapters only render. This module is the
// single owner of the runtime cap decision.

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
 * Envelope carrier fields the economy guard MUST NOT touch. Budgets measure
 * `data` only; the carrier floor is deliberately outside the budget so a capped
 * response never drops `success` / `next_actions` / `_meta` / `_perf` (and the
 * other diagnostic side-channels). Only `data` is replaced and `_meta` /
 * `next_actions` are AUGMENTED (never overwritten).
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
 * Fraction of a response's estimated tokens that its largest array must carry
 * for the payload to count as list-DOMINANT (safe for the generic list
 * fallback). Above this, the array IS effectively the payload (an inventory
 * wrapper like `{ worktrees: [...] }`); below it, the arrays are incidental to
 * a structured object (`{ workflowState, …, taskProgress:[…] }`) and slicing
 * would destroy the real content, so the guard fails open instead. Chosen well
 * above a state document's incidental-array share and well below a true
 * inventory's (~1.0), so the two separate cleanly.
 */
const ECONOMY_LIST_DOMINANCE_RATIO = 0.6;

/**
 * Best-effort item extraction for the generic capped fallback + the steering
 * affordance's shown/total counts. An array `data` is itself the item list;
 * an object `data` contributes its largest array-valued property (the common
 * inventory shape: `{ items: [...] }`, `{ worktrees: [...] }`, …). Anything
 * else yields an empty page (the summary text still records the overflow).
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
 * Build the INV-12 steering hint's CLI flag, or `undefined` when the action
 * declares no windowing/projection param. The generic capped fallback must not
 * advertise `--limit` on a `.strict()` action whose schema would reject it —
 * that would hand the caller an INVALID_INPUT recovery step (review DR fix). We
 * read the action's top-level Zod object shape; a `limit` wins, else `offset` /
 * `fields`, else no flag hint at all.
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
 * Fail-open: return the UNCAPPED payload with `_meta.economyDegraded: true`.
 * Used when the budget resolves non-finite / non-positive OR the declared
 * summarizer throws — never an error, never a silent drop (#1659 DR-3). The
 * carrier `_meta` is augmented non-destructively.
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
 * Enforce the action's registry-declared response-economy budget on a
 * dispatched result (DR-1). Pure function — no I/O, no telemetry side-effects —
 * so it is safe to call at the measurement seam and directly in tests.
 *
 * Contract:
 * - Only successful responses that carry a `data` payload are subject to the
 *   budget; failures carry `error`, not `data`, and are returned untouched.
 * - `data` is measured with {@link estimateOutputTokens} (byte-identical to the
 *   telemetry middleware). At or under budget → returned untouched.
 * - Over budget → the action's declared `economy.summarize` is applied if
 *   present, ELSE a generic capped fallback shaped EXACTLY as
 *   `{ summary, counts, firstPage }` (the shared `CappedDataSchema` fragment,
 *   `registry.ts`), so a capped typed-output response validates against the
 *   registered `outputSchema` (passes D.5). `_meta.truncated` is stamped and a
 *   {@link narrowAffordance} steering entry is PREPENDED to `next_actions`
 *   (INV-12).
 * - Fail-open (`_meta.economyDegraded`) on an unresolvable budget or a throwing
 *   summarizer.
 */
export function enforceResponseEconomy(
  result: ToolResult,
  tool: string,
  actionName: string | undefined,
): ToolResult {
  // Budgets govern the `data` payload of a successful response. A failure
  // envelope (or a success with no `data`) has nothing to measure and its
  // carrier must survive verbatim.
  if (!result.success || result.data === undefined) return result;
  if (actionName === undefined) return result;

  const action = findActionInRegistry(tool, actionName);
  if (action === undefined) return result;

  const budget = resolveEconomyBudget(action);
  if (!Number.isFinite(budget) || budget <= 0) {
    // Fail-open: an unresolvable budget can neither pass nor cap — degrade
    // visibly rather than dumping or dropping.
    return stampEconomyDegraded(result);
  }

  const tokens = estimateOutputTokens(result.data);
  if (tokens <= budget) return result; // under budget — untouched

  let cappedData: unknown;
  let total: number;
  const summarize = action.economy?.summarize;
  if (summarize !== undefined) {
    try {
      cappedData = summarize(result.data);
    } catch {
      // A throwing summarizer degrades to the uncapped payload.
      return stampEconomyDegraded(result);
    }
    total = extractCappableItems(result.data).total;
  } else {
    // The generic list fallback replaces `data` with a counts summary + first
    // page. That is SAFE ONLY when the payload is genuinely list-DOMINANT:
    //  - `data` is itself an array, OR
    //  - `data` is an object whose largest array carries the BULK of the bytes
    //    (an inventory wrapper like `{ worktrees: [...] }` / `{ items: [...],
    //    page }`).
    // A structured object whose arrays are INCIDENTAL — `exarchos_workflow`
    // get/transition/rehydrate return `{ workflowState, phasePlaybook,
    // taskProgress:[…] }`, where `taskProgress` is a small side list, not the
    // payload — would be GUTTED by a blind slice (dropping workflowState /
    // phasePlaybook with no recoverable copy). Those fail open instead: the
    // full payload is retained with a visible `_meta.economyDegraded`. An action
    // that ships large object responses must declare an `economy.summarize` (or
    // self-cap) to be genuinely bounded. (DR-1 fail-open; INV-17 totality holds
    // because the degraded envelope is the declared degraded shape.)
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

  // Steering affordance (INV-12), keyed on the action's own name. `shown` is
  // derived from whatever list the capped `data` surfaced (the generic
  // fallback's `firstPage`, or a summarizer's own list) so the affordance's
  // "showing X of Y" tracks the capped shape. The CLI hint is emitted ONLY
  // when the action's schema actually declares a windowing/projection param —
  // advertising `--limit` on a `.strict()` action that rejects it would hand
  // the caller an INVALID_INPUT recovery step.
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
