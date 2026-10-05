import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { z } from 'zod';
import ts from 'typescript';
import { EventStore } from '../../../../src/events/store.js';
import {
  DISPATCH_RETURN_CLASSES,
  RETURN_CLASS_APPLICABILITY,
  applicableReturnClasses,
  runEmissionVerifierInterceptor,
  verifyDeclaredEmissions,
  type DispatchReturnClass,
} from '../../../../src/dispatch/core/interceptors/emission-verifier.js';
import type { AutoEmission } from '../../../../src/registry.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  registerCustomTool,
  clearCustomTools,
  setCustomToolActionHandler,
} from '../../../../src/registry.js';
import type { CompositeTool } from '../../../../src/registry.js';
import { none, type ActionContract } from '../../../../src/registry/action-contract.js';

const FIXTURE_CONTRACT: ActionContract = {
  requires: none('dispatch fixture has no additional obligations'),
  ensures: none('dispatch fixture has no durable postcondition'),
  needs: none('dispatch fixture declares no capabilities'),
  touches: {
    frame: 'single-machine',
    resources: none('dispatch fixture touches no durable resources'),
  },
  executionAuthority: { kind: 'local' },
  replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  emissions: none('dispatch fixture emits no events'),
};
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { extractSingleMissingRequiredField } from '../../../../src/dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
} from '../../../../src/workflow/capabilities/resolver.js';
import { InMemoryBackend } from '../../../../src/storage/memory-backend.js';
import type { StorageBackend } from '../../../../src/storage/backend.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('dispatch', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-test-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  function ctx(extra: Partial<DispatchContext> = {}): DispatchContext {
    return {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      callerIdentity: deriveLocalOperatorIdentity(tmpDir),
      ...extra,
    };
  }

  /**
   * `DispatchContext` carries an optional `storage: StorageBackend` field, so startup can inject
   * the backend once. No typecheck covers this test file, so the regex over the interface source
   * is the real check.
   */
  it('DispatchContext_TypeShape_IncludesStorageField', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const dispatchSrc = readFileSync(resolve(__dirname, '../../../../src/dispatch/core/dispatch.ts'), 'utf-8');
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

    const backend: StorageBackend = new InMemoryBackend();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      storage: backend,
    };
    expect(ctx.storage).toBe(backend);
  });

  /** The call can fail because no state exists. The assertions accept any `ToolResult`. */
  it('Dispatch_KnownTool_CallsHandler', async () => {
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'test-feature' },
      ctx(),
    );

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('Dispatch_UnknownTool_ReturnsError', async () => {
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

    const result = await dispatch(
      'nonexistent_tool',
      {},
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('UNKNOWN_TOOL');
    expect(result.error!.message).toContain('nonexistent_tool');
  });

  /**
   * The injected loader throws, like a broken module graph after a partial install. The test
   * replaces the real loader and deletes the cached handler, so dispatch calls the injected one.
   * Dispatch must return a structured failure and must not let the module error escape.
   */
  it('Dispatch_LoadCompositeHandlerThrows_ReturnsCompositeLoadFailed', async () => {
    const { COMPOSITE_HANDLERS, COMPOSITE_HANDLER_LOADERS, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
    const toolName = 'exarchos_workflow';
    const origLoader = COMPOSITE_HANDLER_LOADERS[toolName];
    const origCache = COMPOSITE_HANDLERS[toolName];
    delete COMPOSITE_HANDLERS[toolName];
    COMPOSITE_HANDLER_LOADERS[toolName] = () =>
      Promise.reject(new Error("Cannot find module '../workflow/composite.js'"));

    try {
      const result = await dispatch(
        toolName,
        { action: 'get', featureId: 'test' },
        ctx(),
      );

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
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'test-feature' },
      { stateDir: tmpDir, eventStore, enableTelemetry: true },
    );

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
            actionContract: FIXTURE_CONTRACT,
          },
          {
            name: 'status',
            description: 'Get deployment status',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
            actionContract: FIXTURE_CONTRACT,
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

      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_deploy',
        { action: 'trigger', target: 'production' },
        ctx(),
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ deployed: true, target: 'production' });
    });

    it('Dispatch_CustomTool_MissingAction_ReturnsError', async () => {
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
            actionContract: FIXTURE_CONTRACT,
          },
          {
            name: 'cancel',
            description: 'Cancel CI',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
            actionContract: FIXTURE_CONTRACT,
          },
        ],
      };
      registerCustomTool(customTool);
      setCustomToolActionHandler('exarchos_ci', 'run', async () => ({ ok: true }));
      setCustomToolActionHandler('exarchos_ci', 'cancel', async () => ({ ok: true }));

      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_ci',
        {},
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('MISSING_ACTION');
    });

    it('Dispatch_CustomTool_UnknownAction_ReturnsError', async () => {
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
            actionContract: FIXTURE_CONTRACT,
          },
          {
            name: 'list',
            description: 'List notifications',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
            actionContract: FIXTURE_CONTRACT,
          },
        ],
      };
      registerCustomTool(customTool);
      setCustomToolActionHandler('exarchos_notify', 'send', async () => ({ sent: true }));
      setCustomToolActionHandler('exarchos_notify', 'list', async () => ({ items: [] }));

      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_notify',
        { action: 'delete' },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
    });

    /**
     * Dispatch validates the action name and the action schema before it routes. Thus the test
     * uses the `describe` action, whose schema accepts empty args. The handler must receive the
     * full `DispatchContext` and not only the state directory.
     */
    it('dispatch_compositeHandler_receivesDispatchContext', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      let receivedCtx: unknown;
      const spy = async (_args: Record<string, unknown>, ctx: DispatchContext) => {
        receivedCtx = ctx;
        return { success: true as const, data: { spied: true } };
      };
      const restore = stubCompositeHandler('exarchos_workflow', spy);

      try {
        const dispatchCtx = ctx();

        await dispatch('exarchos_workflow', { action: 'describe' }, dispatchCtx);

        expect(receivedCtx).toBeDefined();
        expect(typeof receivedCtx).toBe('object');
        expect(receivedCtx).toHaveProperty('stateDir', tmpDir);
        expect(receivedCtx).toHaveProperty('eventStore', eventStore);
        expect(receivedCtx).toHaveProperty('enableTelemetry', false);
      } finally {
        restore();
      }
    });

    /** A handler for a tool that is not in the registry must not be executable. */
    it('Dispatch_LeakedHandler_WithoutRegistration_ReturnsUnknownTool', async () => {
      setCustomToolActionHandler('exarchos_leaked', 'run', async () => ({ leaked: true }));

      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_leaked',
        { action: 'run' },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('UNKNOWN_TOOL');
    });

    /**
     * A handler result that is already a `ToolResult` passes through. Dispatch does not wrap a
     * warnings-only result as `data`.
     */
    it('Dispatch_CustomTool_HandlerReturnsToolResult_PassesThrough', async () => {
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
            actionContract: FIXTURE_CONTRACT,
          },
          {
            name: 'warnings',
            description: 'Return warnings-only result',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
            actionContract: FIXTURE_CONTRACT,
          },
          {
            name: 'noop',
            description: 'Noop',
            schema: z.object({}).passthrough(),
            phases: new Set<string>(),
            roles: new Set<string>(['any']),
            actionContract: FIXTURE_CONTRACT,
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

      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_passthrough',
        { action: 'check' },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('CUSTOM_ERROR');

      const warningsResult = await dispatch(
        'exarchos_passthrough',
        { action: 'warnings' },
        ctx(),
      );

      expect(warningsResult.success).toBe(true);
      expect(warningsResult.warnings).toEqual(['Deprecated API usage']);
      expect(warningsResult.data).toBeUndefined();
    });
  });

  describe('parent-tool default-key leak (#1188)', () => {
    /**
     * The MCP SDK applies the defaults of the flattened parent schema to each payload. Thus the
     * sibling defaults `nativeIsolation` and `outputFormat` arrive on a `check_test_adequacy` call,
     * whose schema is `.strict()`. Dispatch must remove the sibling defaults that the action does
     * not declare. The handler can still fail for another reason, but not on those keys.
     */
    it('Dispatch_LeakedSiblingDefaults_DoesNotRejectStrictPerActionSchema', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_test_adequacy',
          featureId: 'leak-test',
          taskId: 'T1',
          branch: 'feat/leak-test',
          nativeIsolation: false,
          outputFormat: 'full',
        },
        ctx(),
      );

      if (!result.success) {
        const message = result.error?.message ?? '';
        expect(message).not.toMatch(/Unrecognized key\(s\)/);
        expect(message).not.toMatch(/nativeIsolation/);
        expect(message).not.toMatch(/outputFormat/);
      }
    });

    /**
     * A key that no action of the tool declares is a caller error. Dispatch must still reject it.
     */
    it('Dispatch_CallerTypo_StillRejected', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_test_adequacy',
          featureId: 'typo-test',
          taskId: 'T1',
          branch: 'feat/typo-test',
          totallyMadeUpKey: 'this is a typo',
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toMatch(/totallyMadeUpKey/);
    });
  });

  /**
   * These tests go through `dispatch()`, the path of a real MCP or CLI caller, and not through a
   * direct handler call. The prune schema is `.passthrough().superRefine(...)`, so the removed
   * `thresholdMinutes` knob gets an actionable error before the handler runs. A plain `z.object`
   * strips the key and accepts the call.
   */
  describe('DR-9 prune removed-knob rejection (real dispatch seam)', () => {
    /** The message must name the removed knob and `topology.yaml`, where the setting now lives. */
    it('Dispatch_PruneLegacyThresholdMinutes_ActionableRemovalError', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'prune_stale_workflows',
          dryRun: true,
          thresholdMinutes: 60,
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      const message = result.error?.message ?? '';
      expect(message).toContain('thresholdMinutes');
      expect(message).toContain('#1334');
      expect(message).toContain('DR-9');
      expect(message).toContain('topology.yaml');
    });

    /**
     * The remaining prune options still parse. The handler can fail on missing fixtures, but not
     * with the removed-knob message.
     */
    it('Dispatch_PruneValidArgs_NotRejectedByRemovedKnobGuard', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'prune_stale_workflows', dryRun: true, includeOneShot: false },
        ctx(),
      );

      if (!result.success) {
        expect(result.error?.message ?? '').not.toContain('was removed (DR-9)');
      }
    });

    /**
     * `now` is a test-only clock override. It is a known key that is not in the schema shape, so
     * the refinement must let it reach the handler. The ISO-validation error of the handler proves
     * that it did.
     */
    it('Dispatch_PruneNowOverride_ReachesHandlerClockValidation', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'prune_stale_workflows', dryRun: true, now: 'not-a-date' },
        ctx(),
      );

      expect(result.success).toBe(false);
      const message = result.error?.message ?? '';
      expect(message).toContain('now must be a valid ISO datetime string');
      expect(message).not.toContain('unrecognized');
    });
  });

  describe('doctor action wiring', () => {
    /**
     * The probes are real runtime surfaces, so the statuses vary. The output must still have the
     * `{checks, summary}` shape, and the tally must equal the number of checks. The resolver holds
     * only a cache-hint capability, as in the production CLI. That capability is not an action
     * need, so admission must use the grant of the local operator.
     */
    it('Dispatch_ExarchosOrchestrateDoctor_RoutesToOrchestrateCompositeAndReturnsValidDoctorOutput', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'doctor' },
        ctx({
          capabilityResolver: createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]),
        }),
      );

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

    it('Dispatch_Doctor_AnonymousCaller_RequiresTrustedCaller', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'doctor' },
        {
          stateDir: tmpDir,
          eventStore,
          enableTelemetry: false,
        },
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TRUSTED_CALLER_REQUIRED');
    });

    it('Dispatch_DeclaredRequires_MissingStoreFacts_IsAdmissionDenied', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'check_invariant_conformance', featureId: 'feat-no-events' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ADMISSION_DENIED');
    });
  });

  describe('execute_intent action wiring', () => {
    /**
     * `execute_intent` declares `requires: none(...)`. A cold dispatch from a trusted local
     * operator must pass admission and reach the refusal of the handler. An unregistered intent
     * name gives that refusal and runs no real segment.
     */
    it('Dispatch_ExecuteIntent_ColdDispatch_ClearsAdmissionAndReachesTheHandler', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'execute_intent', intent: 'not-a-real-runbook', featureId: 'feat-execute-sanity' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).not.toBe('ADMISSION_DENIED');
      expect(result.error?.code).not.toBe('TRUSTED_CALLER_REQUIRED');
      expect(result.error?.code).toBe('INTENT_UNKNOWN');
    });
  });

  /**
   * After a `workflow.rehydrated` event at sequence S, the next non-rehydrate dispatch on that
   * stream emits one `session.machinery_consumed` event. The event carries `rehydrateSequence` S
   * and the action name. Later calls emit nothing until the next rehydrate, and each stream is
   * independent.
   *
   * The tests stub the composite handler, seed the stream with `seedRehydrated`, dispatch, and
   * read the stream. `resetMachineryCache` clears the process-local cache around each test.
   */
  describe('T-12 session.machinery_consumed interceptor', () => {
    async function resetMachineryCache(): Promise<void> {
      const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
      mod.__resetMachineryConsumedCache();
    }

    beforeEach(async () => {
      await resetMachineryCache();
    });

    afterEach(async () => {
      await resetMachineryCache();
    });

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
      const featureId = 'feat-t12-first';
      const rehydratedSeq = await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: { stub: true },
      }));

      try {
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
        expect(result.success).toBe(true);
      } finally {
        restore();
      }

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
      expect(Number.isNaN(Date.parse(data.firstActionAt))).toBe(false);
    });

    /**
     * Two `get` calls target the stream. The `describe` call carries no `featureId`, so it names
     * no stream.
     */
    it('T12_SubsequentInvocationsOnSameRehydrateSequence_NoAdditionalEmissions', async () => {
      const featureId = 'feat-t12-subsequent';
      await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
        await dispatch(
          'exarchos_workflow',
          { action: 'describe' },
          ctx(),
        );
      } finally {
        restore();
      }

      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
    });

    it('T12_CrossStreamIsolation_StreamAEmissionDoesNotBlockStreamB', async () => {
      const streamA = 'feat-t12-stream-a';
      const streamB = 'feat-t12-stream-b';
      const seqA = await seedRehydrated(streamA);
      const seqB = await seedRehydrated(streamB);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId: streamA },
          ctx(),
        );
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId: streamB },
          ctx(),
        );
      } finally {
        restore();
      }

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

    /**
     * The interceptor skips the `rehydrate` action. A successful rehydrate emits
     * `workflow.rehydrated`, so a reaction in the same dispatch causes a loop.
     */
    it('T12_RehydrateActionItself_DoesNotTriggerSessionMachineryConsumed', async () => {
      const featureId = 'feat-t12-rehydrate-shortcircuit';
      await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'rehydrate', featureId },
          ctx(),
        );
      } finally {
        restore();
      }

      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(0);
    });

    /**
     * With no `workflow.rehydrated` event there is no sequence to refer to, so the interceptor
     * emits nothing.
     */
    it('T12_NoWorkflowRehydratedOnStream_NoEmission', async () => {
      const featureId = 'feat-t12-no-rehydrate';

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore();
      }

      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(0);
    });

    it('T12_FirstActionVerb_CapturesDispatchedActionName', async () => {
      const featureId = 'feat-t12-verb';
      await seedRehydrated(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore();
      }

      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
      const data = events[0].data as { firstActionVerb: string };
      expect(data.firstActionVerb).toBe('get');
    });
  });

  /**
   * The idempotency contract of the interceptor. Each rehydrate sequence that at least one
   * activity follows gives exactly one `session.machinery_consumed` event. The process-local
   * cache stops a repeat in one process. After a restart, a query of the event log stops a
   * second emission for the same sequence. `seedRehydratedT13` appends a `workflow.rehydrated`
   * event and returns its sequence.
   */
  describe('T-13 session.machinery_consumed idempotency property', () => {
    async function resetMachineryCache(): Promise<void> {
      const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
      mod.__resetMachineryConsumedCache();
    }

    beforeEach(async () => {
      await resetMachineryCache();
    });

    afterEach(async () => {
      await resetMachineryCache();
    });

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

    it('T13_TwoRehydratesSeparatedByActivity_ProduceTwoDistinctEmissions', async () => {
      const featureId = 'feat-t13-two-rehydrates';
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const seqS1 = await seedRehydratedT13(featureId);
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore();
      }

      const eventsAfterFirst = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(eventsAfterFirst.length).toBe(1);
      expect((eventsAfterFirst[0].data as { rehydrateSequence: number }).rehydrateSequence).toBe(seqS1);

      const seqS2 = await seedRehydratedT13(featureId);
      expect(seqS2).toBeGreaterThan(seqS1);

      const restore2 = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore2();
      }

      const allEvents = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(allEvents.length).toBe(2);
      const seqs = allEvents.map((e) => (e.data as { rehydrateSequence: number }).rehydrateSequence);
      expect(seqs[0]).toBe(seqS1);
      expect(seqs[1]).toBe(seqS2);
      expect(new Set(seqs).size).toBe(2);
    });

    it('T13_MultipleActivitiesBetweenRehydrates_ProduceOneEmission', async () => {
      const featureId = 'feat-t13-multi-activity';
      const seqS1 = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        for (let i = 0; i < 4; i++) {
          await dispatch(
            'exarchos_workflow',
            { action: 'get', featureId },
            ctx(),
          );
        }
      } finally {
        restore();
      }

      const events = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(events.length).toBe(1);
      expect((events[0].data as { rehydrateSequence: number }).rehydrateSequence).toBe(seqS1);
    });

    /**
     * Each run holds up to 25 operations, a rehydrate or an activity each, with at most 5
     * rehydrates. The model counts one emission for each rehydrate that an activity follows before
     * the next rehydrate. Each run uses its own stream and a cleared cache. The first loop over
     * `ops` computes nothing, and the block after it computes the expected count.
     */
    it('T13_Property_EmissionCountEqualsDistinctRehydrateSequencesWithFollowingActivity', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

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
            .filter(
              (ops) => ops.filter((o) => o === 'rehydrate').length <= 5,
            ),
          async (ops) => {
            const featureId = `feat-t13-prop-${Math.random().toString(36).slice(2)}`;
            const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
            mod.__resetMachineryConsumedCache();

            const restore = stubCompositeHandler('exarchos_workflow', async () => ({
              success: true,
              data: {},
            }));

            let expectedEmissions = 0;
            let inWindow = false;
            for (const op of ops) {
              if (op === 'rehydrate') {
                inWindow = false;
              } else {
                if (!inWindow) {
                }
              }
            }
            {
              let lastWasRehydrate = false;
              let rehydrateCount = 0;
              expectedEmissions = 0;
              for (const op of ops) {
                if (op === 'rehydrate') {
                  lastWasRehydrate = true;
                  rehydrateCount++;
                } else {
                  if (lastWasRehydrate && rehydrateCount > 0) {
                    expectedEmissions++;
                    lastWasRehydrate = false;
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
                    ctx(),
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

    /**
     * A cleared cache simulates a process restart, and the store still holds the first emission.
     * No new `workflow.rehydrated` event lands. The next dispatch misses the cache, finds the
     * emission in the event log, and emits nothing.
     */
    it('T13_ColdStartCacheMiss_DoesNotReemitAfterProcessRestart', async () => {
      const featureId = 'feat-t13-cold-start';
      const seqS = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore();
      }

      const eventsBeforeRestart = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(eventsBeforeRestart.length).toBe(1);
      expect(
        (eventsBeforeRestart[0].data as { rehydrateSequence: number }).rehydrateSequence,
      ).toBe(seqS);

      const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
      mod.__resetMachineryConsumedCache();

      const restore2 = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore2();
      }

      const eventsAfterRestart = await eventStore.query(featureId, {
        type: 'session.machinery_consumed',
      });
      expect(eventsAfterRestart.length).toBe(1);
      expect(
        (eventsAfterRestart[0].data as { rehydrateSequence: number }).rehydrateSequence,
      ).toBe(seqS);
    });

    /**
     * This test checks only the format of the idempotency key on the stored event:
     * `session.machinery_consumed:<streamId>:<rehydrateSequence>`. It does not run two concurrent
     * dispatches. The event store uses that key to collapse a race into one event, and the
     * atomic-appender race suite covers that collapse.
     */
    it('T13_IdempotencyKey_SameStreamAndSequence_DoesNotDoubleEmitViaKeyCollapse', async () => {
      const featureId = 'feat-t13-key-format';
      const seqS = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));
      try {
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
        );
      } finally {
        restore();
      }

      const allEvents = await eventStore.query(featureId, {});
      const consumed = allEvents.find((e) => e.type === 'session.machinery_consumed');
      expect(consumed).toBeDefined();
      const expectedKey = `session.machinery_consumed:${featureId}:${seqS}`;
      expect((consumed as { idempotencyKey?: string }).idempotencyKey).toBe(expectedKey);
    });
  });

  /**
   * The Tasks-augmented branch is opt-in through `args.task`. Without that key, dispatch returns
   * the one-shot envelope. With it, dispatch returns data in the shape of the SDK
   * `CreateTaskResult` inside a `ToolResult`, so both branches have one return type.
   * `dispatch/tasks-augmented.test.ts` covers the synthesis itself.
   */
  describe('#1273 Tasks-augmented dispatch entrypoint', () => {
    it('DispatchCore_NoTaskOption_ReturnsEnvelope', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const oneShot = async () => ({
        success: true as const,
        data: { kind: 'one-shot' },
      });
      const restore = stubCompositeHandler('exarchos_workflow', oneShot);
      try {
        const { EventSourcedTaskStore } = await import(
          '../../../../src/projections/task-store/event-sourced-task-store.js'
        );
        const taskStore = new EventSourcedTaskStore(eventStore);
        const dispatchCtx = ctx({ taskStore });

        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe' },
          dispatchCtx,
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ kind: 'one-shot' });
        expect((result.data as { task?: unknown }).task).toBeUndefined();
        const allEvents = await eventStore.query('');
        const taskEvents = allEvents.filter((e) => e.type === 'task.created');
        expect(taskEvents).toHaveLength(0);
      } finally {
        restore();
      }
    });

    /**
     * With `task: { ttl }`, dispatch returns a working task at once. A `task.created` event is on
     * the stream of the new task.
     */
    it('DispatchCore_TaskOptionPresent_ReturnsCreateTaskResult', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const oneShot = async () => ({
        success: true as const,
        data: { kind: 'one-shot' },
      });
      const restore = stubCompositeHandler('exarchos_workflow', oneShot);
      try {
        const { EventSourcedTaskStore } = await import(
          '../../../../src/projections/task-store/event-sourced-task-store.js'
        );
        const taskStore = new EventSourcedTaskStore(eventStore);
        const dispatchCtx = ctx({ taskStore });

        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe', task: { ttl: 30_000 } },
          dispatchCtx,
        );

        expect(result.success).toBe(true);
        const data = result.data as {
          task?: { taskId?: string; status?: string; ttl?: number | null };
        };
        expect(data.task).toBeDefined();
        expect(typeof data.task!.taskId).toBe('string');
        expect(data.task!.status).toBe('working');
        expect(data.task!.ttl).toBe(30_000);

        const taskEvents = await eventStore.query(
          `task-store/${data.task!.taskId}`,
        );
        const created = taskEvents.find((e) => e.type === 'task.created');
        expect(created).toBeDefined();
      } finally {
        restore();
      }
    });

    /**
     * A context with no `taskStore`, such as a CLI cold start, must use the one-shot path and must
     * not fail when the call carries `task`.
     */
    it('DispatchCore_TaskOptionWithoutTaskStore_FallsBackToOneShot', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const oneShot = async () => ({
        success: true as const,
        data: { kind: 'one-shot-no-store' },
      });
      const restore = stubCompositeHandler('exarchos_workflow', oneShot);
      try {
        const dispatchCtx = ctx();
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe', task: { ttl: 30_000 } },
          dispatchCtx,
        );
        expect(result.success).toBe(true);
        expect((result.data as { kind?: string }).kind).toBe('one-shot-no-store');
      } finally {
        restore();
      }
    });
  });

  /**
   * Dispatch must copy the `_meta.correlationId` and `_meta.causationId` of the caller to the
   * result, and it mints a new UUID `operationId` for each call. The test accepts a success or
   * an error, because dispatch attaches `_meta` to both.
   */
  it('Dispatch_BuiltInTool_PreservesInbound_meta', async () => {
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const inboundCorrelationId = 'corr-from-caller-7';
    const inboundCausationId = 'event-upstream-3';

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
      ctx(),
    );

    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect(meta, `Expected result._meta to be present. Got: ${JSON.stringify(result)}`).toBeDefined();
    expect(meta!.correlationId).toBe(inboundCorrelationId);
    expect(meta!.causationId).toBe(inboundCausationId);
    expect(typeof meta!.operationId).toBe('string');
    expect(meta!.operationId as string).toMatch(UUID_RE);
  });

  /**
   * The listed view actions are in the registry, so dispatch finds the action and its schema
   * rejects malformed input. `workflowId` is an optional string on each schema, so a number
   * fails. The error must name the field `workflowId`. An "unknown action" error names no field,
   * and it means that the action is not in the registry.
   */
  describe('T1 — DR-5 dispatch validation for newly registered view actions', () => {
    const NEWLY_REGISTERED_VIEW_ACTIONS = [
      'session_provenance',
      'provenance',
    ] as const;

    for (const action of NEWLY_REGISTERED_VIEW_ACTIONS) {
      it(`ExarchosViewDispatch_OnInvalidArgsForNewlyRegisteredAction_ReturnsZodValidationError_${action}`, async () => {
        const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

        const result = await dispatch(
          'exarchos_view',
          { action, workflowId: 123 },
          ctx(),
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');

        const message = result.error?.message ?? '';
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

  /**
   * Zod v4 puts no `received` property on an `invalid_type` issue. The helper accepts an absent
   * `received` (Zod v4) and the string `'undefined'` (Zod v3). Its `input !== undefined` check
   * still tells a wrong type from a missing field.
   */
  describe('extractSingleMissingRequiredField — Zod v4 issue shape (#1451)', () => {
    /** A real Zod v4 parse of an empty payload gives the issue shape that production sees. */
    it('ExtractSingleMissingRequiredField_ZodV4MissingFieldNoReceivedProperty_ReturnsKey', () => {
      const schema = z.object({ featureId: z.string() });
      const parsed = schema.safeParse({}, { reportInput: true });

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const issue = parsed.error.issues[0] as { received?: unknown };
      expect('received' in issue).toBe(false);

      const result = extractSingleMissingRequiredField(parsed.error);

      expect(result).toBe('featureId');
    });

    /**
     * With `reportInput: true` the issue carries `input: 42`, so the helper rejects a wrong type
     * before the `received` check.
     */
    it('ExtractSingleMissingRequiredField_ZodV4WrongTypeNumber_ReturnsUndefined', () => {
      const schema = z.object({ featureId: z.string() });
      const parsed = schema.safeParse({ featureId: 42 }, { reportInput: true });

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const issue = parsed.error.issues[0] as { input?: unknown };
      expect(issue.input).toBe(42);

      const result = extractSingleMissingRequiredField(parsed.error);

      expect(result).toBeUndefined();
    });
  });

  /**
   * A task-suitable action that runs longer than 10,000 ms without `task: { ttl }` gets a
   * `retry_with_task` entry first in `next_actions`. The rule has three conditions: the action
   * is `taskSuitable`, the call has no task augmentation, and the elapsed time is above the
   * threshold. Each negative test breaks one condition. `exarchos_workflow.cleanup` declares
   * `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 }`.
   *
   * `installClockSequence` mocks `Date.now`, so no test waits. The first call returns the first
   * value, and each later call returns the last value. The first call must be the read at
   * dispatch entry. A `Date.now` call before that read makes the elapsed time 0.
   */
  describe('retry_with_task hint (Preview-4 §4.4)', () => {
    let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
      if (dateNowSpy) {
        dateNowSpy.mockRestore();
        dateNowSpy = undefined;
      }
    });

    function installClockSequence(values: readonly number[]): void {
      let i = 0;
      dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        const v = values[Math.min(i, values.length - 1)];
        i++;
        return v;
      });
    }

    it('RetryWithTaskHint_TaskSuitableActionWithoutTaskTtlExceededThreshold_PrependsHint', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true },
      });
      const restore = stubCompositeHandler('exarchos_workflow', stub);

      installClockSequence([0, 11_000]);

      try {
        const result = await dispatch(
          'exarchos_workflow',
          {
            action: 'cleanup',
            featureId: 'hint-test',
            mergeVerified: true,
          },
          ctx(),
        );

        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string; reason: string; ttl_suggestion_ms?: number }[] }).next_actions;
        expect(nextActions).toBeDefined();
        expect(nextActions!.length).toBeGreaterThanOrEqual(1);
        const hint = nextActions![0];
        expect(hint.verb).toBe('retry_with_task');
        expect(hint.ttl_suggestion_ms).toBe(60_000);
        expect(typeof hint.reason).toBe('string');
        expect(hint.reason).toMatch(/11000ms|Tasks-augmented/);
      } finally {
        restore();
      }
    });

    /** The elapsed time is 9,999 ms. The rule uses `>`, so 10,000 ms also gives no hint. */
    it('RetryWithTaskHint_ElapsedBelowThreshold_HintNotEmitted', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true },
      });
      const restore = stubCompositeHandler('exarchos_workflow', stub);

      installClockSequence([0, 9_999]);

      try {
        const result = await dispatch(
          'exarchos_workflow',
          {
            action: 'cleanup',
            featureId: 'hint-below-threshold',
            mergeVerified: true,
          },
          ctx(),
        );

        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string }[] }).next_actions;
        if (nextActions !== undefined && nextActions.length > 0) {
          expect(nextActions[0].verb).not.toBe('retry_with_task');
        }
        const hasHint = (nextActions ?? []).some((n) => n.verb === 'retry_with_task');
        expect(hasHint).toBe(false);
      } finally {
        restore();
      }
    });

    /**
     * `exarchos_view describe` does not declare `dispatch.taskSuitable`, so a long elapsed time
     * gives no hint.
     */
    it('RetryWithTaskHint_ActionNotTaskSuitable_HintNotEmitted', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true, actions: [] },
      });
      const restore = stubCompositeHandler('exarchos_view', stub);

      installClockSequence([0, 30_000]);

      try {
        const result = await dispatch(
          'exarchos_view',
          { action: 'describe', actions: ['cleanup'] },
          ctx(),
        );

        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string }[] }).next_actions;
        const hasHint = (nextActions ?? []).some((n) => n.verb === 'retry_with_task');
        expect(hasHint).toBe(false);
      } finally {
        restore();
      }
    });

    /**
     * The caller already sent `task: { ttl }`. This context has no `taskStore`, so the call uses
     * the one-shot path. The suppression must depend on the request of the caller and not on the
     * path that ran. Otherwise a fallback caller gets a hint to retry with the TTL that it sent.
     */
    it('RetryWithTaskHint_TaskTtlAlreadyThreaded_HintNotEmitted', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true },
      });
      const restore = stubCompositeHandler('exarchos_workflow', stub);

      installClockSequence([0, 30_000]);

      try {
        const result = await dispatch(
          'exarchos_workflow',
          {
            action: 'cleanup',
            featureId: 'hint-task-threaded',
            mergeVerified: true,
            task: { ttl: 60_000 },
          },
          ctx(),
        );

        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string }[] }).next_actions;
        const hasHint = (nextActions ?? []).some((n) => n.verb === 'retry_with_task');
        expect(hasHint).toBe(false);
      } finally {
        restore();
      }
    });

    /**
     * The full dispatch flow for `merge_orchestrate`, with a stubbed composite handler. The stub
     * returns one `next_actions` entry. Dispatch must put the hint before that entry and still
     * attach the `_meta` correlation block.
     */
    it('Dispatch_SlowTaskSuitableAction_EmitsRetryWithTaskHintInMeta', async () => {
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { mergeSha: 'abc1234', strategy: 'squash' },
        next_actions: [
          { verb: 'completed', reason: 'merge finished' },
        ],
      });
      const restore = stubCompositeHandler('exarchos_orchestrate', stub);

      installClockSequence([0, 12_500]);

      try {
        const result = await dispatch(
          'exarchos_orchestrate',
          {
            action: 'merge_orchestrate',
            featureId: 'integration-hint',
            sourceBranch: 'feat/x',
            targetBranch: 'main',
            strategy: 'squash',
          },
          ctx(),
        );

        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string; ttl_suggestion_ms?: number }[] }).next_actions;
        expect(nextActions).toBeDefined();
        expect(nextActions!.length).toBe(2);
        expect(nextActions![0].verb).toBe('retry_with_task');
        expect(nextActions![0].ttl_suggestion_ms).toBe(60_000);
        expect(nextActions![1].verb).toBe('completed');
        const meta = (result as ToolResult & { _meta?: Record<string, unknown> })._meta;
        expect(meta).toBeDefined();
        expect(typeof meta!.operationId).toBe('string');
      } finally {
        restore();
      }
    });
  });
});

/** One `return` in dispatch()'s own control flow, classified. */
interface ClassifiedReturn {
  readonly line: number;
  readonly start: number;
  readonly cls: DispatchReturnClass;
  readonly text: string;
}

interface DispatchStructure {
  readonly returns: readonly ClassifiedReturn[];
  /** End offset of the verifier call — an applicable return must lie beyond it. */
  readonly verifierCallEnd: number;
  /** Start offset of the statement wrapping that call (the seeding anchor). */
  readonly verifierStatementStart: number;
  /** End offset of the last statement that invokes the raw tool handler. */
  readonly handlerRegionEnd: number;
}

const VERIFIER_CALLEE = 'runEmissionVerifierInterceptor';
const SCOPE_CALLEE = 'runWithDispatchContext';
const HANDLER_BINDING = 'coreHandler';

/** A nested function owns its returns. Only the flow of `dispatch()` itself is in scope. */
function isOwnScopeFunction(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

/**
 * Classifies each return site in `dispatch()`. A missing anchor throws. An anchor that reads as
 * offset 0 makes each comparison a constant, and then the assertion always passes.
 *
 * The callback of `runWithDispatchContext` is the continuation of `dispatch()`, so its returns
 * count. The walk skips all other nested functions. The `return` of that call is the scope entry
 * and is not a site. The outer `try` is a direct statement of the scope body. The handler region
 * ends at the last statement of that `try` block that uses `coreHandler`. The declaration name
 * of `coreHandler` is not a use.
 */
function classifyDispatchReturns(source: string): DispatchStructure {
  const sf = ts.createSourceFile(
    'dispatch.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let dispatchFn: ts.FunctionDeclaration | undefined;
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'dispatch') {
      dispatchFn = statement;
    }
  }
  const body = dispatchFn?.body;
  if (body === undefined) {
    throw new Error('structural gate: no `dispatch` function declaration found in dispatch.ts');
  }

  const calleeNameOf = (node: ts.CallExpression): string | undefined =>
    ts.isIdentifier(node.expression) ? node.expression.text : undefined;

  let scopeBody: ts.Node | undefined;
  const findScope = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeNameOf(node) === SCOPE_CALLEE) {
      const continuation = node.arguments[1];
      if (continuation !== undefined && ts.isArrowFunction(continuation)) {
        scopeBody = continuation.body;
      }
    }
    ts.forEachChild(node, findScope);
  };
  findScope(body);
  if (scopeBody === undefined) {
    throw new Error(
      `structural gate: no \`${SCOPE_CALLEE}(ctx, async () => …)\` scope found in dispatch() — ` +
        'the async-local anchor was renamed or removed. Update this gate to track it.',
    );
  }

  let outerTry: ts.TryStatement | undefined;
  if (ts.isBlock(scopeBody)) {
    for (const statement of scopeBody.statements) {
      if (ts.isTryStatement(statement)) outerTry = statement;
    }
  }
  if (outerTry === undefined) {
    throw new Error('structural gate: no outer try/catch inside the dispatch async-local scope');
  }
  const catchClause = outerTry.catchClause;

  const mentionsHandler = (node: ts.Node): boolean => {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === HANDLER_BINDING) {
        const parent: ts.Node | undefined = n.parent;
        if (parent === undefined || !ts.isVariableDeclaration(parent) || parent.name !== n) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };
  let handlerRegionEnd = -1;
  for (const statement of outerTry.tryBlock.statements) {
    if (mentionsHandler(statement)) handlerRegionEnd = statement.end;
  }
  if (handlerRegionEnd < 0) {
    throw new Error(
      `structural gate: no statement invoking \`${HANDLER_BINDING}\` found in dispatch()'s try ` +
        'block — the handler anchor was renamed. Update this gate to track it.',
    );
  }

  let verifierCall: ts.CallExpression | undefined;
  const findVerifier = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeNameOf(node) === VERIFIER_CALLEE) {
      verifierCall = node;
    }
    ts.forEachChild(node, findVerifier);
  };
  findVerifier(body);
  if (verifierCall === undefined) {
    throw new Error(
      `structural gate: dispatch() never calls \`${VERIFIER_CALLEE}\`. The post-dispatch ` +
        'emission verifier is not installed in the shipped chain, so every handler-completing ' +
        'branch bypasses it.',
    );
  }
  let verifierStatement: ts.Node = verifierCall;
  while (!ts.isStatement(verifierStatement) && verifierStatement.parent !== undefined) {
    verifierStatement = verifierStatement.parent;
  }

  const inCatch = (node: ts.Node): boolean =>
    catchClause !== undefined &&
    node.getStart(sf) >= catchClause.getStart(sf) &&
    node.end <= catchClause.end;

  const returns: ClassifiedReturn[] = [];
  const collect = (node: ts.Node): void => {
    if (isOwnScopeFunction(node)) return;
    if (ts.isReturnStatement(node)) {
      const expression = node.expression;
      const isScopeEntry =
        expression !== undefined &&
        ts.isCallExpression(expression) &&
        calleeNameOf(expression) === SCOPE_CALLEE;
      if (!isScopeEntry) {
        const start = node.getStart(sf);
        returns.push({
          line: sf.getLineAndCharacterOfPosition(start).line + 1,
          start,
          cls: inCatch(node)
            ? 'handler-threw'
            : start > handlerRegionEnd
              ? 'handler-completing'
              : 'pre-handler',
          text: (source.slice(start, start + 72).split('\n')[0] ?? '').trim(),
        });
      }
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(body, collect);
  ts.forEachChild(scopeBody, collect);

  return {
    returns,
    verifierCallEnd: verifierCall.end,
    verifierStatementStart: verifierStatement.getStart(sf),
    handlerRegionEnd,
  };
}

/**
 * The return sites that bypass the verifier. The declared policy makes each one applicable, but
 * control leaves `dispatch()` before the call. The filter reads `RETURN_CLASS_APPLICABILITY` and
 * no fixed class name, so a changed entry moves the obligation.
 */
function bypassingReturns(structure: DispatchStructure): readonly ClassifiedReturn[] {
  const applicable = new Set(applicableReturnClasses());
  return structure.returns.filter(
    (site) => applicable.has(site.cls) && site.start < structure.verifierCallEnd,
  );
}

/**
 * The verifier reports only on a dispatch that reaches it. These tests read the `dispatch()`
 * source and classify each return site by the state of the handler at that point. Each class
 * that `RETURN_CLASS_APPLICABILITY` declares applicable must go through the verifier call.
 *
 * The declaration keeps the assertion honest. An assertion over each return is always red on
 * the refusal branches that reach no handler. An assertion cut down to the green set covers
 * nothing.
 */
describe('emission verifier — structural reachability', () => {
  const DISPATCH_SOURCE_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../src/dispatch/core/dispatch.ts',
  );

  /**
   * The denominators come first: each of the three declared classes must have a return site in
   * the live function. A classifier that finds no `handler-completing` site reports an empty
   * bypass set, which reads as a pass. The pre-handler branches are exempt by declaration, with
   * the reason `handler-did-not-run`. Then comes the subject: no applicable return leaves
   * `dispatch()` before the verifier call.
   */
  it('EmissionVerifier_EveryHandlerCompletingBranch_ReachesIt', () => {
    const source = readFileSync(DISPATCH_SOURCE_PATH, 'utf-8');
    const structure = classifyDispatchReturns(source);

    const byClass = new Map<DispatchReturnClass, ClassifiedReturn[]>();
    for (const cls of DISPATCH_RETURN_CLASSES) byClass.set(cls, []);
    for (const site of structure.returns) byClass.get(site.cls)?.push(site);

    for (const cls of DISPATCH_RETURN_CLASSES) {
      expect(
        byClass.get(cls)?.length ?? 0,
        `structural gate found no '${cls}' return site in dispatch(). The classification is no ` +
          'longer total over the live function, so the bypass set below is not trustworthy.',
      ).toBeGreaterThan(0);
    }
    expect(structure.returns.length).toBe(
      DISPATCH_RETURN_CLASSES.reduce((n, cls) => n + (byClass.get(cls)?.length ?? 0), 0),
    );

    expect(RETURN_CLASS_APPLICABILITY['pre-handler']).toEqual({
      applicable: false,
      reason: 'handler-did-not-run',
    });
    expect(RETURN_CLASS_APPLICABILITY['handler-threw']).toEqual({
      applicable: false,
      reason: 'handler-threw',
    });
    expect(RETURN_CLASS_APPLICABILITY['handler-completing']).toEqual({ applicable: true });

    const bypassing = bypassingReturns(structure);
    expect(
      bypassing.map((site) => `line ${site.line}: ${site.text}`),
      'A branch returns from dispatch() with a completed handler behind it without reaching ' +
        `\`${VERIFIER_CALLEE}\`. That branch is unverified: its action's unconditional emission ` +
        'contract is never read back. Either route it through the verifier, or declare its ' +
        'return class inapplicable in RETURN_CLASS_APPLICABILITY with a reason.',
    ).toEqual([]);
  });

  /**
   * The live tree must be clean first, or the seed proves nothing. The seed is one early return
   * after the handler and before the verifier call, which reads as a guard clause. The seeded
   * tree must hold one more `handler-completing` return than the clean tree. Thus the seed is an
   * addition and not a reclassified site.
   */
  it('EmissionVerifier_SeededBypassingBranch_FailsTheAssertion', () => {
    const source = readFileSync(DISPATCH_SOURCE_PATH, 'utf-8');

    expect(bypassingReturns(classifyDispatchReturns(source))).toEqual([]);

    const anchor = classifyDispatchReturns(source).verifierStatementStart;
    const seeded =
      source.slice(0, anchor) +
      'if (result.success === false) { return attachMeta(result); }\n  ' +
      source.slice(anchor);

    const seededStructure = classifyDispatchReturns(seeded);
    const caught = bypassingReturns(seededStructure);

    expect(
      caught.length,
      'The structural assertion did not redden on a seeded bypassing branch, so it cannot ' +
        'redden on a real one either.',
    ).toBe(1);
    expect(caught[0]?.cls).toBe('handler-completing');
    expect(caught[0]?.start ?? -1).toBeLessThan(seededStructure.verifierCallEnd);
    expect(caught[0]?.start ?? -1).toBeGreaterThan(seededStructure.handlerRegionEnd);

    const completing = (s: DispatchStructure): number =>
      s.returns.filter((r) => r.cls === 'handler-completing').length;
    expect(completing(seededStructure)).toBe(completing(classifyDispatchReturns(source)) + 1);
  });
});

describe('emission verifier — contract evaluation', () => {
  const edge = (event: string, condition: 'always' | 'conditional'): AutoEmission => ({
    event,
    condition,
    role: 'primary',
    owner: 'test',
  });

  /**
   * An action with only conditional edges promises nothing unconditionally, so the verdict is
   * `not-applicable` and not `ok`. A conditional event that lands also cannot satisfy an
   * unconditional edge that did not land.
   */
  it('EmissionVerifier_ConditionalOnlyAction_IsNotApplicableRatherThanOk', () => {
    const verdict = verifyDeclaredEmissions({
      declared: [
        edge('workflow.compensation', 'conditional'),
        edge('workflow.pruned', 'conditional'),
      ],
      streamId: 'feat-x',
      landed: [],
    });
    expect(verdict.status).toBe('not-applicable');
    expect(verdict.reason).toBe('no-unconditional-contract');
    expect(verdict.required).toEqual([]);

    const mixed = verifyDeclaredEmissions({
      declared: [edge('workflow.started', 'always'), edge('workflow.compensation', 'conditional')],
      streamId: 'feat-x',
      landed: ['workflow.compensation'],
    });
    expect(mixed.status).toBe('violated');
    expect(mixed.missingEvents).toEqual(['workflow.started']);
    expect(mixed.required).toEqual(['workflow.started']);
  });

  /**
   * The verdict lists each missing event and not only the first. Otherwise each repair shows
   * the next miss.
   */
  it('EmissionVerifier_MissingUnconditionalEmissions_ReportsTheFullSet', () => {
    const verdict = verifyDeclaredEmissions({
      declared: [
        edge('vcs.requested', 'always'),
        edge('vcs.executed', 'always'),
        edge('promotion.executed', 'always'),
      ],
      streamId: 'feat-x',
      landed: ['vcs.requested'],
    });
    expect(verdict.status).toBe('violated');
    expect(verdict.missingEvents).toEqual(['promotion.executed', 'vcs.executed']);

    const clean = verifyDeclaredEmissions({
      declared: [edge('vcs.requested', 'always'), edge('vcs.executed', 'always')],
      streamId: 'feat-x',
      landed: ['vcs.executed', 'vcs.requested', 'workflow.transition'],
    });
    expect(clean.status).toBe('ok');
    expect(clean.missingEvents).toEqual([]);
  });

  /**
   * The finding must stay after the run, so the verifier appends `emission.violated` to the
   * stream.
   */
  it('EmissionVerifier_UnlandedContract_AppendsTheViolationToTheLog', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'emission-verifier-'));
    const store = new EventStore(tmp);
    await store.initialize();
    try {
      const verdict = await runEmissionVerifierInterceptor(store, {
        tool: 'exarchos_workflow',
        action: 'init',
        operationId: 'op-emission-1',
        streamId: 'feat-verifier',
        declared: [edge('workflow.started', 'always')],
      });
      expect(verdict.status).toBe('violated');
      expect(verdict.missingEvents).toEqual(['workflow.started']);

      const written = await store.query('feat-verifier', { type: 'emission.violated' });
      expect(written.length).toBe(1);
      expect(written[0]?.data).toMatchObject({
        action: 'exarchos_workflow.init',
        missingEvents: ['workflow.started'],
        operationId: 'op-emission-1',
      });
    } finally {
      await store.close();
      await rmrfAsync(tmp);
    }
  });

  /**
   * A store that the verifier cannot read gives no answer. The verdict is `indeterminate`, not
   * `ok` and not `not-applicable`. The verifier must not throw, because a throw fails a dispatch
   * that worked.
   */
  it('EmissionVerifier_UnreadableStore_IsIndeterminateAndNeverThrows', async () => {
    const failingStore = {
      query: vi.fn().mockRejectedValue(new Error('boom — synthetic store failure')),
      append: vi.fn(),
    } as unknown as EventStore;

    const verdict = await runEmissionVerifierInterceptor(failingStore, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-emission-2',
      streamId: 'feat-verifier',
      declared: [edge('workflow.started', 'always')],
    });
    expect(verdict.status).toBe('indeterminate');
    expect(verdict.cause).toBe('store-unavailable');
    expect(verdict.reason).toBeUndefined();
    expect(failingStore.append).not.toHaveBeenCalled();
  });

  /**
   * The read finds a real miss, but the append of the finding fails. The run holds no durable
   * answer, so the verdict is `indeterminate` with the cause `verification-fault`.
   */
  it('EmissionVerifier_UnrecordableFinding_IsIndeterminateRatherThanSilentlyDropped', async () => {
    const halfBrokenStore = {
      query: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockRejectedValue(new Error('boom — synthetic append failure')),
    } as unknown as EventStore;

    const verdict = await runEmissionVerifierInterceptor(halfBrokenStore, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-emission-4',
      streamId: 'feat-verifier',
      declared: [edge('workflow.started', 'always')],
    });
    expect(verdict.status).toBe('indeterminate');
    expect(verdict.cause).toBe('verification-fault');
  });

  it('EmissionVerifier_NoUnconditionalContract_TouchesTheStoreNotAtAll', async () => {
    const store = {
      query: vi.fn(),
      append: vi.fn(),
    } as unknown as EventStore;

    const verdict = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_view',
      action: 'describe',
      operationId: 'op-emission-3',
      streamId: 'feat-verifier',
      declared: undefined,
    });
    expect(verdict.status).toBe('not-applicable');
    expect(verdict.reason).toBe('no-unconditional-contract');
    expect(store.query).not.toHaveBeenCalled();
  });
});
