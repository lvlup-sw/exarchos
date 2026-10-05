import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import { TOOL_REGISTRY, buildToolDescription } from '../../../../src/registry.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch, READ_ONLY_ACTIONS } from '../../../../src/dispatch/core/dispatch.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { toEnvelope } from '../../../../src/format.js';
import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import { none, type ActionContract } from '../../../../src/registry/action-contract.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const IDEMPOTENT_FIXTURE_CONTRACT: ActionContract = {
  requires: none('mcp fixture is a read-only probe'),
  ensures: none('mcp fixture has no durable postcondition'),
  needs: none('mcp fixture declares no capabilities'),
  touches: {
    frame: 'single-machine',
    resources: none('mcp fixture touches no durable resources'),
  },
  executionAuthority: { kind: 'local' },
  replay: { kind: 'safe-repeat' },
  emissions: none('mcp fixture emits no events'),
};

vi.mock('../../../../src/workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

describe('createMcpServer', () => {
  let tmpDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-adapter-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('CreateMcpServer_RegistersAllTools_FromRegistry', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');

    const server = createMcpServer(ctx);

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('CreateMcpServer_TrustedContext_ReplacesPreexistingCallerIdentity', async () => {
    const { createMcpDispatchContext } = await import('../../../../src/adapters/mcp/mcp.js');
    const trusted = createMcpDispatchContext(
      {
        ...ctx,
        callerIdentity: {
          subjectId: 'forged',
          kind: 'local-operator',
          role: 'operator',
        },
      },
      {
        sessionId: 'runtime-session',
        clientInfo: { name: 'test-client', version: '1.0' },
      },
    );

    expect(trusted.callerIdentity).toMatchObject({
      kind: 'mcp-session',
      role: 'agent',
    });
    expect(trusted.callerIdentity?.subjectId).toMatch(/^mcp:[0-9a-f]{32}$/);
    expect(trusted.callerIdentity?.subjectId).not.toBe('forged');
  });

  it('MCPHandler_ThreadsResolverAuthoritativeCallerSnapshot', async () => {
    const { V2_MCP_SERVER_CLASS: McpServer } = await import('../../../../src/contract/sdk/seam.js');
    const {
      clearCustomTools,
      registerCustomTool,
      setCustomToolActionHandler,
    } = await import('../../../../src/registry.js');
    const { getDispatchContext } = await import('../../../../src/dispatch/dispatch-context.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    let observed = getDispatchContext()?.authorization;

    try {
      registerCustomTool({
        name: 'custom_identity_probe',
        description: 'Test-only MCP caller context probe',
        actions: [{
          name: 'probe',
          description: 'Read the active dispatch context',
          schema: z.object({}).passthrough(),
          phases: new Set<string>(),
          roles: new Set<string>(['any']),
          outputSchema: EnvelopeSchema(z.unknown()),
          annotations: {
            safety: 'read-only',
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: false,
          },
          actionContract: IDEMPOTENT_FIXTURE_CONTRACT,
        }],
      });
      setCustomToolActionHandler('custom_identity_probe', 'probe', async () => {
        observed = getDispatchContext()?.authorization;
        return { captured: observed !== undefined };
      });

      const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
      createMcpServer({
        ...ctx,
        capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
      });
      const registration = spy.mock.calls.find(
        (call) => call[0] === 'custom_identity_probe',
      );
      expect(registration).toBeDefined();
      const handler = registration![2] as (
        args: Record<string, unknown>,
      ) => Promise<unknown>;

      await handler({
        action: 'probe',
        role: 'administrator',
        posture: 'shared-mutating',
        capabilities: ['fs:write'],
        resolvedAt: '1900-01-01T00:00:00.000Z',
      });

      expect(observed).toMatchObject({
        identity: { kind: 'mcp-session', role: 'agent' },
        posture: 'read-only',
        capabilities: ['mcp:exarchos:readonly'],
      });
      expect(JSON.stringify(observed)).not.toContain('administrator');
      expect(JSON.stringify(observed)).not.toContain('1900-01-01');
    } finally {
      clearCustomTools();
      spy.mockRestore();
    }
  });

  it('CreateMcpServer_HandlerReturns_McpToolResult', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');

    const server = createMcpServer(ctx);

    expect(server).toBeDefined();
    expect(TOOL_REGISTRY.length).toBe(5);
  });

  it('createMcpServer_declaresChannelCapability', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');

    const server = createMcpServer(ctx);
    const capabilities = server.server.getCapabilities();

    expect(capabilities.experimental).toBeDefined();
    expect(capabilities.experimental).toHaveProperty('claude/channel');
    expect(capabilities.experimental!['claude/channel']).toEqual({});
  });

  it('createMcpServer_exposesServerForNotifications', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');

    const server = createMcpServer(ctx);

    expect(server.server).toBeDefined();
    expect(typeof server.server.notification).toBe('function');
  });

  /**
   * The readonly gate. When the caller holds `mcp:exarchos:readonly` and not `mcp:exarchos`,
   * dispatch denies a mutating action with `CAPABILITY_DENIED`. A read action such as `get` can
   * fail for a different reason, for example missing state, but never with that code.
   */
  it('MCPDispatch_AllowsReadAction_UnderReadonly', async () => {
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'foo' },
      readonlyCtx,
    );

    expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  });

  /**
   * `transition` is a mutating workflow action that `READ_ONLY_ACTIONS` omits. The error names
   * the tool and the action, so the caller can match the rejection to one dispatch.
   */
  it('MCPDispatch_RejectsMutatingAction_UnderReadonly', async () => {
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId: 'foo', target: 'plan' },
      readonlyCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_workflow');
    expect(result.error?.action).toBe('transition');
  });

  it('MCPDispatch_RejectsAppend_UnderReadonly', async () => {
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: 'foo',
        event: { type: 'test.event', data: {} },
      },
      readonlyCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_event');
    expect(result.error?.action).toBe('append');
  });

  it('MCPDispatch_RejectsTaskComplete_UnderReadonly', async () => {
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    const result = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'task_complete',
        taskId: 't1',
        streamId: 'foo',
      },
      readonlyCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_orchestrate');
    expect(result.error?.action).toBe('task_complete');
  });

  /** `exarchos_view` has the `'*'` allowlist, so the readonly gate admits each view action. */
  it('MCPDispatch_AllowsView_UnderReadonly', async () => {
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    const result = await dispatch(
      'exarchos_view',
      { action: 'pipeline' },
      readonlyCtx,
    );

    expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  });

  /**
   * A caller with both `mcp:exarchos` and the readonly tier keeps full access.
   * The mutating `transition` can fail for a different reason, but never with `CAPABILITY_DENIED`.
   */
  it('MCPDispatch_BothCaps_KeepsFullAccess', async () => {
    const fullCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver([
        'mcp:exarchos',
        'mcp:exarchos:readonly',
      ]),
    };

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId: 'foo', target: 'plan' },
      fullCtx,
    );

    expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  });

  /**
   * `reconcile` and `rehydrate` write to the event or state store, so the workflow allowlist omits them.
   * `doctor` and `check_convergence` append an event on each call, so the orchestrate allowlist omits them.
   */
  it('READ_ONLY_ACTIONS_ExposesAllowlistShape', () => {
    expect(READ_ONLY_ACTIONS.exarchos_workflow).toEqual(
      expect.arrayContaining(['get', 'describe']),
    );
    expect(READ_ONLY_ACTIONS.exarchos_workflow).not.toEqual(
      expect.arrayContaining(['reconcile']),
    );
    expect(READ_ONLY_ACTIONS.exarchos_workflow).not.toEqual(
      expect.arrayContaining(['rehydrate']),
    );
    expect(READ_ONLY_ACTIONS.exarchos_event).toEqual(
      expect.arrayContaining(['query', 'describe']),
    );
    expect(READ_ONLY_ACTIONS.exarchos_view).toBe('*');
    const orch = READ_ONLY_ACTIONS.exarchos_orchestrate as readonly string[];
    expect(orch).toEqual(
      expect.arrayContaining([
        'describe',
        'runbook',
        'agent_spec',
        'list_prs',
        'get_pr_comments',
        'check_ci',
      ]),
    );
    expect(orch).not.toContain('task_complete');
    expect(orch).not.toContain('task_fail');
    expect(orch).not.toContain('add_pr_comment');
    expect(orch).not.toContain('merge_pr');
    expect(orch).not.toContain('create_pr');
    expect(orch).not.toContain('merge_orchestrate');
    expect(orch).not.toContain('doctor');
    expect(orch).not.toContain('check_convergence');
  });

  /**
   * `toMcpResult` only maps an envelope onto the MCP carrier. `content[0].text` holds the JSON text
   * of the envelope, for clients that read text. `structuredContent` holds the envelope itself, as
   * the same object reference with no clone.
   */
  it('toMcpResult_SuccessEnvelope_ReturnsTextAndStructuredContent', async () => {
    const { toMcpResult } = await import('../../../../src/adapters/mcp/mcp.js');
    const env = toEnvelope({
      success: true,
      data: { foo: 'bar' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    });

    const result = toMcpResult(env);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(JSON.stringify(env));
    expect(result.structuredContent).toBe(env);
    expect(result.isError).toBe(false);
  });

  it('toMcpResult_ErrorEnvelope_ReturnsTextAndStructuredContentWithIsErrorTrue', async () => {
    const { toMcpResult } = await import('../../../../src/adapters/mcp/mcp.js');
    const env = toEnvelope({
      success: false,
      error: { code: 'X', message: 'y' },
    });

    const result = toMcpResult(env);

    expect(result.content[0].text).toBe(JSON.stringify(env));
    expect(result.structuredContent).toBe(env);
    expect(result.isError).toBe(true);
  });

  it('toMcpResult_StructuredContentRoundTripsThroughEnvelopeSchema', async () => {
    const { toMcpResult } = await import('../../../../src/adapters/mcp/mcp.js');
    const env = toEnvelope({
      success: true,
      data: { foo: 'bar' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    });

    const result = toMcpResult(env);
    const parsed = EnvelopeSchema(z.unknown()).safeParse(result.structuredContent);

    expect(parsed.success).toBe(true);
  });

  /**
   * `toMcpResult` builds `content` through `renderContent`, the one place that renders the envelope.
   * The rendering is exactly one text block of `JSON.stringify(env)`, for a success envelope and
   * for an error envelope. The test pins those bytes, so a shorter rendering is a deliberate change.
   */
  it('toMcpResult_RenderContentSeam_BytesIdenticalToInline', async () => {
    const { toMcpResult } = await import('../../../../src/adapters/mcp/mcp.js');
    const successEnv = toEnvelope({
      success: true,
      data: { foo: 'bar', nested: { list: [1, 2, 3], flag: true } },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    });
    const errorEnv = toEnvelope({
      success: false,
      error: { code: 'X', message: 'y' },
    });

    for (const env of [successEnv, errorEnv]) {
      const result = toMcpResult(env);

      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(env) },
      ]);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(JSON.stringify(env));
      expect(result.structuredContent).toBe(env);
    }
  });

  /**
   * The MCP handler converts the dispatch result with `toEnvelope`, checks the envelope against the
   * `outputSchema` of the action, and maps it with `toMcpResult`. The test takes the handler from a
   * `registerTool` spy, so it needs no MCP transport. `pipeline` has a permissive output schema,
   * so each well-formed envelope passes. The `finally` block restores the spy even when an assertion throws.
   */
  it('MCPHandler_DispatchResultMatchesPerActionSchema_PassesThrough', async () => {
    const { V2_MCP_SERVER_CLASS: McpServer } = await import('../../../../src/contract/sdk/seam.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    try {
      const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
      createMcpServer(ctx);

      const viewCall = spy.mock.calls.find(c => c[0] === 'exarchos_view');
      expect(viewCall).toBeDefined();
      const handler = viewCall![2] as (args: Record<string, unknown>) => Promise<unknown>;

      const result = (await handler({ action: 'pipeline' })) as {
        content: { type: string; text: string }[];
        structuredContent: unknown;
        isError: boolean;
      };

      expect(result.structuredContent).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const action = TOOL_REGISTRY.find(t => t.name === 'exarchos_view')!.actions.find(
        a => a.name === 'pipeline',
      )!;
      const parsed = action.outputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * A custom tool declares a strict output schema, and its handler returns a success result whose
   * `data` has no `mustExist` field. The MCP handler must return an `INTERNAL_ERROR` envelope whose
   * `_meta.outputSchemaViolation` lists each issue with a path and a message.
   */
  it('MCPHandler_DispatchResultViolatesPerActionSchema_ReturnsInternalErrorEnvelopeWithIssuePath', async () => {
    const { registerCustomTool, setCustomToolActionHandler, clearCustomTools } =
      await import('../../../../src/registry.js');

    const strictDataSchema = z.object({ mustExist: z.string() });
    const strictAction = {
      name: 'probe',
      description: 'probe',
      schema: z.object({}) as z.ZodObject<z.ZodRawShape>,
      phases: new Set<string>(),
      roles: new Set<string>(),
      outputSchema: EnvelopeSchema(strictDataSchema),
      annotations: {
        safety: 'read-only' as const,
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      actionContract: IDEMPOTENT_FIXTURE_CONTRACT,
    };
    try {
      registerCustomTool({
        name: 'custom_probe_tool',
        description: 'test tool with strict per-action schema',
        actions: [strictAction],
      });
      setCustomToolActionHandler('custom_probe_tool', 'probe', async () => ({
        success: true,
        data: { wrongField: 'oops' },
      }));

      const { V2_MCP_SERVER_CLASS: McpServer } = await import('../../../../src/contract/sdk/seam.js');
      const spy = vi.spyOn(McpServer.prototype, 'registerTool');
      const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
      createMcpServer(ctx);

      const call = spy.mock.calls.find(c => c[0] === 'custom_probe_tool');
      expect(call).toBeDefined();
      const handler = call![2] as (args: Record<string, unknown>) => Promise<unknown>;

      const result = (await handler({ action: 'probe' })) as {
        structuredContent: {
          success: boolean;
          error?: { code: string; message: string };
          _meta: { outputSchemaViolation?: unknown };
        };
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.error?.code).toBe('INTERNAL_ERROR');
      expect(result.structuredContent._meta.outputSchemaViolation).toBeDefined();
      const violations = result.structuredContent._meta.outputSchemaViolation as Array<{
        path: string;
        message: string;
      }>;
      expect(Array.isArray(violations)).toBe(true);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toHaveProperty('path');
      expect(violations[0]).toHaveProperty('message');

      spy.mockRestore();
    } finally {
      clearCustomTools();
    }
  });

  /** A result with text content only drops the typed envelope, so `structuredContent` must be present. */
  it('MCPHandler_OutputShape_ContainsStructuredContent_NotTextOnly', async () => {
    const { V2_MCP_SERVER_CLASS: McpServer } = await import('../../../../src/contract/sdk/seam.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    createMcpServer(ctx);
    const call = spy.mock.calls.find(c => c[0] === 'exarchos_view');
    const handler = call![2] as (args: Record<string, unknown>) => Promise<unknown>;

    const result = (await handler({ action: 'pipeline' })) as {
      content?: unknown;
      structuredContent?: unknown;
    };

    expect(result.content).toBeDefined();
    expect(result.structuredContent).toBeDefined();

    spy.mockRestore();
  });

  /**
   * Each visible tool registers with one output schema, `EnvelopeSchema(z.unknown())`, which
   * `tools/list` advertises. The MCP handler does the strict check for each action.
   * The schema is a union with the discriminator `success`. In Zod v4 that is `_def.type === 'union'`.
   * A success envelope and an error envelope must both validate against it.
   * The spy records the options and does not replace the registration.
   */
  it('MCPServer_RegisterTool_PassesOutputSchemaPerTool', async () => {
    const { V2_MCP_SERVER_CLASS: McpServer } = await import('../../../../src/contract/sdk/seam.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');

    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    createMcpServer(ctx);

    const visibleNames = TOOL_REGISTRY.filter(t => !t.hidden).map(t => t.name);
    expect(spy.mock.calls.length).toBe(visibleNames.length);

    const successSample = toEnvelope({
      success: true,
      data: { foo: 'bar' },
      _meta: {},
      _perf: { ms: 1, bytes: 0, tokens: 0 },
    });
    const errorSample = toEnvelope({
      success: false,
      error: { code: 'X', message: 'y' },
    });

    for (const call of spy.mock.calls) {
      const [, options] = call;
      expect(options).toHaveProperty('outputSchema');
      const outputSchema = (options as { outputSchema?: z.ZodType }).outputSchema;
      expect(outputSchema).toBeDefined();
      const def = (outputSchema as { _def?: { type?: string; discriminator?: string } })._def;
      expect(def?.type).toBe('union');
      expect(def?.discriminator).toBe('success');
      expect(outputSchema!.safeParse(successSample).success).toBe(true);
      expect(outputSchema!.safeParse(errorSample).success).toBe(true);
    }

    spy.mockRestore();
  });

  /**
   * Each visible tool advertises annotations that aggregate the annotations of its actions.
   * `readOnlyHint` and `idempotentHint` are true only when every action has that flag.
   * `destructiveHint` and `openWorldHint` are true when one or more actions have that flag.
   * The loop skips a registered tool that `TOOL_REGISTRY` does not hold, such as a custom tool.
   */
  it('MCPServer_ToolsListAnnotations_AggregatesActionAnnotationsPerTool', async () => {
    const { V2_MCP_SERVER_CLASS: McpServer } = await import('../../../../src/contract/sdk/seam.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    createMcpServer(ctx);

    const viewCall = spy.mock.calls.find(c => c[0] === 'exarchos_view');
    expect(viewCall).toBeDefined();
    const viewOptions = viewCall![1] as {
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    };
    expect(viewOptions.annotations).toBeDefined();
    expect(typeof viewOptions.annotations!.readOnlyHint).toBe('boolean');
    expect(typeof viewOptions.annotations!.destructiveHint).toBe('boolean');
    expect(typeof viewOptions.annotations!.idempotentHint).toBe('boolean');
    expect(typeof viewOptions.annotations!.openWorldHint).toBe('boolean');

    for (const call of spy.mock.calls) {
      const [name, options] = call;
      const tool = TOOL_REGISTRY.find(t => t.name === name);
      if (tool === undefined) continue;
      const ann = (options as {
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
          openWorldHint?: boolean;
        };
      }).annotations;
      expect(ann).toBeDefined();
      expect(ann!.readOnlyHint).toBe(tool.actions.every(a => a.annotations.readOnly));
      expect(ann!.destructiveHint).toBe(tool.actions.some(a => a.annotations.destructive));
      expect(ann!.idempotentHint).toBe(tool.actions.every(a => a.annotations.idempotent));
      expect(ann!.openWorldHint).toBe(tool.actions.some(a => a.annotations.openWorld));
    }

    spy.mockRestore();
  });

  /**
   * The server sets `oninitialized` on the low-level server, and that callback calls
   * `capabilityResolver.snapshot()`. Without that call, `isRootsDeclared()` stays false and roots
   * discovery never runs. The test calls the callback directly, so it needs no transport.
   */
  it('CreateMcpServer_OninitializedFires_CallsCapabilityResolverSnapshot', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    const resolver = createInMemoryResolver(['mcp:exarchos:readonly']);
    const snapshotSpy = vi.spyOn(resolver, 'snapshot');
    const ctxWithResolver: DispatchContext = { ...ctx, capabilityResolver: resolver };

    const server = createMcpServer(ctxWithResolver);

    expect(typeof server.server.oninitialized).toBe('function');
    server.server.oninitialized?.();

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * When the context holds a capability resolver, `createMcpServer` must register a handler for the
   * `roots/list_changed` notification. Without it, the roots cache goes stale with no error. The SDK
   * takes the method as a plain string, so the test compares the first argument of each
   * `setNotificationHandler` call with that string.
   */
  it('CreateMcpServer_RootsListChangedNotificationHandler_IsRegistered', async () => {
    const { V2_SERVER_CLASS: Server, V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD } =
      await import('../../../../src/contract/sdk/seam.js');
    const setNotifSpy = vi.spyOn(Server.prototype, 'setNotificationHandler');
    try {
      const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
      const resolver = createInMemoryResolver(['mcp:exarchos:readonly']);
      createMcpServer({ ...ctx, capabilityResolver: resolver });
      const calledWithRootsListChanged = setNotifSpy.mock.calls.some(
        (call) => call[0] === V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD,
      );
      expect(
        calledWithRootsListChanged,
        'no setNotificationHandler call named ' +
          `"${V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD}" — the roots cache ` +
          'will go stale silently, which is the #1423 regression this pins. ' +
          `Calls seen: ${JSON.stringify(setNotifSpy.mock.calls.map((c) => c[0]))}`,
      ).toBe(true);
    } finally {
      setNotifSpy.mockRestore();
    }
  });

  /** `capabilityResolver` is optional. With no resolver, the server sets no `oninitialized` callback. */
  it('CreateMcpServer_NoCapabilityResolver_SkipsHandshakeWiring', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    const server = createMcpServer({ ...ctx, capabilityResolver: undefined });
    expect(server.server.oninitialized).toBeUndefined();
  });

  it('CreateMcpServer_SlimRegistration_UsesSlimDescriptions', async () => {
    const slimCtx: DispatchContext = { ...ctx, slimRegistration: true };
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');

    const visibleTools = TOOL_REGISTRY.filter(t => !t.hidden);
    for (const tool of visibleTools) {
      const slimDesc = buildToolDescription(tool, true);
      const fullDesc = buildToolDescription(tool, false);

      expect(slimDesc).toBe(tool.slimDescription);
      expect(slimDesc.length).toBeLessThan(fullDesc.length);
    }

    const server = createMcpServer(slimCtx);
    expect(server).toBeDefined();
  });
});
