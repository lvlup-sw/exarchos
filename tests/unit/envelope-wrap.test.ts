import { describe, it, expect } from 'vitest';
import { envelopeWrap } from '../../src/envelope-wrap.js';
import type { ToolResult } from '../../src/format.js';
import type { NextAction } from '../../src/next-action.js';
import {
  createInMemoryResolver,
  ANTHROPIC_NATIVE_CACHING,
} from '../../src/workflow/capabilities/resolver.js';

/** A bare successful result with no workflow discriminators → next_actions []. */
function bareResult(): ToolResult {
  return { success: true, data: { hello: 'world' } };
}

/** The canonical top-level envelope key set every callsite must produce. */
const ENVELOPE_KEYS = ['success', 'data', 'next_actions', '_meta', '_perf'] as const;

/**
 * The four composite tools share `envelopeWrap`.
 * These tests pin the shared envelope and its two options, `mergeHandlerActions` and `cacheHintsResolver`.
 */
describe('envelopeWrap (shared composite envelope, DR-10)', () => {
  /**
   * The workflow, event and orchestrate composites pass no options.
   * The view passes `mergeHandlerActions`, and rehydrate passes `cacheHintsResolver`.
   * The resolver reports no native caching, so no envelope carries `_cacheHints`.
   * The equality check leaves out `_perf`, because `ms` comes from `Date.now()` and two calls can straddle a timer tick.
   */
  it('EnvelopeWrap_AllFourCallsites_IdenticalEnvelopeShape', () => {
    const started = Date.now();
    const resolver = createInMemoryResolver([]);

    const workflowLike = envelopeWrap(bareResult(), started);
    const eventStoreLike = envelopeWrap(bareResult(), started);
    const orchestrateLike = envelopeWrap(bareResult(), started);
    const viewLike = envelopeWrap(bareResult(), started, {
      mergeHandlerActions: true,
    });
    const rehydrateLike = envelopeWrap(bareResult(), started, {
      cacheHintsResolver: resolver,
    });

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
      expect((env as { next_actions: readonly NextAction[] }).next_actions).toEqual([]);
      expect(env._perf).toBeDefined();
    }

    const withoutPerf = (env: unknown): Record<string, unknown> => {
      const copy = { ...(env as Record<string, unknown>) };
      delete copy._perf;
      return copy;
    };
    expect(withoutPerf(workflowLike)).toEqual(withoutPerf(eventStoreLike));
    expect(withoutPerf(eventStoreLike)).toEqual(withoutPerf(orchestrateLike));
  });

  /** The workflow, event and orchestrate composites use this default. */
  it('EnvelopeWrap_DefaultCallsite_DropsHandlerNextActions', () => {
    const handlerAction = { verb: 'transition', label: 'x' } as unknown as NextAction;
    const result: ToolResult = {
      success: true,
      data: { hello: 'world' },
      next_actions: [handlerAction],
    };
    const env = envelopeWrap(result, Date.now());
    expect((env as { next_actions: readonly NextAction[] }).next_actions).toEqual([]);
  });

  /** The view composite sets this option. The handler actions come before the HSM verbs. */
  it('EnvelopeWrap_MergeHandlerActions_PrependsHandlerNextActions', () => {
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

  /** The rehydrate path sets this option. An `undefined` resolver adds no `_cacheHints`. */
  it('EnvelopeWrap_CacheHintsResolver_AppliesOnlyOnNativeCaching', () => {
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

    const noResolver = envelopeWrap(bareResult(), Date.now(), {
      cacheHintsResolver: undefined,
    }) as { _cacheHints?: unknown };
    expect(noResolver._cacheHints).toBeUndefined();
  });

  /** The same object comes back, so the structured `error` payload stays available for auto-correction. */
  it('EnvelopeWrap_ErrorResult_PassesThroughUnchanged', () => {
    const errorResult: ToolResult = {
      success: false,
      error: { code: 'BOOM', message: 'nope' },
    };
    const env = envelopeWrap(errorResult, Date.now());
    expect(env).toBe(errorResult);
  });
});
