/**
 * Shared envelope wrap for the four composite tools.
 * Each composite turns a successful handler `ToolResult` into a HATEOAS `Envelope<T>` with `next_actions`, `_meta` and `_perf`.
 * Error responses pass through unchanged, so their structured `error` payloads stay available for auto-correction.
 * Composites keep no local copy of this function.
 */

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

/** Opt-in behaviors on top of the base envelope wrap. Both are off by default. */
export interface EnvelopeWrapOptions {
  /**
   * Puts the handler `result.next_actions` before the HSM verbs, and does not drop them.
   * The view composite sets this option.
   */
  readonly mergeHandlerActions?: boolean;
  /**
   * Applies `applyCacheHints`, so the envelope carries `_cacheHints` on runtimes that report `anthropic_native_caching`.
   * The rehydrate path sets it. `undefined` leaves the envelope unchanged.
   */
  readonly cacheHintsResolver?: CapabilityResolver | undefined;
}

/**
 * Wraps a successful composite tool response in a HATEOAS envelope. Error responses pass through unchanged.
 * {@link nextActionsFromResult} gives `next_actions` from a pure lookup over the HSM registry.
 * A non-object `_meta` becomes an empty object, because `_meta` is `unknown` on the wire.
 */
export function envelopeWrap(
  result: ToolResult,
  startedAt: number,
  opts?: EnvelopeWrapOptions,
): ToolResult {
  if (!result.success) return result;

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
