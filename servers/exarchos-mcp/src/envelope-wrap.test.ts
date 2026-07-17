import { describe, it, expect } from 'vitest';
import { envelopeWrap } from './envelope-wrap.js';
import type { ToolResult } from './format.js';
import type { NextAction } from './next-action.js';
import {
  createInMemoryResolver,
  ANTHROPIC_NATIVE_CACHING,
} from './capabilities/resolver.js';

// ─── DR-10: shared composite envelope-wrap ──────────────────────────────────
//
// The four composite tools (`exarchos_workflow`, `exarchos_event`,
// `exarchos_orchestrate`, `exarchos_view`) previously each carried their own
// `envelopeWrap` copy; DR-10 collapses them into this ONE helper. These tests
// pin the shared contract and the two opt-in knobs (mergeHandlerActions,
// cacheHintsResolver) that the view / rehydrate callsites use.

/** A bare successful result with no workflow discriminators → next_actions []. */
function bareResult(): ToolResult {
  return { success: true, data: { hello: 'world' } };
}

/** The canonical top-level envelope key set every callsite must produce. */
const ENVELOPE_KEYS = ['success', 'data', 'next_actions', '_meta', '_perf'] as const;

describe('envelopeWrap (shared composite envelope, DR-10)', () => {
  it('EnvelopeWrap_AllFourCallsites_IdenticalEnvelopeShape', () => {
    const started = Date.now();
    const resolver = createInMemoryResolver([]); // no native caching → no _cacheHints

    // The four composite callsites, by their exact invocation shape:
    //   workflow / event-store / orchestrate → no opts (drop handler actions)
    //   view                                 → { mergeHandlerActions: true }
    //   workflow rehydrate                   → { cacheHintsResolver }
    const workflowLike = envelopeWrap(bareResult(), started);
    const eventStoreLike = envelopeWrap(bareResult(), started);
    const orchestrateLike = envelopeWrap(bareResult(), started);
    const viewLike = envelopeWrap(bareResult(), started, {
      mergeHandlerActions: true,
    });
    const rehydrateLike = envelopeWrap(bareResult(), started, {
      cacheHintsResolver: resolver,
    });

    // Every callsite yields the SAME top-level envelope shape.
    for (const env of [
      workflowLike,
      eventStoreLike,
      orchestrateLike,
      viewLike,
      rehydrateLike,
    ]) {
      expect(Object.keys(env as Record<string, unknown>).sort()).toEqual(
        [...ENVELOPE_KEYS].sort(),
      );
      expect(env.success).toBe(true);
      expect(env.data).toEqual({ hello: 'world' });
      // Bare (non-workflow) payload with no handler actions → empty affordances.
      expect((env as { next_actions: readonly NextAction[] }).next_actions).toEqual([]);
      expect(env._perf).toBeDefined();
    }

    // The three no-opt callsites are byte-identical envelopes to each other,
    // `_perf` aside — its `ms` derives from Date.now() at each call, so the
    // three sequential calls can straddle a timer tick (notably on Windows'
    // coarse ~15ms clock) and legitimately differ. Compare the stable fields.
    const withoutPerf = (env: unknown): Record<string, unknown> => {
      const copy = { ...(env as Record<string, unknown>) };
      delete copy._perf;
      return copy;
    };
    expect(withoutPerf(workflowLike)).toEqual(withoutPerf(eventStoreLike));
    expect(withoutPerf(eventStoreLike)).toEqual(withoutPerf(orchestrateLike));
  });

  it('EnvelopeWrap_DefaultCallsite_DropsHandlerNextActions', () => {
    // workflow / orchestrate / event-store behavior: handler-authored
    // next_actions are NOT merged (they carry none in practice).
    const handlerAction = { verb: 'transition', label: 'x' } as unknown as NextAction;
    const result: ToolResult = {
      success: true,
      data: { hello: 'world' },
      next_actions: [handlerAction],
    };
    const env = envelopeWrap(result, Date.now());
    expect((env as { next_actions: readonly NextAction[] }).next_actions).toEqual([]);
  });

  it('EnvelopeWrap_MergeHandlerActions_PrependsHandlerNextActions', () => {
    // view behavior (#1262): handler-authored next_actions (telemetry hints)
    // are prepended to the HSM-derived verbs.
    const handlerAction = { verb: 'checkpoint', label: 'hint' } as unknown as NextAction;
    const result: ToolResult = {
      success: true,
      data: { hello: 'world' },
      next_actions: [handlerAction],
    };
    const env = envelopeWrap(result, Date.now(), { mergeHandlerActions: true });
    expect((env as { next_actions: readonly NextAction[] }).next_actions).toEqual([
      handlerAction,
    ]);
  });

  it('EnvelopeWrap_CacheHintsResolver_AppliesOnlyOnNativeCaching', () => {
    // rehydrate behavior (T051, DR-14): _cacheHints is applied iff the resolver
    // reports anthropic_native_caching.
    const cachingResolver = createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);
    const plainResolver = createInMemoryResolver([]);

    const hinted = envelopeWrap(bareResult(), Date.now(), {
      cacheHintsResolver: cachingResolver,
    }) as { _cacheHints?: unknown };
    expect(hinted._cacheHints).toBeDefined();

    const unhinted = envelopeWrap(bareResult(), Date.now(), {
      cacheHintsResolver: plainResolver,
    }) as { _cacheHints?: unknown };
    expect(unhinted._cacheHints).toBeUndefined();

    // An undefined resolver leaves the envelope untouched (no _cacheHints).
    const noResolver = envelopeWrap(bareResult(), Date.now(), {
      cacheHintsResolver: undefined,
    }) as { _cacheHints?: unknown };
    expect(noResolver._cacheHints).toBeUndefined();
  });

  it('EnvelopeWrap_ErrorResult_PassesThroughUnchanged', () => {
    const errorResult: ToolResult = {
      success: false,
      error: { code: 'BOOM', message: 'nope' },
    };
    const env = envelopeWrap(errorResult, Date.now());
    // Error envelopes pass through verbatim so structured error payloads stay
    // accessible for auto-correction.
    expect(env).toBe(errorResult);
  });
});
