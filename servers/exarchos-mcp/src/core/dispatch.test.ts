import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
});
