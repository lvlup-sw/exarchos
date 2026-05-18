import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
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
          phaseHasPlaybook: false,
          phasePlaybookComposed: false,
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

  // ─── T-13: session.machinery_consumed idempotency property ─────────────────
  //
  // Plan: docs/plans/2026-05-08-rehydration-machinery-plan.md (T-13)
  // Design: docs/research/2026-05-08-rehydrate-machinery-reinit.md §11.4 (P4)
  //
  // Formalises the contract that T-12 implements:
  //   - Each distinct rehydrate-sequence followed by ≥1 activity produces
  //     exactly ONE `session.machinery_consumed` emission.
  //   - Multiple activity invocations between two rehydrates produce one
  //     emission (process-local cache path).
  //   - After a process restart (cache cleared), a cache-miss defensive query
  //     against the event log prevents a second emission for the same sequence
  //     (cold-start idempotency path).
  //   - Property test: for any sequence of interleaved rehydrate/activity
  //     operations, the count of emitted machinery_consumed events equals the
  //     count of distinct rehydrate-sequences that were followed by ≥1 activity.
  describe('T-13 session.machinery_consumed idempotency property', () => {
    // ── Shared helpers ────────────────────────────────────────────────────────

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

    /**
     * Append a `workflow.rehydrated` event to `streamId` and return the
     * sequence it landed at. Mirrors T-12's `seedRehydrated` helper so both
     * suites share the same fixture shape.
     */
    async function seedRehydratedT13(streamId: string): Promise<number> {
      const ev = await eventStore.append(streamId, {
        type: 'workflow.rehydrated',
        data: {
          projectionSequence: 1,
          deliveryPath: 'direct',
          tokenEstimate: 100,
          phaseHasPlaybook: false,
          phasePlaybookComposed: false,
        },
      });
      return ev.sequence;
    }

    // ── TC-1: two rehydrates produce two distinct emissions ───────────────────
    it('T13_TwoRehydratesSeparatedByActivity_ProduceTwoDistinctEmissions', async () => {
      const featureId = 'feat-t13-two-rehydrates';
      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');

      // First rehydrate
      const seqS1 = await seedRehydratedT13(featureId);
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        // First activity — should emit machinery_consumed with rehydrateSequence: S1
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Validate first emission
      const eventsAfterFirst = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(eventsAfterFirst.length).toBe(1);
      expect((eventsAfterFirst[0].data as { rehydrateSequence: number }).rehydrateSequence).toBe(seqS1);

      // Second rehydrate (S2 > S1)
      const seqS2 = await seedRehydratedT13(featureId);
      expect(seqS2).toBeGreaterThan(seqS1);

      const restore2 = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        // Second activity — should emit machinery_consumed with rehydrateSequence: S2
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore2();
      }

      // Final assertion: exactly two machinery_consumed events with distinct sequences
      const allEvents = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(allEvents.length).toBe(2);
      const seqs = allEvents.map((e) => (e.data as { rehydrateSequence: number }).rehydrateSequence);
      expect(seqs[0]).toBe(seqS1);
      expect(seqs[1]).toBe(seqS2);
      expect(new Set(seqs).size).toBe(2); // distinct
    });

    // ── TC-2: multiple activities between rehydrates produce one emission ─────
    it('T13_MultipleActivitiesBetweenRehydrates_ProduceOneEmission', async () => {
      const featureId = 'feat-t13-multi-activity';
      const seqS1 = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Four activity dispatches — all share the same rehydrate-sequence S1.
        for (let i = 0; i < 4; i++) {
          await dispatch(
            'exarchos_workflow',
            { action: 'get', featureId },
            { stateDir: tmpDir, eventStore, enableTelemetry: false },
          );
        }
      } finally {
        restore();
      }

      // Assert: exactly ONE machinery_consumed with rehydrateSequence: S1.
      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
      expect((events[0].data as { rehydrateSequence: number }).rehydrateSequence).toBe(seqS1);
    });

    // ── TC-3: property test over interleaved rehydrate/activity sequences ─────
    it('T13_Property_EmissionCountEqualsDistinctRehydrateSequencesWithFollowingActivity', async () => {
      // Arbitrary: sequences of up to 5 rehydrates and 20 activity slots.
      // Model: 'rehydrate' | 'activity' in order, cap at 25 total operations.
      // The model predicts: count(machinery_consumed) equals count(distinct
      // rehydrateSequences S for which ≥1 activity follows before the next
      // rehydrate).
      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');

      await fc.assert(
        fc.asyncProperty(
          fc
            .array(
              fc.oneof(
                fc.constant('rehydrate' as const),
                fc.constant('activity' as const),
              ),
              { minLength: 1, maxLength: 25 },
            )
            // Clamp: at most 5 rehydrates in a sequence so the test stays fast.
            .filter(
              (ops) => ops.filter((o) => o === 'rehydrate').length <= 5,
            ),
          async (ops) => {
            // Isolate each property run with a unique feature stream and a
            // fresh cache so process-local state from a prior run can't leak.
            const featureId = `feat-t13-prop-${Math.random().toString(36).slice(2)}`;
            const mod = await import('./interceptors/session-machinery.js');
            mod.__resetMachineryConsumedCache();

            const restore = stubCompositeHandler('exarchos_workflow', async () => ({
              success: true,
              data: {},
            }));

            // Compute the expected emission count from the model BEFORE running:
            // walk through ops and count how many rehydrate-windows contain ≥1 activity.
            let expectedEmissions = 0;
            let inWindow = false;
            for (const op of ops) {
              if (op === 'rehydrate') {
                inWindow = false; // reset window; activity must follow
              } else {
                // op === 'activity'
                if (!inWindow) {
                  // Only count this window if a rehydrate has previously occurred.
                  // We'll check that below by tracking whether we've seen any rehydrate.
                }
              }
            }
            // Recompute cleanly: for each contiguous rehydrate→activity segment
            // (before next rehydrate), count as 1 if rehydrate was followed by ≥1 activity.
            {
              let lastWasRehydrate = false;
              let rehydrateCount = 0;
              expectedEmissions = 0;
              for (const op of ops) {
                if (op === 'rehydrate') {
                  lastWasRehydrate = true;
                  rehydrateCount++;
                } else {
                  // activity
                  if (lastWasRehydrate && rehydrateCount > 0) {
                    expectedEmissions++;
                    lastWasRehydrate = false; // this window is now "consumed"
                  }
                }
              }
            }

            try {
              for (const op of ops) {
                if (op === 'rehydrate') {
                  await eventStore.append(featureId, {
                    type: 'workflow.rehydrated',
                    data: {
                      projectionSequence: 1,
                      deliveryPath: 'direct',
                      tokenEstimate: 100,
                    },
                  });
                } else {
                  await dispatch(
                    'exarchos_workflow',
                    { action: 'get', featureId },
                    { stateDir: tmpDir, eventStore, enableTelemetry: false },
                  );
                }
              }
            } finally {
              restore();
            }

            const emitted = await eventStore.query(featureId, {
              type: 'session.machinery_consumed',
            });
            expect(emitted.length).toBe(expectedEmissions);
          },
        ),
        { numRuns: 50 },
      );
    });

    // ── TC-4: cold-start cache-miss exercises defensive event-log query ────────
    it('T13_ColdStartCacheMiss_DoesNotReemitAfterProcessRestart', async () => {
      const featureId = 'feat-t13-cold-start';
      const seqS = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // First activity — emits machinery_consumed with rehydrateSequence: S,
        // also populates the process-local cache.
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Verify initial emission.
      const eventsBeforeRestart = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(eventsBeforeRestart.length).toBe(1);
      expect(
        (eventsBeforeRestart[0].data as { rehydrateSequence: number }).rehydrateSequence,
      ).toBe(seqS);

      // Simulate process restart: clear the per-stream cache. The event store
      // still holds the original emission. The next dispatch must hit the
      // cache-miss path and perform the defensive event-log query.
      const mod = await import('./interceptors/session-machinery.js');
      mod.__resetMachineryConsumedCache();

      // No new workflow.rehydrated has landed — the sequence hasn't advanced.
      // A second activity dispatch must NOT emit again (defensive query finds
      // the existing machinery_consumed at seqS and short-circuits).
      const restore2 = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore2();
      }

      // Final assertion: still exactly ONE machinery_consumed event.
      const eventsAfterRestart = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(eventsAfterRestart.length).toBe(1);
      expect(
        (eventsAfterRestart[0].data as { rehydrateSequence: number }).rehydrateSequence,
      ).toBe(seqS);
    });

    // ── TC-5: concurrent-emission idempotency-key collapse ────────────────────
    // TODO(T-13): concurrent collapse not exercised here; relies on event-store
    // RT-5 unique-index guarantee. Two concurrent dispatches sharing
    // (streamId, rehydrateSequence) collapse to a single durable event at the
    // AtomicAppender layer via the idempotencyKey UNIQUE constraint. That
    // behaviour is exercised by the atomic-appender suite; this test layer
    // cannot trivially simulate the race without deep concurrency harness work.
    it('T13_IdempotencyKey_SameStreamAndSequence_DoesNotDoubleEmitViaKeyCollapse', async () => {
      // Verify the idempotencyKey on the emitted event carries the canonical
      // format `session.machinery_consumed:<streamId>:<rehydrateSequence>` so
      // the event-store UNIQUE INDEX can perform the collapse.
      const featureId = 'feat-t13-key-format';
      const seqS = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );
      } finally {
        restore();
      }

      // Read the raw event and confirm the idempotencyKey shape.
      const allEvents = await eventStore.query(featureId, {});
      const consumed = allEvents.find((e) => e.type === 'session.machinery_consumed');
      expect(consumed).toBeDefined();
      // The idempotency key is persisted on the event itself (store.ts preserves it).
      const expectedKey = `session.machinery_consumed:${featureId}:${seqS}`;
      expect((consumed as { idempotencyKey?: string }).idempotencyKey).toBe(expectedKey);
    });
  });

  // ─── #1273 / T28 — One-shot vs Tasks-augmented branch at dispatch entry ──
  //
  // The Tasks-augmented branch is opt-in via `args.task: { ttl? }`. Without
  // that key, dispatch MUST preserve the legacy one-shot envelope shape (the
  // primary regression-guard for this PR). With it, dispatch returns the SDK
  // `CreateTaskResult`-shaped data, wrapped in a ToolResult envelope so the
  // outer dispatch surface keeps a single return type for both branches.
  //
  // Unit-level synthesis is covered in `dispatch/tasks-augmented.test.ts`;
  // this block pins the entrypoint behaviour (taskStore wired via
  // DispatchContext, branch selected on the args.task key) and the one-shot
  // path's continued correctness when no augmentation is requested.
  describe('#1273 Tasks-augmented dispatch entrypoint', () => {
    it('DispatchCore_NoTaskOption_ReturnsEnvelope', async () => {
      // Arrange — stub composite returns the canonical one-shot ToolResult.
      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const oneShot = async () => ({
        success: true as const,
        data: { kind: 'one-shot' },
      });
      const restore = stubCompositeHandler('exarchos_workflow', oneShot);
      try {
        const { EventSourcedTaskStore } = await import(
          '../task-store/event-sourced-task-store.js'
        );
        const taskStore = new EventSourcedTaskStore(eventStore);
        const ctx: DispatchContext = {
          stateDir: tmpDir,
          eventStore,
          enableTelemetry: false,
          taskStore,
        };

        // Act — describe action, no `task` key in args.
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe' },
          ctx,
        );

        // Assert — legacy one-shot envelope shape preserved.
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ kind: 'one-shot' });
        // The Tasks-augmented shape (`data.task: { taskId, ... }`) MUST be
        // absent on the one-shot path.
        expect((result.data as { task?: unknown }).task).toBeUndefined();
        // No task-store events were created.
        const allEvents = await eventStore.query('');
        const taskEvents = allEvents.filter((e) => e.type === 'task.created');
        expect(taskEvents).toHaveLength(0);
      } finally {
        restore();
      }
    });

    it('DispatchCore_TaskOptionPresent_ReturnsCreateTaskResult', async () => {
      // Arrange — stub returns one-shot data; Tasks-augmented branch should
      // wrap the call in a CreateTaskResult envelope and return immediately.
      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const oneShot = async () => ({
        success: true as const,
        data: { kind: 'one-shot' },
      });
      const restore = stubCompositeHandler('exarchos_workflow', oneShot);
      try {
        const { EventSourcedTaskStore } = await import(
          '../task-store/event-sourced-task-store.js'
        );
        const taskStore = new EventSourcedTaskStore(eventStore);
        const ctx: DispatchContext = {
          stateDir: tmpDir,
          eventStore,
          enableTelemetry: false,
          taskStore,
        };

        // Act — describe action with `task: { ttl }` augmentation.
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe', task: { ttl: 30_000 } },
          ctx,
        );

        // Assert — SDK CreateTaskResult-shaped data.
        expect(result.success).toBe(true);
        const data = result.data as {
          task?: { taskId?: string; status?: string; ttl?: number | null };
        };
        expect(data.task).toBeDefined();
        expect(typeof data.task!.taskId).toBe('string');
        expect(data.task!.status).toBe('working');
        expect(data.task!.ttl).toBe(30_000);

        // The composite was triggered; a `task.created` event lives on the
        // task-store stream for the synthesised taskId.
        const taskEvents = await eventStore.query(
          `task-store/${data.task!.taskId}`,
        );
        const created = taskEvents.find((e) => e.type === 'task.created');
        expect(created).toBeDefined();
      } finally {
        restore();
      }
    });

    it('DispatchCore_TaskOptionWithoutTaskStore_FallsBackToOneShot', async () => {
      // Defensive: when a caller threads `task: {ttl}` but the DispatchContext
      // has no `taskStore` wired (CLI cold-start, in-process test), dispatch
      // MUST fall back to the one-shot path rather than crashing. This guards
      // the Wave-C-incremental rollout where some contexts still lack the
      // taskStore handle.
      const { stubCompositeHandler, dispatch } = await import('./dispatch.js');
      const oneShot = async () => ({
        success: true as const,
        data: { kind: 'one-shot-no-store' },
      });
      const restore = stubCompositeHandler('exarchos_workflow', oneShot);
      try {
        const ctx: DispatchContext = {
          stateDir: tmpDir,
          eventStore,
          enableTelemetry: false,
          // intentionally no taskStore
        };
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe', task: { ttl: 30_000 } },
          ctx,
        );
        expect(result.success).toBe(true);
        expect((result.data as { kind?: string }).kind).toBe('one-shot-no-store');
      } finally {
        restore();
      }
    });
  });

  // ─── F1 regression: dispatch preserves inbound _meta correlation block ─
  //
  // Issue #1414 / plan task-1 (2026-05-16-correlation-indexed-columns):
  //   The dispatch entry point must propagate caller-supplied
  //   `_meta.correlationId` and `_meta.causationId` onto the returned
  //   `ToolResult._meta` (both success AND error envelopes), while
  //   freshly minting `operationId` on every call. The fix landed inline
  //   at `dispatch.ts:604` via #1428's post-merge hardening (incoming
  //   correlation parse → `mintDispatchContext({correlationId, causationId})`
  //   → `attachMeta` non-destructive merge with caller wins at lines
  //   614-632). This test locks that contract so a future refactor of
  //   the per-action validation / workspace-resolution branches cannot
  //   silently drop the caller's correlation chain.
  //
  // Test strategy: use `exarchos_workflow/get` with a non-existent
  // featureId — the handler returns a NOT_FOUND error envelope, which
  // exercises the error branch of `attachMeta` and proves _meta is
  // attached even when `success === false`.
  it('Dispatch_BuiltInTool_PreservesInbound_meta', async () => {
    // Arrange
    const { dispatch } = await import('./dispatch.js');
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const inboundCorrelationId = 'corr-from-caller-7';
    const inboundCausationId = 'event-upstream-3';

    // Act — minimal DispatchContext: memory-backed event store + tmpDir,
    // no MCP roots, no elicitation client, no rootsClient. The featureId
    // 'test-feature' is intentionally absent from the store; we only
    // care about _meta propagation, which happens on both success and
    // error envelopes (dispatch.ts:614-632).
    const result = await dispatch(
      'exarchos_workflow',
      {
        action: 'get',
        featureId: 'test-feature',
        _meta: {
          correlationId: inboundCorrelationId,
          causationId: inboundCausationId,
        },
      },
      { stateDir: tmpDir, eventStore, enableTelemetry: false },
    );

    // Assert — _meta block present regardless of success/error branch.
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect(meta, `Expected result._meta to be present. Got: ${JSON.stringify(result)}`).toBeDefined();
    expect(meta!.correlationId).toBe(inboundCorrelationId);
    expect(meta!.causationId).toBe(inboundCausationId);
    // operationId is always freshly minted per dispatch — never inherited
    // from caller — and must be a UUID v4 string.
    expect(typeof meta!.operationId).toBe('string');
    expect(meta!.operationId as string).toMatch(UUID_RE);
  });

  // T1 (#1446 residue) — DR-5 dispatch validation for the three view
  // actions that were dispatched through `views/composite.ts` but missing
  // from `TOOL_REGISTRY.viewActions`. Before T1, dispatching with bad args
  // returned the generic "unknown action" error from dispatch.ts:650-657
  // (action not in registry), so callers could not distinguish "the action
  // doesn't exist" from "the action exists but the args are malformed".
  // After T1, the same path that fires for Wave 5 actions post-#1437 must
  // also fire here: the action is found, the per-action schema rejects the
  // malformed input, and the envelope carries the Zod issue path (the field
  // name the caller got wrong).
  describe('T1 — DR-5 dispatch validation for newly registered view actions', () => {
    const NEWLY_REGISTERED_VIEW_ACTIONS = [
      'session_provenance',
      'provenance',
      'ideate_readiness',
    ] as const;

    for (const action of NEWLY_REGISTERED_VIEW_ACTIONS) {
      it(`ExarchosViewDispatch_OnInvalidArgsForNewlyRegisteredAction_ReturnsZodValidationError_${action}`, async () => {
        const { dispatch } = await import('./dispatch.js');

        // workflowId is declared as `z.string().optional()` on every one of
        // the three new schemas, so passing a number triggers a `z.string`
        // type-mismatch — the canonical post-T1 Zod surface, distinct from
        // the pre-T1 "unknown action" surface.
        const result = await dispatch(
          'exarchos_view',
          { action, workflowId: 123 },
          { stateDir: tmpDir, eventStore, enableTelemetry: false },
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');

        const message = result.error?.message ?? '';
        // Post-T1: Zod validation fires. The message MUST reference the
        // offending field path (`workflowId`) — that's the discriminator
        // between the per-action validation envelope and the registry's
        // "unknown action" envelope. Pre-T1 the message reads:
        //   `exarchos_view: unknown action "<action>". Valid actions: ...`
        // which contains the action name but never the field name.
        expect(
          message,
          `Expected Zod validation to reject 'workflowId: 123' for action ` +
            `'${action}'. Got: ${message}`,
        ).toMatch(/workflowId/);
        expect(
          message,
          `Expected '${action}' to be a registered action (post-T1). ` +
            `Got "unknown action" envelope: ${message}`,
        ).not.toMatch(/unknown action/i);
      });
    }
  });
});
