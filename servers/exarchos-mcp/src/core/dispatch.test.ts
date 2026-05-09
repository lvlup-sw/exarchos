import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { z } from 'zod';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import {
  registerCustomTool,
  clearCustomTools,
  setCustomToolActionHandler,
} from '../registry.js';
import type { CompositeTool } from '../registry.js';
import type { DispatchContext } from './dispatch.js';
import { InMemoryBackend } from '../storage/memory-backend.js';
import type { StorageBackend } from '../storage/backend.js';

describe('dispatch', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-test-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // ─── T15 (DR-2) — DispatchContext.storage field ─────────────────────────
  //
  // Pins the type-shape requirement from the durable-event-store-substrate
  // design: `DispatchContext` carries an optional `storage: StorageBackend`
  // field so the lifecycle wiring (T16) can inject the SQLite handle once
  // at startup instead of leaving every consumer to reach for an ambient
  // import. The acceptance test (`dispatch-context.acceptance.test.ts`)
  // is the cross-cutting observable; this test pins the unit-level shape
  // so a regression here surfaces in `dispatch.test.ts` first.
  it('DispatchContext_TypeShape_IncludesStorageField', () => {
    // Source-level grep — the interface declaration itself must carry the
    // field. Test files are excluded from `tsc --noEmit` (see
    // `tsconfig.json`) so the type-erased static check is not load-bearing
    // by itself; the regex assertion below is.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const dispatchSrc = readFileSync(resolve(__dirname, 'dispatch.ts'), 'utf-8');
    const ifaceMatch = dispatchSrc.match(
      /export interface DispatchContext\s*\{[\s\S]*?\n\}/,
    );
    expect(ifaceMatch).not.toBeNull();
    const ifaceBody = ifaceMatch![0];
    expect(
      /\bstorage\??:\s*StorageBackend\b/.test(ifaceBody),
      `Expected DispatchContext interface to declare 'storage[?]: StorageBackend'.\n` +
        `Body:\n${ifaceBody}`,
    ).toBe(true);

    // Static + runtime: a literal which sets `storage` on the canonical
    // shape must be assignable. Without the interface field, this fails
    // tsx compilation.
    const backend: StorageBackend = new InMemoryBackend();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      storage: backend,
    };
    expect(ctx.storage).toBe(backend);
  });

  it('Dispatch_KnownTool_CallsHandler', async () => {
    // Arrange
    const { dispatch } = await import('./dispatch.js');

    // Act — call a known tool (exarchos_workflow with 'get' action)
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'test-feature' },
      { stateDir: tmpDir, eventStore, enableTelemetry: false },
    );

    // Assert — should return a ToolResult (may fail due to missing state, but should route)
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('Dispatch_UnknownTool_ReturnsError', async () => {
    // Arrange
    const { dispatch } = await import('./dispatch.js');

    // Act
    const result = await dispatch(
      'nonexistent_tool',
      {},
      { stateDir: tmpDir, eventStore, enableTelemetry: false },
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('UNKNOWN_TOOL');
    expect(result.error!.message).toContain('nonexistent_tool');
  });

  it('Dispatch_LoadCompositeHandlerThrows_ReturnsCompositeLoadFailed', async () => {
    // Arrange — inject a loader that throws, simulating a broken module
    // graph (e.g. ERR_MODULE_NOT_FOUND after a partial install). The real
    // module is temporarily removed from both the loader map and the handler
    // cache so dispatch is forced down the throwing loader path.
    const { COMPOSITE_HANDLERS, COMPOSITE_HANDLER_LOADERS, dispatch } = await import('./dispatch.js');
    const toolName = 'exarchos_workflow';
    const origLoader = COMPOSITE_HANDLER_LOADERS[toolName];
    const origCache = COMPOSITE_HANDLERS[toolName];
    delete COMPOSITE_HANDLERS[toolName];
    COMPOSITE_HANDLER_LOADERS[toolName] = () =>
      Promise.reject(new Error("Cannot find module '../workflow/composite.js'"));

    try {
      // Act
      const result = await dispatch(
        toolName,
        { action: 'get', featureId: 'test' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert — dispatch wraps the load failure in a structured ToolResult
      // rather than leaking ERR_MODULE_NOT_FOUND through the MCP transport.
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('COMPOSITE_LOAD_FAILED');
      expect(result.error!.message).toContain(toolName);
      expect(result.error!.message).toContain('Cannot find module');
    } finally {
      if (origLoader) COMPOSITE_HANDLER_LOADERS[toolName] = origLoader;
      else delete COMPOSITE_HANDLER_LOADERS[toolName];
      if (origCache) COMPOSITE_HANDLERS[toolName] = origCache;
      else delete COMPOSITE_HANDLERS[toolName];
    }
  });

  it('Dispatch_WithTelemetry_EnrichesResult', async () => {
    // Arrange
    const { dispatch } = await import('./dispatch.js');

    // Act — call with telemetry enabled
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'test-feature' },
      { stateDir: tmpDir, eventStore, enableTelemetry: true },
    );

    // Assert — result should have _perf from telemetry
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    expect(result._perf).toBeDefined();
    expect(result._perf!.ms).toBeGreaterThanOrEqual(0);
  });

  describe('Custom tool dispatch', () => {
    afterEach(() => {
      clearCustomTools();
    });

    it('Dispatch_CustomTool_ReturnsSuccess', async () => {
      // Arrange — register a custom tool with handler
      const customTool: CompositeTool = {
        name: 'exarchos_deploy',
        description: 'Custom deployment tool',
        actions: [
          {
            name: 'trigger',
            description: 'Trigger a deployment',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
          {
            name: 'status',
            description: 'Get deployment status',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
        ],
      };
      registerCustomTool(customTool);
      setCustomToolActionHandler('exarchos_deploy', 'trigger', async (args) => {
        return { deployed: true, target: args.target };
      });
      setCustomToolActionHandler('exarchos_deploy', 'status', async () => {
        return { status: 'running' };
      });

      const { dispatch } = await import('./dispatch.js');

      // Act
      const result = await dispatch(
        'exarchos_deploy',
        { action: 'trigger', target: 'production' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert — should NOT be UNKNOWN_TOOL
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ deployed: true, target: 'production' });
    });

    it('Dispatch_CustomTool_MissingAction_ReturnsError', async () => {
      // Arrange — register tool with handler but call without action
      const customTool: CompositeTool = {
        name: 'exarchos_ci',
        description: 'CI tool',
        actions: [
          {
            name: 'run',
            description: 'Run CI',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
          {
            name: 'cancel',
            description: 'Cancel CI',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
        ],
      };
      registerCustomTool(customTool);
      setCustomToolActionHandler('exarchos_ci', 'run', async () => ({ ok: true }));
      setCustomToolActionHandler('exarchos_ci', 'cancel', async () => ({ ok: true }));

      const { dispatch } = await import('./dispatch.js');

      // Act — no action field
      const result = await dispatch(
        'exarchos_ci',
        {},
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('MISSING_ACTION');
    });

    it('Dispatch_CustomTool_UnknownAction_ReturnsError', async () => {
      // Arrange
      const customTool: CompositeTool = {
        name: 'exarchos_notify',
        description: 'Notification tool',
        actions: [
          {
            name: 'send',
            description: 'Send notification',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
          {
            name: 'list',
            description: 'List notifications',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
        ],
      };
      registerCustomTool(customTool);
      setCustomToolActionHandler('exarchos_notify', 'send', async () => ({ sent: true }));
      setCustomToolActionHandler('exarchos_notify', 'list', async () => ({ items: [] }));

      const { dispatch } = await import('./dispatch.js');

      // Act — nonexistent action
      const result = await dispatch(
        'exarchos_notify',
        { action: 'delete' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
    });

    it('dispatch_compositeHandler_receivesDispatchContext', async () => {
      // Arrange — register a spy as a composite handler to capture what dispatch passes.
      // Uses stubCompositeHandler() (F-021-4) which owns the save/restore dance.
      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      let receivedCtx: unknown;
      const spy = async (_args: Record<string, unknown>, ctx: DispatchContext) => {
        receivedCtx = ctx;
        return { success: true as const, data: { spied: true } };
      };
      const restore = stubCompositeHandler('exarchos_workflow', spy);

      try {
        const ctx: DispatchContext = { stateDir: tmpDir, eventStore, enableTelemetry: false };

        // Act — DR-5: dispatch now validates action names and per-action
        // schemas before routing, so this smoke test uses the `describe`
        // action whose schema accepts empty args.
        await dispatch('exarchos_workflow', { action: 'describe' }, ctx);

        // Assert — handler should receive the full DispatchContext, not just stateDir string
        expect(receivedCtx).toBeDefined();
        expect(typeof receivedCtx).toBe('object');
        expect(receivedCtx).toHaveProperty('stateDir', tmpDir);
        expect(receivedCtx).toHaveProperty('eventStore', eventStore);
        expect(receivedCtx).toHaveProperty('enableTelemetry', false);
      } finally {
        restore();
      }
    });

    it('Dispatch_LeakedHandler_WithoutRegistration_ReturnsUnknownTool', async () => {
      // Arrange — set handler without registering the tool in the registry
      setCustomToolActionHandler('exarchos_leaked', 'run', async () => ({ leaked: true }));

      const { dispatch } = await import('./dispatch.js');

      // Act
      const result = await dispatch(
        'exarchos_leaked',
        { action: 'run' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert — leaked handlers must not be executable without registration
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('UNKNOWN_TOOL');
    });

    it('Dispatch_CustomTool_HandlerReturnsToolResult_PassesThrough', async () => {
      // Arrange — handler returns a ToolResult directly
      const customTool: CompositeTool = {
        name: 'exarchos_passthrough',
        description: 'Passthrough tool',
        actions: [
          {
            name: 'check',
            description: 'Check',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
          {
            name: 'warnings',
            description: 'Return warnings-only result',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
          {
            name: 'noop',
            description: 'Noop',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
          },
        ],
      };
      registerCustomTool(customTool);
      setCustomToolActionHandler('exarchos_passthrough', 'check', async () => {
        return { success: false, error: { code: 'CUSTOM_ERROR', message: 'Custom check failed' } };
      });
      setCustomToolActionHandler('exarchos_passthrough', 'warnings', async () => {
        return { success: true, warnings: ['Deprecated API usage'] };
      });
      setCustomToolActionHandler('exarchos_passthrough', 'noop', async () => ({ success: true }));

      const { dispatch } = await import('./dispatch.js');

      // Act
      const result = await dispatch(
        'exarchos_passthrough',
        { action: 'check' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert — the ToolResult from the handler passes through
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('CUSTOM_ERROR');

      // Act — warnings-only result should pass through (not be wrapped as data)
      const warningsResult = await dispatch(
        'exarchos_passthrough',
        { action: 'warnings' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert — warnings field recognized as ToolResult, not wrapped
      expect(warningsResult.success).toBe(true);
      expect(warningsResult.warnings).toEqual(['Deprecated API usage']);
      expect(warningsResult.data).toBeUndefined();
    });
  });

  describe('parent-tool default-key leak (#1188)', () => {
    it('Dispatch_LeakedSiblingDefaults_DoesNotRejectStrictPerActionSchema', async () => {
      // Reproduces #1188: the MCP SDK applies defaults from the flattened
      // parent schema (via buildRegistrationSchema) to every payload
      // before dispatch sees it. Sibling-action defaults like
      // `nativeIsolation` (from prepare_delegation) and `outputFormat`
      // (from agent_spec) end up on payloads for actions whose schema is
      // .strict() — like `check_tdd_compliance` — causing
      // "Unrecognized key(s) in object" rejections.
      //
      // Dispatch must strip parent-tool defaults that are not declared
      // in the matching action's schema before per-action validation
      // (Tolerant Dispatch). The per-action .strict() guard is
      // preserved for caller-supplied keys.
      const { dispatch } = await import('./dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_tdd_compliance',
          featureId: 'leak-test',
          taskId: 'T1',
          branch: 'feat/leak-test',
          // Leaked defaults from sibling actions — caller never supplies these:
          nativeIsolation: false, // from prepare_delegation
          outputFormat: 'full', // from agent_spec
        },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // The handler may still fail (no real git/test fixtures), but it
      // must NOT fail with INVALID_INPUT mentioning the leaked keys.
      if (!result.success) {
        const message = result.error?.message ?? '';
        expect(message).not.toMatch(/Unrecognized key\(s\)/);
        expect(message).not.toMatch(/nativeIsolation/);
        expect(message).not.toMatch(/outputFormat/);
      }
    });

    it('Dispatch_CallerTypo_StillRejected', async () => {
      // Tolerant Dispatch must NOT swallow caller typos — keys not
      // declared on any action's schema are caller errors and should
      // surface clearly via the per-action .strict() rejection.
      const { dispatch } = await import('./dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_tdd_compliance',
          featureId: 'typo-test',
          taskId: 'T1',
          branch: 'feat/typo-test',
          // Caller-supplied typo — not declared on any orchestrate action.
          totallyMadeUpKey: 'this is a typo',
        },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toMatch(/totallyMadeUpKey/);
    });
  });

  describe('doctor action wiring', () => {
    it('Dispatch_ExarchosOrchestrateDoctor_RoutesToOrchestrateCompositeAndReturnsValidDoctorOutput', async () => {
      // Arrange
      const { dispatch } = await import('./dispatch.js');

      // Act — no args beyond action. Doctor defaults timeoutMs to 2000
      // and all probes are real runtime surfaces, so the call may
      // produce a mix of pass/warning/fail/skipped — but the output
      // shape must parse through DoctorOutputSchema.
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'doctor' },
        { stateDir: tmpDir, eventStore, enableTelemetry: false },
      );

      // Assert — structural: composite handler reached, output has
      // the canonical {checks, summary} shape with a matching tally.
      expect(result.success).toBe(true);
      const data = result.data as {
        checks: { status: string; name: string }[];
        summary: { passed: number; warnings: number; failed: number; skipped: number };
      };
      expect(Array.isArray(data.checks)).toBe(true);
      expect(data.checks.length).toBeGreaterThan(0);
      expect(data.summary).toBeDefined();
      const tallyTotal =
        data.summary.passed + data.summary.warnings + data.summary.failed + data.summary.skipped;
      expect(tallyTotal).toBe(data.checks.length);
    });
  });

  // ─── T-12: session.machinery_consumed dispatch interceptor ─────────────────
  //
  // Plan: docs/plans/2026-05-08-rehydration-machinery-plan.md (T-12)
  // Design: docs/research/2026-05-08-rehydrate-machinery-reinit.md §11.4 (P4)
  //
  // After a `workflow.rehydrated` event lands at sequence S on stream X, the
  // dispatch core must emit ONE `session.machinery_consumed` event the next
  // time a non-rehydrate L5 handler is invoked against stream X — keyed by
  // S, with the action verb captured in `firstActionVerb`. Subsequent
  // invocations on the same rehydrate-sequence are a no-op until another
  // `workflow.rehydrated` lands on the stream. Cross-stream isolation: each
  // stream tracks its own latest-rehydrated-sequence independently.
  //
  // The handler-stub strategy: the interceptor lives in `dispatch()` and is
  // observable purely through the event stream — these tests stub the
  // composite handler with a no-op spy, append a `workflow.rehydrated`
  // event to seed the stream, dispatch a non-rehydrate action, then read
  // the stream and assert on the `session.machinery_consumed` events.
  describe('T-12 session.machinery_consumed interceptor', () => {
    // Helper: clear the per-stream cache between tests so process-local
    // state from one test doesn't leak into the next. The cache is exported
    // for test access only (interceptor module).
    async function resetMachineryCache(): Promise<void> {
      const mod = await import('./interceptors/session-machinery.js');
      mod.__resetMachineryConsumedCache();
    }

    beforeEach(async () => {
      await resetMachineryCache();
    });

    afterEach(async () => {
      await resetMachineryCache();
    });

    // Helper: seed a `workflow.rehydrated` event on the given stream and
    // return the sequence it landed at. Mirrors the production emission
    // shape from `workflow/rehydrate.ts` (projectionSequence/deliveryPath/
    // tokenEstimate). Uses `appendValidated`-equivalent path via the
    // standard `append()` API.
    async function seedRehydrated(streamId: string): Promise<number> {
      const ev = await eventStore.append(streamId, {
        type: 'workflow.rehydrated',
        data: {
          projectionSequence: 1,
          deliveryPath: 'direct',
          tokenEstimate: 100,
        },
      });
      return ev.sequence;
    }

    it('T12_FirstNonRehydrateInvocationAfterRehydrated_EmitsSessionMachineryConsumed', async () => {
      // Arrange — seed a workflow.rehydrated event on the stream, then
      // stub the composite so dispatch resolves cleanly without touching
      // real state files.
      const featureId = 'feat-t12-first';
      const rehydratedSeq = await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: { stub: true },
      }));

      try {
        // Act — invoke a non-rehydrate L5 handler against the stream.
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
        expect(result.success).toBe(true);
      } finally {
        restore();
      }

      // Assert — exactly one session.machinery_consumed event landed on
      // the stream, with rehydrateSequence pointing back at the rehydrated
      // event's sequence and firstActionVerb capturing the dispatched action.
      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
      const data = events[0].data as {
        rehydrateSequence: number;
        firstActionVerb: string;
        firstActionAt: string;
      };
      expect(data.rehydrateSequence).toBe(rehydratedSeq);
      expect(typeof data.firstActionAt).toBe('string');
      // ISO 8601 — Date.parse must succeed.
      expect(Number.isNaN(Date.parse(data.firstActionAt))).toBe(false);
    });

    it('T12_SubsequentInvocationsOnSameRehydrateSequence_NoAdditionalEmissions', async () => {
      // Arrange
      const featureId = 'feat-t12-subsequent';
      await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — three non-rehydrate dispatches against the same stream.
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
        await dispatch(
          'exarchos_workflow',
          { action: 'describe' },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Assert — only the FIRST invocation produced a machinery_consumed.
      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
    });

    it('T12_CrossStreamIsolation_StreamAEmissionDoesNotBlockStreamB', async () => {
      // Arrange — both streams get a workflow.rehydrated, independently.
      const streamA = 'feat-t12-stream-a';
      const streamB = 'feat-t12-stream-b';
      const seqA = await seedRehydrated(streamA);
      const seqB = await seedRehydrated(streamB);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — dispatch against A first, then against B.
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId: streamA },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId: streamB },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Assert — each stream has its own machinery_consumed pointing back
      // at its own rehydrate sequence.
      const eventsA = await eventStore.query(streamA, {
        type: 'session.machinery_consumed',
      });
      const eventsB = await eventStore.query(streamB, {
        type: 'session.machinery_consumed',
      });
      expect(eventsA.length).toBe(1);
      expect(eventsB.length).toBe(1);
      expect((eventsA[0].data as { rehydrateSequence: number }).rehydrateSequence).toBe(seqA);
      expect((eventsB[0].data as { rehydrateSequence: number }).rehydrateSequence).toBe(seqB);
    });

    it('T12_RehydrateActionItself_DoesNotTriggerSessionMachineryConsumed', async () => {
      // Arrange — seed a rehydrated event then dispatch the rehydrate
      // action itself. The interceptor must short-circuit on the rehydrate
      // verb to avoid same-tick recursion (rehydrate emits workflow.rehydrated
      // on success; if the interceptor reacted to that, we'd loop).
      const featureId = 'feat-t12-rehydrate-shortcircuit';
      await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — dispatch the rehydrate action itself. (Stubbed handler so
        // we don't invoke the real rehydrate side effects.)
        await dispatch(
          'exarchos_workflow',
          { action: 'rehydrate', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Assert — no session.machinery_consumed was emitted.
      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(0);
    });

    it('T12_NoWorkflowRehydratedOnStream_NoEmission', async () => {
      // Arrange — fresh stream with no workflow.rehydrated. The interceptor
      // must not emit session.machinery_consumed when there's nothing to
      // correlate against (would carry an undefined rehydrateSequence).
      const featureId = 'feat-t12-no-rehydrate';

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Assert — nothing emitted.
      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(0);
    });

    it('T12_FirstActionVerb_CapturesDispatchedActionName', async () => {
      // Arrange — seed rehydrated, then dispatch a specific verb.
      const featureId = 'feat-t12-verb';
      await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — `get` is a clearly non-rehydrate verb.
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Assert — the firstActionVerb in the emitted event matches the
      // dispatched action name.
      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
      const data = events[0].data as { firstActionVerb: string };
      expect(data.firstActionVerb).toBe('get');
    });
  });
});
