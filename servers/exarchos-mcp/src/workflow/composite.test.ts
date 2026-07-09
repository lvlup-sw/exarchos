import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import { deriveRepoKey } from '../utils/paths.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

vi.mock('./tools.js', () => ({
  handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'init-result' } }),
  handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'get-result' } }),
  // T5a.1/DR-4 (#1259, v2.11): `handleSet` is no longer dispatched from the
  // composite handler. The action is removed; phase mutation routes through
  // `handleTransition` directly. Mock retained for any indirect callers
  // (none today) to keep this surface a no-op stub.
  handleTransition: vi.fn().mockResolvedValue({ success: true, data: { phase: 'transition-result' } }),
  handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 3 } }),
}));

vi.mock('./cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancel-result' } }),
}));

vi.mock('./rehydrate.js', () => ({
  handleRehydrate: vi.fn().mockResolvedValue({
    success: true,
    data: {
      v: 1,
      projectionSequence: 0,
      workflowState: { featureId: 'test', workflowType: 'feature', phase: 'ideate' },
      taskProgress: [],
      decisions: [],
      blockers: [],
      artifacts: {},
    },
  }),
}));

import { handleWorkflow } from './composite.js';
import { handleInit, handleGet, handleTransition, handleReconcileState } from './tools.js';
import { handleCancel } from './cancel.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
} from '../capabilities/resolver.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

describe('handleWorkflow', () => {
  const stateDir = '/tmp/test-state';
  const ctx = makeCtx(stateDir);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('init action', () => {
    it('should delegate to handleInit with correct args', async () => {
      const args = { action: 'init', featureId: 'test', workflowType: 'feature' };

      const result = await handleWorkflow(args, ctx);

      // DR-5 oracle update (intentional): the composite now threads a 4th arg —
      // the memoized caller repo key `deriveRepoKey(ctx.cwd ?? process.cwd())`.
      // ctx carries no `cwd`, so it resolves the serving process's repo key.
      expect(handleInit).toHaveBeenCalledWith(
        { featureId: 'test', workflowType: 'feature' },
        stateDir,
        ctx.eventStore,
        deriveRepoKey(process.cwd()),
      );
      // T036: successful responses are wrapped in Envelope<T>
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'init-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    }, 20000);
  });

  describe('get action', () => {
    it('should delegate to handleGet with correct args', async () => {
      const args = { action: 'get', featureId: 'test', query: 'phase' };

      const result = await handleWorkflow(args, ctx);

      expect(handleGet).toHaveBeenCalledWith(
        { featureId: 'test', query: 'phase' },
        stateDir,
        ctx.eventStore,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'get-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  // T5a.1/DR-4 (#1259, v2.11): the prior `set action` describe block
  // exercised the deprecated rerouting path (`set({phase})` →
  // `handleSet`). The action is removed in v2.11; phase mutation now routes
  // through `transition` directly. Mirror the previous coverage shape on
  // the canonical action so the dispatch wiring stays witnessed.
  describe('transition action', () => {
    it('should delegate to handleTransition with correct args', async () => {
      const args = { action: 'transition', featureId: 'test', target: 'delegate' };

      const result = await handleWorkflow(args, ctx);

      expect(handleTransition).toHaveBeenCalledWith(
        { featureId: 'test', target: 'delegate' },
        stateDir,
        ctx.eventStore,
        undefined,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'transition-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('set action (DR-4 hard-cut)', () => {
    it('should return UNKNOWN_ACTION error with validActions', async () => {
      const args = { action: 'set', featureId: 'test', phase: 'delegate' };

      const result = await handleWorkflow(args, ctx);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      const validActions = (result.error as { validActions?: unknown })
        ?.validActions;
      expect(Array.isArray(validActions)).toBe(true);
      expect(validActions as string[]).toContain('transition');
    });
  });

  describe('cancel action', () => {
    it('should delegate to handleCancel with correct args', async () => {
      const args = { action: 'cancel', featureId: 'test', reason: 'no longer needed' };

      const result = await handleWorkflow(args, ctx);

      expect(handleCancel).toHaveBeenCalledWith(
        { featureId: 'test', reason: 'no longer needed' },
        stateDir,
        ctx.eventStore,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'cancel-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('reconcile action', () => {
    it('should delegate to handleReconcileState with correct args', async () => {
      const args = { action: 'reconcile', featureId: 'test' };

      const result = await handleWorkflow(args, ctx);

      expect(handleReconcileState).toHaveBeenCalledWith(
        { featureId: 'test' },
        stateDir,
        ctx.eventStore,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ reconciled: true, eventsApplied: 3 });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const args = { action: 'invalid' };

      const result = await handleWorkflow(args, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
      expect(result.error!.message).toContain('invalid');
    });
  });

  // T051 / DR-14 — `applyCacheHints` is wired ONLY into the rehydrate
  // dispatch path. Other actions (init/get/set/cancel/cleanup/reconcile/
  // checkpoint/describe) deliberately do NOT emit `_cacheHints` because
  // they either mutate state or return small payloads where cache
  // annotations carry no benefit. The followups doc treats this scoping
  // as the safe default.
  describe('rehydrate action — cache hints (T051, DR-14)', () => {
    it('Rehydrate_ResolverWithCapability_EmitsCacheHints', async () => {
      const args = { action: 'rehydrate', featureId: 'test' };
      const ctxWithCaching: DispatchContext = {
        ...ctx,
        capabilityResolver: createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]),
      };

      const result = await handleWorkflow(args, ctxWithCaching);

      expect(result.success).toBe(true);
      const env = result as Record<string, unknown>;
      // Hint is present at the envelope root.
      expect(env._cacheHints).toBeDefined();
      const hints = env._cacheHints as Record<string, unknown>;
      expect(hints.type).toBe('cache_boundary');
      expect(hints.kind).toBe('ephemeral');
      expect(hints.ttl).toBe('1h');
      // The position string is derived from STABLE_KEYS (T050) and is a
      // stable contract — assert it starts with the expected prefix
      // rather than pin every key, so a STABLE_KEYS extension doesn't
      // need a coordinated test edit.
      expect(typeof hints.position).toBe('string');
      expect((hints.position as string).startsWith('after:')).toBe(true);
    });

    it('Rehydrate_ResolverWithoutCapability_OmitsCacheHints', async () => {
      const args = { action: 'rehydrate', featureId: 'test' };
      const ctxWithoutCaching: DispatchContext = {
        ...ctx,
        // Empty resolver — kill-switch / non-Anthropic runtime semantics.
        capabilityResolver: createInMemoryResolver([]),
      };

      const result = await handleWorkflow(args, ctxWithoutCaching);

      expect(result.success).toBe(true);
      const env = result as Record<string, unknown>;
      // Field is omitted, NOT set to null/undefined — the JSON wire
      // contract treats absence as semantically distinct.
      expect('_cacheHints' in env).toBe(false);
    });

    it('Rehydrate_NoResolverInContext_OmitsCacheHints', async () => {
      // A boot path that didn't construct a resolver (e.g. a test
      // that builds the context manually) must not emit hints —
      // applyCacheHints requires an explicit resolver, no implicit
      // always-on at the composite layer.
      const args = { action: 'rehydrate', featureId: 'test' };
      // ctx has no `capabilityResolver` set.

      const result = await handleWorkflow(args, ctx);

      expect(result.success).toBe(true);
      const env = result as Record<string, unknown>;
      expect('_cacheHints' in env).toBe(false);
    });

    it('NonRehydrateActions_NeverEmitCacheHints_EvenWithResolver', async () => {
      // Cache hints are scoped to the rehydrate path only. Init / get /
      // set responses must NOT carry `_cacheHints` even on a runtime
      // that reports the capability — they don't have a stable
      // serialized prefix worth annotating.
      const ctxWithCaching: DispatchContext = {
        ...ctx,
        capabilityResolver: createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]),
      };

      for (const action of ['init', 'get', 'reconcile'] as const) {
        const result = await handleWorkflow(
          { action, featureId: 'test', workflowType: 'feature' },
          ctxWithCaching,
        );
        expect(result.success, `${action} should succeed`).toBe(true);
        const env = result as Record<string, unknown>;
        expect(
          '_cacheHints' in env,
          `${action} envelope must not carry _cacheHints`,
        ).toBe(false);
      }
    });
  });
});

// ─── DR-5: composite init dispatch stamps repoRoot (production path) ──────────
//
// The file-level `vi.mock('./tools.js')` above stubs `handleInit` for
// envelope-conformance assertions. This suite UN-mocks it so the composite arm
// runs the REAL `handleInit` end-to-end against a real event store — proving
// the production path (not a direct handler call) stamps `repoRoot` on
// `workflow.started`, closing the built-but-unwired gap (DR-5).

describe('HandleWorkflow_InitDispatch_EmitsWorkflowStartedWithRepoRoot (DR-5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.doUnmock('./tools.js');
    vi.resetModules();
    tempDir = await mkdtemp(path.join(tmpdir(), 'composite-init-reporoot-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('composite init dispatch stamps the caller repo key on workflow.started', async () => {
    const { handleWorkflow } = await import('./composite.js');
    const { EventStore: FreshEventStore } = await import('../event-store/store.js');
    const { deriveRepoKey: freshDeriveRepoKey } = await import('../utils/paths.js');

    const store = new FreshEventStore(tempDir);
    const featureId = 'wf-composite-reporoot';
    const dispatchCtx: DispatchContext = {
      stateDir: tempDir,
      eventStore: store,
      enableTelemetry: false,
    };

    const result = await handleWorkflow(
      { action: 'init', featureId, workflowType: 'feature' },
      dispatchCtx,
    );
    expect(result.success).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.started' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as { repoRoot?: string; featureId?: string };

    // The composite threads `deriveRepoKey(ctx.cwd ?? process.cwd())` — no cwd on
    // ctx, so the serving process's repo key — and handleInit stamps it. A
    // reverted implementation (no threading / no stamp) leaves repoRoot absent.
    expect(typeof data.repoRoot).toBe('string');
    expect(data.repoRoot).toBe(freshDeriveRepoKey(process.cwd()));
  }, 20000);
});
