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
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

    // Act — call a known tool (exarchos_workflow with 'get' action)
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'test-feature' },
      ctx(),
    );

    // Assert — should return a ToolResult (may fail due to missing state, but should route)
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('Dispatch_UnknownTool_ReturnsError', async () => {
    // Arrange
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

    // Act
    const result = await dispatch(
      'nonexistent_tool',
      {},
      ctx(),
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
    const { COMPOSITE_HANDLERS, COMPOSITE_HANDLER_LOADERS, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
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
        ctx(),
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
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

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

      // Act
      const result = await dispatch(
        'exarchos_deploy',
        { action: 'trigger', target: 'production' },
        ctx(),
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

      // Act — no action field
      const result = await dispatch(
        'exarchos_ci',
        {},
        ctx(),
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

      // Act — nonexistent action
      const result = await dispatch(
        'exarchos_notify',
        { action: 'delete' },
        ctx(),
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
    });

    it('dispatch_compositeHandler_receivesDispatchContext', async () => {
      // Arrange — register a spy as a composite handler to capture what dispatch passes.
      // Uses stubCompositeHandler() (F-021-4) which owns the save/restore dance.
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      let receivedCtx: unknown;
      const spy = async (_args: Record<string, unknown>, ctx: DispatchContext) => {
        receivedCtx = ctx;
        return { success: true as const, data: { spied: true } };
      };
      const restore = stubCompositeHandler('exarchos_workflow', spy);

      try {
        const dispatchCtx = ctx();

        // Act — DR-5: dispatch now validates action names and per-action
        // schemas before routing, so this smoke test uses the `describe`
        // action whose schema accepts empty args.
        await dispatch('exarchos_workflow', { action: 'describe' }, dispatchCtx);

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

      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      // Act
      const result = await dispatch(
        'exarchos_leaked',
        { action: 'run' },
        ctx(),
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

      // Act
      const result = await dispatch(
        'exarchos_passthrough',
        { action: 'check' },
        ctx(),
      );

      // Assert — the ToolResult from the handler passes through
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('CUSTOM_ERROR');

      // Act — warnings-only result should pass through (not be wrapped as data)
      const warningsResult = await dispatch(
        'exarchos_passthrough',
        { action: 'warnings' },
        ctx(),
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
      // .strict() — like `check_test_adequacy` — causing
      // "Unrecognized key(s) in object" rejections.
      //
      // Dispatch must strip parent-tool defaults that are not declared
      // in the matching action's schema before per-action validation
      // (Tolerant Dispatch). The per-action .strict() guard is
      // preserved for caller-supplied keys.
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_test_adequacy',
          featureId: 'leak-test',
          taskId: 'T1',
          branch: 'feat/leak-test',
          // Leaked defaults from sibling actions — caller never supplies these:
          nativeIsolation: false, // from prepare_delegation
          outputFormat: 'full', // from agent_spec
        },
        ctx(),
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
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_test_adequacy',
          featureId: 'typo-test',
          taskId: 'T1',
          branch: 'feat/typo-test',
          // Caller-supplied typo — not declared on any orchestrate action.
          totallyMadeUpKey: 'this is a typo',
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toMatch(/totallyMadeUpKey/);
    });
  });

  // ─── DR-9 (#1334): removed prune knob — actionable rejection on the REAL ────
  // dispatch seam. This is the ARBITER for the fix: it exercises the same
  // `dispatch()` path a real MCP/CLI caller travels (per-action Zod validation
  // at core/dispatch.ts), not a direct handler call casting past the type
  // boundary. Pre-fix the prune action schema was a plain `z.object` that
  // SILENTLY STRIPPED `thresholdMinutes`, so `parsed.data` reached the handler
  // without it — a silent accept. The schema is now
  // `.passthrough().superRefine(...)`, so the removed knob draws an ACTIONABLE
  // removal error here, before the handler ever runs.
  describe('DR-9 prune removed-knob rejection (real dispatch seam)', () => {
    it('Dispatch_PruneLegacyThresholdMinutes_ActionableRemovalError', async () => {
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'prune_stale_workflows',
          dryRun: true,
          // Legacy REMOVED knob (DR-9). A real caller reaches this through
          // `dispatch()`; the parse must fail BEFORE the handler runs.
          thresholdMinutes: 60,
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      // The actionable message names the removed knob, the deprecation lineage
      // (#1334), the removal marker (DR-9), and the real config surface
      // (`topology.yaml`) — NOT an opaque `unrecognized_keys`.
      const message = result.error?.message ?? '';
      expect(message).toContain('thresholdMinutes');
      expect(message).toContain('#1334');
      expect(message).toContain('DR-9');
      expect(message).toContain('topology.yaml');
    });

    it('Dispatch_PruneValidArgs_NotRejectedByRemovedKnobGuard', async () => {
      // Premise guard: the surviving prune options still parse — the
      // passthrough+refine mechanism must not reject valid callers. The handler
      // may still fail on missing fixtures, but NOT with an INVALID_INPUT that
      // mentions the removed-knob message.
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

    it('Dispatch_PruneNowOverride_ReachesHandlerClockValidation', async () => {
      // `now` is a test-only ISO clock override the handler reads + validates.
      // It is a passthrough key (PRUNE_ACTION_KNOWN_KEYS), NOT part of the
      // schema shape, so the passthrough+superRefine seam must let it reach the
      // handler rather than rejecting it as unrecognized. Proven by the
      // HANDLER's ISO-validation error firing — not a schema rejection.
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
    it('Dispatch_ExarchosOrchestrateDoctor_RoutesToOrchestrateCompositeAndReturnsValidDoctorOutput', async () => {
      // Arrange
      const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

      // Act — no args beyond action. Doctor defaults timeoutMs to 2000
      // and all probes are real runtime surfaces, so the call may
      // produce a mix of pass/warning/fail/skipped — but the output
      // shape must parse through DoctorOutputSchema.
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'doctor' },
        ctx({
          // Production CLI wires a cache-hint resolver that is not the
          // ActionId need set. Admission must use the local-operator
          // snapshot grant, not resolver.list().
          capabilityResolver: createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]),
        }),
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

  // ─── T-12: session.machinery_consumed dispatch interceptor ─────────────────
  //
  // Plan: docs/plans/archive/2026-05-08-rehydration-machinery-plan.md (T-12)
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
      const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: { stub: true },
      }));

      try {
        // Act — invoke a non-rehydrate L5 handler against the stream.
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — three non-rehydrate dispatches against the same stream.
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — dispatch against A first, then against B.
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
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
          ctx(),
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const restore = stubCompositeHandler('exarchos_workflow', async () => ({
        success: true,
        data: {},
      }));

      try {
        // Act — `get` is a clearly non-rehydrate verb.
        await dispatch(
          'exarchos_workflow',
          { action: 'get', featureId },
          ctx(),
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
  // Plan: docs/plans/archive/2026-05-08-rehydration-machinery-plan.md (T-13)
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
      const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
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
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

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
          ctx(),
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
          ctx(),
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

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
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
            ctx(),
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
            // Clamp: at most 5 rehydrates in a sequence so the test stays fast.
            .filter(
              (ops) => ops.filter((o) => o === 'rehydrate').length <= 5,
            ),
          async (ops) => {
            // Isolate each property run with a unique feature stream and a
            // fresh cache so process-local state from a prior run can't leak.
            const featureId = `feat-t13-prop-${Math.random().toString(36).slice(2)}`;
            const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
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

    // ── TC-4: cold-start cache-miss exercises defensive event-log query ────────
    it('T13_ColdStartCacheMiss_DoesNotReemitAfterProcessRestart', async () => {
      const featureId = 'feat-t13-cold-start';
      const seqS = await seedRehydratedT13(featureId);

      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
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
          ctx(),
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
      const mod = await import('../../../../src/dispatch/core/interceptors/session-machinery.js');
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
          ctx(),
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

        // Act — describe action, no `task` key in args.
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe' },
          dispatchCtx,
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

        // Act — describe action with `task: { ttl }` augmentation.
        const result = await dispatch(
          'exarchos_workflow',
          { action: 'describe', task: { ttl: 30_000 } },
          dispatchCtx,
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
    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
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
      ctx(),
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
  // actions that were dispatched through `projections/views/composite.ts` but missing
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
    ] as const;

    for (const action of NEWLY_REGISTERED_VIEW_ACTIONS) {
      it(`ExarchosViewDispatch_OnInvalidArgsForNewlyRegisteredAction_ReturnsZodValidationError_${action}`, async () => {
        const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

        // workflowId is declared as `z.string().optional()` on every one of
        // the three new schemas, so passing a number triggers a `z.string`
        // type-mismatch — the canonical post-T1 Zod surface, distinct from
        // the pre-T1 "unknown action" surface.
        const result = await dispatch(
          'exarchos_view',
          { action, workflowId: 123 },
          ctx(),
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

  // ─── #1451 — extractSingleMissingRequiredField under Zod v4 ─────────────
  //
  // Zod v4 dropped the non-standard `received` property from
  // `invalid_type` issues. The pre-fix narrowing required
  // `issue.received === 'undefined'` (a Zod v3-only string signal), so under
  // Zod v4 the helper rejected every missing-field issue and elicitation
  // never fired. The dual-signal fix accepts either:
  //   - `received === 'undefined'` (Zod v3 string signal), OR
  //   - `received === undefined`   (property absent — Zod v4 shape).
  // The `input !== undefined` check at the top of the helper still
  // disambiguates wrong-type from missing-field, so the relaxed `received`
  // gate cannot regress CodeRabbit CRITICAL #1424.
  describe('extractSingleMissingRequiredField — Zod v4 issue shape (#1451)', () => {
    it('ExtractSingleMissingRequiredField_ZodV4MissingFieldNoReceivedProperty_ReturnsKey', () => {
      // Arrange — real Zod v4 parse of an empty payload against a single
      // required string field. This grounds the test in the actual issue
      // shape Zod v4 emits in production rather than a hand-rolled stub.
      const schema = z.object({ featureId: z.string() });
      const parsed = schema.safeParse({}, { reportInput: true });

      expect(parsed.success).toBe(false);
      if (parsed.success) return; // type-narrow for TS
      // Sanity: Zod v4 omits `received` entirely on missing-field issues.
      const issue = parsed.error.issues[0] as { received?: unknown };
      expect('received' in issue).toBe(false);

      // Act
      const result = extractSingleMissingRequiredField(parsed.error);

      // Assert — helper must return the missing key, not undefined.
      expect(result).toBe('featureId');
    });

    it('ExtractSingleMissingRequiredField_ZodV4WrongTypeNumber_ReturnsUndefined', () => {
      // Arrange — caller passed a number where a string was expected. In
      // Zod v4 the issue shape includes `input: 42` (populated because of
      // reportInput: true), and the `input !== undefined` guard at the top
      // of the helper screens this out — never reaching the `received`
      // gate. The helper must continue to refuse to elicit on wrong type.
      const schema = z.object({ featureId: z.string() });
      const parsed = schema.safeParse({ featureId: 42 }, { reportInput: true });

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const issue = parsed.error.issues[0] as { input?: unknown };
      expect(issue.input).toBe(42);

      // Act
      const result = extractSingleMissingRequiredField(parsed.error);

      // Assert — wrong-type must NOT be treated as missing.
      expect(result).toBeUndefined();
    });
  });

  // ─── T11 (#1440 Op 4) — retry_with_task hint emission ─────────────────
  //
  // When a `dispatch.taskSuitable === true` action is invoked WITHOUT a
  // `task: { ttl }` augmentation and the dispatch elapsed time exceeds
  // the threshold (default 10_000 ms), the dispatch boundary prepends a
  // `{ verb: 'retry_with_task', reason, ttl_suggestion_ms }` next-action
  // to `result.next_actions`. This teaches callers the augmentation
  // surface through use (design 2026-05-17-preview-4 §4.4).
  //
  // The annotation is sourced from the action's `dispatch.taskSuitable`
  // and `dispatch.taskTtlSuggestionMs` fields in the registry. The
  // canonical fixture is `exarchos_workflow.cleanup` which carries
  // `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 }`.
  describe('retry_with_task hint (Preview-4 §4.4)', () => {
    let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
      if (dateNowSpy) {
        dateNowSpy.mockRestore();
        dateNowSpy = undefined;
      }
    });

    /**
     * Install a `Date.now` spy that returns a deterministic sequence of
     * timestamps. Used to drive the hint's elapsed-time check without
     * actually waiting >10s. The dispatch core does not call `Date.now`
     * anywhere else in its own body, so this spy only interacts with the
     * hint emission path (plus any composite-level perf accounting,
     * which is bypassed when we stub the composite handler directly).
     */
    function installClockSequence(values: readonly number[]): void {
      let i = 0;
      dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        const v = values[Math.min(i, values.length - 1)];
        i++;
        return v;
      });
    }

    it('RetryWithTaskHint_TaskSuitableActionWithoutTaskTtlExceededThreshold_PrependsHint', async () => {
      // Arrange — stub the workflow composite to short-circuit the real
      // cleanup pipeline. The stub returns a minimal success envelope
      // with no pre-existing next_actions so the assertion can focus on
      // the boundary-injected hint.
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true },
      });
      const restore = stubCompositeHandler('exarchos_workflow', stub);

      // Drive Date.now: 0 at dispatch entry, 11_000 after handler
      // returns. 11_000 > 10_000 threshold so the hint fires.
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

        // Assert — the hint is the FIRST entry in next_actions.
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

    // ─── T12 — Negative paths ────────────────────────────────────────────
    //
    // The emission rule is conditional on three predicates ANDed together
    // (taskSuitable && !taskAugmented && elapsedMs > threshold). Each
    // negative test breaks exactly one predicate to pin the boundary.

    it('RetryWithTaskHint_ElapsedBelowThreshold_HintNotEmitted', async () => {
      // Arrange — same task-suitable action (`cleanup`), no `task: { ttl }`,
      // but elapsed = 9_999 ms which is below the 10_000 ms threshold.
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true },
      });
      const restore = stubCompositeHandler('exarchos_workflow', stub);

      // 0 → 9_999: strictly below 10_000 (the rule uses `>` not `>=`, so
      // even exactly 10_000 would still suppress the hint).
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

        // Assert — no retry_with_task entry in next_actions (it may be
        // absent or empty, but if present must not start with the hint).
        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string }[] }).next_actions;
        if (nextActions !== undefined && nextActions.length > 0) {
          expect(nextActions[0].verb).not.toBe('retry_with_task');
        }
        // Stronger: no entry anywhere in the array is the hint verb.
        const hasHint = (nextActions ?? []).some((n) => n.verb === 'retry_with_task');
        expect(hasHint).toBe(false);
      } finally {
        restore();
      }
    });

    it('RetryWithTaskHint_ActionNotTaskSuitable_HintNotEmitted', async () => {
      // Arrange — `exarchos_view describe` is NOT annotated with
      // `dispatch.taskSuitable` (read-only pure introspection over the
      // registry). Even with a long elapsed time, the hint must not fire.
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true, actions: [] },
      });
      const restore = stubCompositeHandler('exarchos_view', stub);

      installClockSequence([0, 30_000]); // way above threshold

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

    it('RetryWithTaskHint_TaskTtlAlreadyThreaded_HintNotEmitted', async () => {
      // Arrange — caller threaded `task: { ttl: 60_000 }`, so the hint
      // would be tautological. Even with elapsed > threshold and a
      // task-suitable action, the emission must be suppressed.
      //
      // Note: the underlying `runTasksAugmented` path requires
      // `ctx.taskStore` and capability gating to actually fire; without
      // them (as here), `taskAugmented` is true but the call falls back
      // to one-shot. The hint suppression must depend on `taskAugmented`
      // (the caller's stated intent), NOT on whether the task path
      // actually engaged — otherwise a fallback caller would receive a
      // confusing hint to retry with the same TTL they already supplied.
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { ok: true },
      });
      const restore = stubCompositeHandler('exarchos_workflow', stub);

      installClockSequence([0, 30_000]); // above threshold

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

    // ─── T12 — Integration test ──────────────────────────────────────────
    //
    // End-to-end through the full dispatch flow (correlation context,
    // built-in action validation, composite invocation, attachMeta) for
    // a task-suitable annotated action. The composite handler is stubbed
    // to short-circuit the real merge orchestration logic but the rest
    // of the dispatch pipeline runs unchanged.

    it('Dispatch_SlowTaskSuitableAction_EmitsRetryWithTaskHintInMeta', async () => {
      // Arrange — stub `exarchos_orchestrate` so `merge_orchestrate`
      // returns a minimal envelope without performing real VCS work.
      // The boundary hint emission runs AFTER this stub returns.
      const { stubCompositeHandler, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
      const stub = async (_args: Record<string, unknown>, _ctx: DispatchContext): Promise<ToolResult> => ({
        success: true,
        data: { mergeSha: 'abc1234', strategy: 'squash' },
        // Simulate a result that already has SOME workflow-derived hint;
        // the boundary hint must be PREPENDED, not replace these.
        next_actions: [
          { verb: 'completed', reason: 'merge finished' },
        ],
      });
      const restore = stubCompositeHandler('exarchos_orchestrate', stub);

      // 0 → 12_500: well above 10s threshold.
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

        // Assert — envelope is successful, hint is FIRST in next_actions,
        // existing handler-supplied hint is preserved after.
        expect(result.success).toBe(true);
        const nextActions = (result as ToolResult & { next_actions?: readonly { verb: string; ttl_suggestion_ms?: number }[] }).next_actions;
        expect(nextActions).toBeDefined();
        expect(nextActions!.length).toBe(2);
        expect(nextActions![0].verb).toBe('retry_with_task');
        expect(nextActions![0].ttl_suggestion_ms).toBe(60_000);
        expect(nextActions![1].verb).toBe('completed');
        // _meta correlation block must still be attached by attachMeta.
        const meta = (result as ToolResult & { _meta?: Record<string, unknown> })._meta;
        expect(meta).toBeDefined();
        expect(typeof meta!.operationId).toBe('string');
      } finally {
        restore();
      }
    });
  });
});

// ─── Post-dispatch emission verifier ────────────────────────────────────────
//
// The verifier can only report on a dispatch it is REACHED by. A branch that
// returns before it — with a handler already run — is not a weaker check, it is
// no check at all for that branch, and nothing about the green suite would say
// so. These assertions are therefore structural: they read the shipped
// `dispatch()` source, classify every one of its return sites by what has
// happened to the handler at that point, and demand that the classes DECLARED
// applicable (`RETURN_CLASS_APPLICABILITY`, in the interceptor module) route
// through the verifier call.
//
// The applicability declaration is the load-bearing half. Without it the
// assertion has two failure modes and both look reasonable from the outside:
// assert over every return and it is permanently red on the refusal branches
// that never reach a handler; narrow it to whatever is green and it has quietly
// stopped covering anything.

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

/** Nested functions own their returns; only dispatch's own flow is in scope. */
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
 * Classify every return site in `dispatch()`.
 *
 * Anchors are resolved, never assumed: a missing one THROWS rather than
 * resolving to offset 0, because an anchor that silently reads as "position
 * zero" turns every comparison below into `x > 0` and the whole assertion into
 * a pass. Deleting the verifier call must make this red, not quiet.
 */
function classifyDispatchReturns(source: string): DispatchStructure {
  const sf = ts.createSourceFile(
    'dispatch.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
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

  // The async-local scope callback is dispatch()'s own continuation, not a
  // separate function: its returns ARE dispatch's returns. Every OTHER nested
  // function (`attachMeta`, the streamId IIFE, the telemetry wrappers) owns its
  // returns and must not be walked into.
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

  // The OUTER try/catch, a direct statement of the scope body. The inner try
  // blocks (workspace discovery, elicitation) are not it.
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

  // The handler region: the LAST direct statement of the try block that mentions
  // the raw handler binding. Everything after it has a completed handler behind
  // it. The `const coreHandler = …` declaration NAME is the binding site, not a
  // use — the region starts once the handler is actually reached for.
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
  // Walk out to the enclosing statement so a seeded bypass can be spliced in
  // ahead of the whole `await …;` line rather than inside its argument list.
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
      // `return runWithDispatchContext(ctx, async () => …)` is the scope ENTRY,
      // not a dispatch outcome — its value is whatever the scope returns, and
      // the scope's own returns are already classified below.
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
 * The return sites that bypass the verifier: applicable by the DECLARED policy,
 * yet positioned so control leaves dispatch() without reaching the call. Driven
 * off `RETURN_CLASS_APPLICABILITY` rather than a hard-wired class name, so the
 * declaration is what the assertion consults — flip an entry and the obligation
 * moves with it.
 */
function bypassingReturns(structure: DispatchStructure): readonly ClassifiedReturn[] {
  const applicable = new Set(applicableReturnClasses());
  return structure.returns.filter(
    (site) => applicable.has(site.cls) && site.start < structure.verifierCallEnd,
  );
}

describe('emission verifier — structural reachability', () => {
  const DISPATCH_SOURCE_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../src/dispatch/core/dispatch.ts',
  );

  it('EmissionVerifier_EveryHandlerCompletingBranch_ReachesIt', () => {
    const source = readFileSync(DISPATCH_SOURCE_PATH, 'utf-8');
    const structure = classifyDispatchReturns(source);

    // ── Denominators, so a broken walk cannot pass by finding nothing ──
    //
    // Every one of the three declared classes must be REPRESENTED in the live
    // function. A classifier that quietly stopped producing `handler-completing`
    // sites would report an empty bypass set and read exactly like a clean pass.
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

    // The pre-handler branches are the measured bypass set, and they are exempt
    // by DECLARATION — `handler-did-not-run`, recorded in the interceptor module
    // — not because the assertion was trimmed to fit them.
    expect(RETURN_CLASS_APPLICABILITY['pre-handler']).toEqual({
      applicable: false,
      reason: 'handler-did-not-run',
    });
    expect(RETURN_CLASS_APPLICABILITY['handler-threw']).toEqual({
      applicable: false,
      reason: 'handler-threw',
    });
    expect(RETURN_CLASS_APPLICABILITY['handler-completing']).toEqual({ applicable: true });

    // ── THE SUBJECT. Nothing applicable leaves dispatch() before the verifier ──
    const bypassing = bypassingReturns(structure);
    expect(
      bypassing.map((site) => `line ${site.line}: ${site.text}`),
      'A branch returns from dispatch() with a completed handler behind it without reaching ' +
        `\`${VERIFIER_CALLEE}\`. That branch is unverified: its action's unconditional emission ` +
        'contract is never read back. Either route it through the verifier, or declare its ' +
        'return class inapplicable in RETURN_CLASS_APPLICABILITY with a reason.',
    ).toEqual([]);
  });

  it('EmissionVerifier_SeededBypassingBranch_FailsTheAssertion', () => {
    const source = readFileSync(DISPATCH_SOURCE_PATH, 'utf-8');

    // A. The live tree is clean — otherwise B proves nothing about the seed.
    expect(bypassingReturns(classifyDispatchReturns(source))).toEqual([]);

    // B. Seed one bypassing branch: a return placed after the handler has run
    // but ahead of the verifier call. This is the exact shape of the regression
    // the assertion exists to catch — an early-out added to the post-handler
    // stretch of dispatch(), which reads as an ordinary guard clause.
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

    // And the seeded branch is a genuine ADDITION, not a reclassification of an
    // existing site: the clean tree has N handler-completing returns, the seeded
    // tree has N+1.
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

  it('EmissionVerifier_ConditionalOnlyAction_IsNotApplicableRatherThanOk', () => {
    // Out of subject is NOT a pass. An action whose every edge is conditional
    // has promised nothing unconditionally, so there is nothing to have kept —
    // reporting `ok` would be a green tick for a check that never ran, and `ok`
    // is what a caller reads as "the contract held".
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

    // A conditional edge cannot satisfy an unconditional one either: the
    // conditional event LANDED here and the unconditional one did not, and the
    // verdict is still a violation naming the unconditional edge.
    const mixed = verifyDeclaredEmissions({
      declared: [edge('workflow.started', 'always'), edge('workflow.compensation', 'conditional')],
      streamId: 'feat-x',
      landed: ['workflow.compensation'],
    });
    expect(mixed.status).toBe('violated');
    expect(mixed.missingEvents).toEqual(['workflow.started']);
    expect(mixed.required).toEqual(['workflow.started']);
  });

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
    // Full set, not the first miss — otherwise each repair uncovers the next and
    // the fault reads smaller every time anyone looks at it.
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

      // The finding has to outlive the run that noticed it.
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

  it('EmissionVerifier_UnreadableStore_IsIndeterminateAndNeverThrows', async () => {
    const failingStore = {
      query: vi.fn().mockRejectedValue(new Error('boom — synthetic store failure')),
      append: vi.fn(),
    } as unknown as EventStore;

    // An unread store is an unanswered question, not a clean bill and not a
    // benign exemption — and a verifier that threw would turn a working
    // dispatch into a failed one.
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

  it('EmissionVerifier_UnrecordableFinding_IsIndeterminateRatherThanSilentlyDropped', async () => {
    // The read succeeded and found a genuine miss; recording it did not. The
    // run holds no durable answer either way, so it reports one it does not
    // have rather than a verdict whose evidence was never written.
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
