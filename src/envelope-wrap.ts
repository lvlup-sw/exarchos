// ─── Shared composite envelope-wrap (DR-8 / DR-14, DR-10 dedup) ──────────────
//
// The four composite tools (`exarchos_workflow`, `exarchos_event`,
// `exarchos_orchestrate`, `exarchos_view`) each re-shape a successful handler
// `ToolResult` into a HATEOAS `Envelope<T>` at their tool boundary so agents see
// a stable contract with `next_actions`, `_meta`, and `_perf` on every response.
// Error responses pass through unchanged so structured `error` payloads (error
// codes, valid targets, suggested fixes) stay accessible for auto-correction.
//
// Pre-DR-10 each composite carried its own `envelopeWrap` copy (plus a
// rehydrate-only `envelopeWrapWithCacheHints` in the workflow composite). Three
// of the four were byte-identical; the view composite additionally merged
// handler-provided `next_actions`, and the rehydrate variant additionally
// applied cache hints. This helper collapses all of them into ONE function with
// two opt-in knobs so no residual `envelopeWrap` definition survives outside it.

import {
  applyCacheHints,
  wrap,
  wrapWithPassthrough,
  type Envelope,
  type ToolResult,
} from './format.js';
import {
  nextActionsFromResult,
  registryAdvertisementsFromResult,
} from './next-actions-from-result.js';
import type { CapabilityResolver } from './workflow/capabilities/resolver.js';

/**
 * Opt-in behaviors layered on top of the base envelope wrap. Both default off,
 * so an omitted `opts` reproduces the byte-identical behavior the workflow /
 * orchestrate / event-store composites had before DR-10.
 */
export interface EnvelopeWrapOptions {
  /**
   * View composite (#1262): merge handler-provided `result.next_actions`
   * (e.g. telemetry-derived checkpoint hints surfaced by `handleViewTelemetry`)
   * BEFORE the HSM-derived verbs, rather than dropping them. Other composites
   * carry no handler-authored `next_actions`, so they leave this off and
   * surface only the HSM verbs.
   */
  readonly mergeHandlerActions?: boolean;
  /**
   * Rehydrate path (T051, DR-14): apply `applyCacheHints` so the envelope
   * carries `_cacheHints` on runtimes reporting `anthropic_native_caching`.
   * Passing `undefined` (the common "no resolver in context" case) leaves the
   * envelope untouched — matching the prior `envelopeWrapWithCacheHints`
   * guard, which only applied hints when a resolver was present.
   */
  readonly cacheHintsResolver?: CapabilityResolver | undefined;
}

/**
 * HATEOAS envelope wrapping for a successful composite tool response
 * (T036–T039 + T041, DR-7/DR-8; cache hints T051, DR-14).
 *
 * `next_actions` is derived by {@link nextActionsFromResult} — a pure lookup
 * over the HSM registry. When {@link EnvelopeWrapOptions.mergeHandlerActions}
 * is set, any handler-populated `result.next_actions` is prepended. When a
 * {@link EnvelopeWrapOptions.cacheHintsResolver} is supplied, the envelope is
 * additionally passed through {@link applyCacheHints}.
 *
 * Error responses (`success: false`) pass through unchanged.
 */
export function envelopeWrap(
  result: ToolResult,
  startedAt: number,
  opts?: EnvelopeWrapOptions,
): ToolResult {
  if (!result.success) return result;

  // `_meta` is `unknown` on the wire, so narrow it rather than assert it: a
  // non-object value becomes an empty bag instead of a lie about its shape.
  const rawMeta: unknown = result._meta;
  const meta: Record<string, unknown> =
    typeof rawMeta === 'object' && rawMeta !== null ? { ...rawMeta } : {};
  const perf = result._perf ?? { ms: Date.now() - startedAt };
  const hsmActions = nextActionsFromResult(result);
  const advertised = registryAdvertisementsFromResult(result);
  const nextActions = opts?.mergeHandlerActions
    ? [...(result.next_actions ?? []), ...hsmActions]
    : hsmActions;
  let envelope: Envelope<unknown> = wrap(result.data, meta, perf, nextActions);
  if (opts?.cacheHintsResolver !== undefined) {
    envelope = applyCacheHints(envelope, opts.cacheHintsResolver);
  }
  if (advertised.length === 0) {
    return wrapWithPassthrough(result, envelope);
  }
  return wrapWithPassthrough(result, { ...envelope, advertised_actions: advertised });
}
