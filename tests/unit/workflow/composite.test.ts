import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import { deriveRepoKey } from '../../../src/utils/paths.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

vi.mock('../../../src/workflow/tools.js', () => ({
  handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'init-result' } }),
  handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'get-result' } }),
  handleTransition: vi.fn().mockResolvedValue({ success: true, data: { phase: 'transition-result' } }),
  handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 3 } }),
}));

vi.mock('../../../src/workflow/cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancel-result' } }),
}));

vi.mock('../../../src/workflow/rehydrate.js', () => ({
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

import { handleWorkflow } from '../../../src/workflow/composite.js';
import { handleInit, handleGet, handleTransition, handleReconcileState } from '../../../src/workflow/tools.js';
import { handleCancel } from '../../../src/workflow/cancel.js';
import { resolveConfig } from '../../../src/config/resolve.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
} from '../../../src/workflow/capabilities/resolver.js';

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
    /**
     * The composite passes `deriveRepoKey(ctx.cwd ?? process.cwd())` as the fourth argument.
     * The context has no `cwd`, so the key comes from `process.cwd()`.
     */
    it('should delegate to handleInit with correct args', async () => {
      const args = { action: 'init', featureId: 'test', workflowType: 'feature' };

      const result = await handleWorkflow(args, ctx);

      expect(handleInit).toHaveBeenCalledWith(
        { featureId: 'test', workflowType: 'feature' },
        stateDir,
        ctx.eventStore,
        deriveRepoKey(process.cwd()),
      );
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

  /** Phase changes route through the `transition` action, so this block pins its dispatch. */
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

    /**
     * The composite reads `maxNoCoverage` and the enforcement mode from `projectConfig`. It passes
     * both in the `handleTransition` options, the same path as the mutation threshold.
     */
    it('Injection_MaxNoCoverageConfigured_ReachesTransitionOptions_DR6', async () => {
      const projectConfig = resolveConfig({
        review: {
          'mutation-enforcement': 'block',
          gates: { 'mutation-adequacy': { params: { maxNoCoverage: 2 } } },
        },
      } as unknown as import('../../../src/config/yaml-schema.js').ProjectConfig);
      const cfgCtx = { ...makeCtx(stateDir), projectConfig };
      await handleWorkflow(
        { action: 'transition', featureId: 'test', target: 'synthesize' },
        cfgCtx,
      );
      const opts = (handleTransition as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0][3] as Record<string, unknown>;
      expect(opts.mutationEnforcement).toBe('block');
      expect(opts.maxNoCoverage).toBe(2);
    });

    /** Without `projectConfig`, the options argument of `handleTransition` stays `undefined`. */
    it('Injection_NoConfig_MaxNoCoverageAbsent_DR6', async () => {
      await handleWorkflow(
        { action: 'transition', featureId: 'test', target: 'synthesize' },
        ctx,
      );
      expect(handleTransition).toHaveBeenCalledWith(
        { featureId: 'test', target: 'synthesize' },
        stateDir,
        ctx.eventStore,
        undefined,
      );
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

  /**
   * Only the `rehydrate` dispatch passes the capability resolver to `envelopeWrap`, which calls
   * `applyCacheHints`. The other actions mutate state or return small payloads, so hints give no
   * benefit there.
   */
  describe('rehydrate action — cache hints (T051, DR-14)', () => {
    /**
     * The test checks only the `after:` prefix of `position`. The position comes from the stable
     * keys, so a new stable key needs no test edit.
     */
    it('Rehydrate_ResolverWithCapability_EmitsCacheHints', async () => {
      const args = { action: 'rehydrate', featureId: 'test' };
      const ctxWithCaching: DispatchContext = {
        ...ctx,
        capabilityResolver: createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]),
      };

      const result = await handleWorkflow(args, ctxWithCaching);

      expect(result.success).toBe(true);
      const env = result as Record<string, unknown>;
      expect(env._cacheHints).toBeDefined();
      const hints = env._cacheHints as Record<string, unknown>;
      expect(hints.type).toBe('cache_boundary');
      expect(hints.kind).toBe('ephemeral');
      expect(hints.ttl).toBe('1h');
      expect(typeof hints.position).toBe('string');
      expect((hints.position as string).startsWith('after:')).toBe(true);
    });

    /**
     * An empty resolver acts as a runtime without native caching. The envelope must omit the
     * field, not set it to null, because the JSON wire contract treats absence as distinct.
     */
    it('Rehydrate_ResolverWithoutCapability_OmitsCacheHints', async () => {
      const args = { action: 'rehydrate', featureId: 'test' };
      const ctxWithoutCaching: DispatchContext = {
        ...ctx,
        capabilityResolver: createInMemoryResolver([]),
      };

      const result = await handleWorkflow(args, ctxWithoutCaching);

      expect(result.success).toBe(true);
      const env = result as Record<string, unknown>;
      expect('_cacheHints' in env).toBe(false);
    });

    /**
     * A context without `capabilityResolver`, such as a hand-built test context, must emit no
     * hints. The composite applies hints only with an explicit resolver.
     */
    it('Rehydrate_NoResolverInContext_OmitsCacheHints', async () => {
      const args = { action: 'rehydrate', featureId: 'test' };

      const result = await handleWorkflow(args, ctx);

      expect(result.success).toBe(true);
      const env = result as Record<string, unknown>;
      expect('_cacheHints' in env).toBe(false);
    });

    /**
     * The `init`, `get` and `reconcile` envelopes must carry no `_cacheHints`, even when the runtime
     * reports the capability.
     */
    it('NonRehydrateActions_NeverEmitCacheHints_EvenWithResolver', async () => {
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

/**
 * The file-level mock stubs `handleInit`. This suite removes that mock and runs the real
 * `handleInit` through the composite against a real event store. It proves that the production
 * path stamps `repoRoot` on `workflow.started`.
 */
describe('HandleWorkflow_InitDispatch_EmitsWorkflowStartedWithRepoRoot (DR-5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.doUnmock('../../../src/workflow/tools.js');
    vi.resetModules();
    tempDir = await mkdtemp(path.join(tmpdir(), 'composite-init-reporoot-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * The composite passes `deriveRepoKey(ctx.cwd ?? process.cwd())`, and `handleInit` stamps it.
   * Without that path, `repoRoot` is absent. The `finally` block closes the store before
   * `afterEach` removes the directory, because an open WAL handle makes the unlink fail with
   * EBUSY on Windows.
   */
  it('composite init dispatch stamps the caller repo key on workflow.started', async () => {
    const { handleWorkflow } = await import('../../../src/workflow/composite.js');
    const { EventStore: FreshEventStore } = await import('../../../src/events/store.js');
    const { deriveRepoKey: freshDeriveRepoKey } = await import('../../../src/utils/paths.js');

    const store = new FreshEventStore(tempDir);
    try {
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

      expect(typeof data.repoRoot).toBe('string');
      expect(data.repoRoot).toBe(freshDeriveRepoKey(process.cwd()));
    } finally {
      store.close();
    }
  }, 20000);
});
