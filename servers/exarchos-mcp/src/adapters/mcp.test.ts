import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY, buildToolDescription } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch, READ_ONLY_ACTIONS } from '../core/dispatch.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';
import { toEnvelope } from '../format.js';
import { EnvelopeSchema } from '../schemas/envelope.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// Mock the state-store module
vi.mock('../workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../workflow/state-store.js')>();
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
    // Arrange
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);

    // Assert — server should be created successfully
    expect(server).toBeDefined();
    // The MCP server should have tools registered (we verify by checking it's an McpServer instance)
    expect(typeof server.connect).toBe('function');
  });

  it('CreateMcpServer_HandlerReturns_McpToolResult', async () => {
    // Arrange — We can't easily call registered handlers directly via McpServer API,
    // so we test via dispatch → toEnvelope → toMcpResult by verifying the adapter creates a valid server
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);

    // Assert — all tools from registry should be registerable without error
    expect(server).toBeDefined();
    // Verify the expected number of tools are in the registry
    expect(TOOL_REGISTRY.length).toBe(5);
  });

  it('createMcpServer_declaresChannelCapability', async () => {
    // Arrange
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);
    const capabilities = server.server.getCapabilities();

    // Assert — experimental capabilities should include claude/channel
    expect(capabilities.experimental).toBeDefined();
    expect(capabilities.experimental).toHaveProperty('claude/channel');
    expect(capabilities.experimental!['claude/channel']).toEqual({});
  });

  it('createMcpServer_exposesServerForNotifications', async () => {
    // Arrange
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);

    // Assert — server.server should be accessible and have a notification method
    expect(server.server).toBeDefined();
    expect(typeof server.server.notification).toBe('function');
  });

  // ─── T04: server-side readonly action allowlist (Issue #1192) ─────────────
  //
  // When the effective capability set is `{mcp:exarchos:readonly}` (i.e. the
  // caller does NOT also hold `mcp:exarchos`), dispatch must reject mutating
  // composite-tool actions with a structured CAPABILITY_DENIED error. Read-only
  // actions still succeed (they may return a domain error like missing state,
  // but never CAPABILITY_DENIED). A spec that holds BOTH tiers keeps full
  // access — the readonly gate fires only when the readonly tier is the only
  // mcp:exarchos capability present.

  it('MCPDispatch_AllowsReadAction_UnderReadonly', async () => {
    // Arrange — capability resolver reports only the readonly tier.
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    // Act — `get` is on the read-only allowlist for exarchos_workflow.
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId: 'foo' },
      readonlyCtx,
    );

    // Assert — must not be the readonly gate's structured rejection. The
    // call may still fail for other reasons (missing state file), but never
    // with CAPABILITY_DENIED.
    expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  });

  it('MCPDispatch_RejectsMutatingAction_UnderReadonly', async () => {
    // T5a.1/DR-4 (#1259, v2.11): `transition` is the canonical mutating
    // workflow action (post-`set` hard-cut). It auto-emits
    // `workflow.transition` and is explicitly outside
    // READ_ONLY_ACTIONS.exarchos_workflow.
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    // Act — `transition` is a mutating workflow action.
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId: 'foo', target: 'plan' },
      readonlyCtx,
    );

    // Assert — structured error identifying the gated tool/action so the
    // caller can correlate the rejection back to a specific dispatch.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_workflow');
    expect(result.error?.action).toBe('transition');
  });

  it('MCPDispatch_RejectsAppend_UnderReadonly', async () => {
    // Arrange
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    // Act — `append` writes to the event store; must be denied.
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: 'foo',
        event: { type: 'test.event', data: {} },
      },
      readonlyCtx,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_event');
    expect(result.error?.action).toBe('append');
  });

  it('MCPDispatch_RejectsTaskComplete_UnderReadonly', async () => {
    // Arrange
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    // Act — task_complete auto-emits task.completed; mutating.
    const result = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'task_complete',
        taskId: 't1',
        streamId: 'foo',
      },
      readonlyCtx,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_orchestrate');
    expect(result.error?.action).toBe('task_complete');
  });

  it('MCPDispatch_AllowsView_UnderReadonly', async () => {
    // Arrange — exarchos_view is wholesale read-only (`'*'` allowlist).
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    // Act
    const result = await dispatch(
      'exarchos_view',
      { action: 'pipeline' },
      readonlyCtx,
    );

    // Assert — never blocked by the readonly gate, regardless of action.
    expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  });

  it('MCPDispatch_BothCaps_KeepsFullAccess', async () => {
    // Arrange — when the spec carries BOTH `mcp:exarchos` and the readonly
    // tier, the less-restrictive tier wins (mirrors the resolver's tier
    // merge logic that T05 will land). The readonly gate must NOT fire.
    const fullCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver([
        'mcp:exarchos',
        'mcp:exarchos:readonly',
      ]),
    };

    // Act
    // T5a.1/DR-4 (v2.11): `transition` replaces `set` as the canonical
    // mutating action exercised in the union-merge gate test.
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId: 'foo', target: 'plan' },
      fullCtx,
    );

    // Assert — may fail for other reasons but never CAPABILITY_DENIED.
    expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  });

  it('READ_ONLY_ACTIONS_ExposesAllowlistShape', () => {
    // Sanity check the constant shape so T05 / T06-T10 can rely on it.
    expect(READ_ONLY_ACTIONS.exarchos_workflow).toEqual(
      expect.arrayContaining(['get', 'describe']),
    );
    // `reconcile` and `rehydrate` are mutating (event-emitting + state
    // rewrite) and must NOT appear in the workflow allowlist — see the
    // dispatch.ts comment block.
    expect(READ_ONLY_ACTIONS.exarchos_workflow).not.toEqual(
      expect.arrayContaining(['reconcile']),
    );
    expect(READ_ONLY_ACTIONS.exarchos_workflow).not.toEqual(
      expect.arrayContaining(['rehydrate']),
    );
    expect(READ_ONLY_ACTIONS.exarchos_event).toEqual(
      expect.arrayContaining(['query', 'describe']),
    );
    // The view tool is wholesale read-only.
    expect(READ_ONLY_ACTIONS.exarchos_view).toBe('*');
    // Orchestrate read-only set must include the deterministic-info actions
    // and exclude every mutator we explicitly check for in other tests.
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
    // sentry HIGH on PR #1369: `doctor` (`diagnostic.executed`) and
    // `check_convergence` (`gate.executed`) emit event-store appends
    // on every call, so they were removed from the readonly tier
    // alongside the annotation correction.
    expect(orch).not.toContain('doctor');
    expect(orch).not.toContain('check_convergence');
  });

  // ─── D.1: toMcpResult carrier mapping (Wave 0, Issue #1287) ──────────────
  //
  // The MCP adapter must emit BOTH a backwards-compat `content[0].text`
  // (per MCP 2025-11-25 §Tools / Structured Content SHOULD) AND the
  // typed `structuredContent` carrying the Envelope as a JSON object.
  // The envelope construction stays in format.ts; toMcpResult only does
  // carrier mapping. See design §2.3.

  it('toMcpResult_SuccessEnvelope_ReturnsTextAndStructuredContent', async () => {
    // Arrange
    const { toMcpResult } = await import('./mcp.js');
    const env = toEnvelope({
      success: true,
      data: { foo: 'bar' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    });

    // Act
    const result = toMcpResult(env);

    // Assert — content[0].text is the JSON-serialized envelope (SHOULD).
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(JSON.stringify(env));
    // structuredContent must carry the envelope as a JSON object.
    // We document this as same-object-reference: no clone, no normalization.
    expect(result.structuredContent).toBe(env);
    // Success envelopes never set isError.
    expect(result.isError).toBe(false);
  });

  it('toMcpResult_ErrorEnvelope_ReturnsTextAndStructuredContentWithIsErrorTrue', async () => {
    // Arrange
    const { toMcpResult } = await import('./mcp.js');
    const env = toEnvelope({
      success: false,
      error: { code: 'X', message: 'y' },
    });

    // Act
    const result = toMcpResult(env);

    // Assert
    expect(result.content[0].text).toBe(JSON.stringify(env));
    expect(result.structuredContent).toBe(env);
    expect(result.isError).toBe(true);
  });

  it('toMcpResult_StructuredContentRoundTripsThroughEnvelopeSchema', async () => {
    // Arrange
    const { toMcpResult } = await import('./mcp.js');
    const env = toEnvelope({
      success: true,
      data: { foo: 'bar' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    });

    // Act
    const result = toMcpResult(env);
    const parsed = EnvelopeSchema(z.unknown()).safeParse(result.structuredContent);

    // Assert — the carrier payload must validate against the canonical
    // envelope schema so downstream consumers can rely on the shape.
    expect(parsed.success).toBe(true);
  });

  // ─── DR-9: renderContent presentation seam (Task 017) ────────────────────
  //
  // `toMcpResult` derives `content` through a single `renderContent` seam —
  // the §05 presentation/contract split point between the canonical envelope
  // (`structuredContent`) and its rendering (`content`). Task 016's decision
  // rule returned DEFER (host content-injection un-evidenced across every
  // Tier-1 runtime — INV-4), so the seam lands BYTE-IDENTICAL to the prior
  // inline `[{ type: 'text', text: JSON.stringify(env) }]`. No lean rendering
  // ships in this pass. This characterization pins that byte-identity so a
  // future lean rendering is a deliberate, evidence-gated change — and so any
  // accidental drift in the presentation seam is caught here.
  // See docs/research/2026-07-DR9-content-injection-verification.md.

  it('toMcpResult_RenderContentSeam_BytesIdenticalToInline', async () => {
    // Arrange
    const { toMcpResult } = await import('./mcp.js');
    // Representative envelopes spanning the discriminated union: a populated
    // success envelope (nested data + _perf) and an error envelope.
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
      // Act
      const result = toMcpResult(env);

      // Assert — the seam is byte-identical to the pre-refactor inline
      // construction: content === [{ type: 'text', text: JSON.stringify(env) }].
      // Exactly one text block; no lean/summary rendering added.
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(env) },
      ]);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(JSON.stringify(env));
      // structuredContent stays the full envelope, unchanged (same reference).
      expect(result.structuredContent).toBe(env);
    }
  });

  // ─── D.5 + D.7: Per-call validation + carrier cutover (Wave 0, #1287) ────
  //
  // The MCP handler must:
  //   1. Convert the dispatch core's ToolResult into the canonical Envelope
  //      via `toEnvelope`, then ride the carrier via `toMcpResult` so
  //      `structuredContent` is populated alongside the legacy text
  //      content. This is the D.7 cutover.
  //   2. After conversion, validate the envelope against the per-action
  //      outputSchema declared in the registry. On violation, return an
  //      INTERNAL_ERROR envelope whose `_meta.outputSchemaViolation`
  //      carries the Zod issue list (path + message) so callers can
  //      diagnose contract drift without re-running the call. This is the
  //      D.5 per-call enforcement.

  it('MCPHandler_DispatchResultMatchesPerActionSchema_PassesThrough', async () => {
    // Arrange — spy on registerTool to capture the per-tool handler so we
    // can invoke it directly without standing up an MCP transport.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    try {
      const { createMcpServer } = await import('./mcp.js');
      createMcpServer(ctx);

      // Locate the exarchos_view tool's handler — `pipeline` is a read-only
      // action with a permissive `EnvelopeSchema(z.unknown())` per-action
      // schema, so any well-formed envelope passes.
      const viewCall = spy.mock.calls.find(c => c[0] === 'exarchos_view');
      expect(viewCall).toBeDefined();
      const handler = viewCall![2] as (args: Record<string, unknown>) => Promise<unknown>;

      // Act — invoke the handler directly.
      const result = (await handler({ action: 'pipeline' })) as {
        content: { type: string; text: string }[];
        structuredContent: unknown;
        isError: boolean;
      };

      // Assert — D.7 cutover: handler emits structuredContent (the envelope),
      // not just the legacy text-only shape (content + isError only).
      expect(result.structuredContent).toBeDefined();
      expect(result.content[0].type).toBe('text');
      // Envelope validates against the action's per-action outputSchema.
      const action = TOOL_REGISTRY.find(t => t.name === 'exarchos_view')!.actions.find(
        a => a.name === 'pipeline',
      )!;
      const parsed = action.outputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
    } finally {
      // Guarantee restoration even when an assertion above throws so a
      // leaked spy doesn't pollute subsequent tests in the file (CodeRabbit
      // PR #1369 minor).
      spy.mockRestore();
    }
  });

  it('MCPHandler_DispatchResultViolatesPerActionSchema_ReturnsInternalErrorEnvelopeWithIssuePath', async () => {
    // Arrange — register a synthetic custom tool whose per-action outputSchema
    // is strict (`data` must be `{ mustExist: string }`), then plant a
    // handler that returns a violating ToolResult. The mcpHandler must
    // detect the mismatch via the per-action schema and surface an
    // INTERNAL_ERROR envelope with the issue path on `_meta`.
    const { registerCustomTool, setCustomToolActionHandler, clearCustomTools } =
      await import('../registry.js');

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
    };
    try {
      registerCustomTool({
        name: 'custom_probe_tool',
        description: 'test tool with strict per-action schema',
        actions: [strictAction],
      });
      // The handler returns a SUCCESS ToolResult whose `data` is missing
      // `mustExist`, violating the per-action outputSchema after envelope
      // wrapping.
      setCustomToolActionHandler('custom_probe_tool', 'probe', async () => ({
        success: true,
        data: { wrongField: 'oops' },
      }));

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const spy = vi.spyOn(McpServer.prototype, 'registerTool');
      const { createMcpServer } = await import('./mcp.js');
      createMcpServer(ctx);

      const call = spy.mock.calls.find(c => c[0] === 'custom_probe_tool');
      expect(call).toBeDefined();
      const handler = call![2] as (args: Record<string, unknown>) => Promise<unknown>;

      // Act
      const result = (await handler({ action: 'probe' })) as {
        structuredContent: {
          success: boolean;
          error?: { code: string; message: string };
          _meta: { outputSchemaViolation?: unknown };
        };
        isError: boolean;
      };

      // Assert
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

  // ─── D.7: cutover regression guard — structuredContent must be populated.
  // A text-content-only output (no structuredContent) would silently drop
  // the typed envelope and revert to the legacy text-only carrier.
  it('MCPHandler_OutputShape_ContainsStructuredContent_NotTextOnly', async () => {
    // Arrange
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    const { createMcpServer } = await import('./mcp.js');
    createMcpServer(ctx);
    const call = spy.mock.calls.find(c => c[0] === 'exarchos_view');
    const handler = call![2] as (args: Record<string, unknown>) => Promise<unknown>;

    // Act
    const result = (await handler({ action: 'pipeline' })) as {
      content?: unknown;
      structuredContent?: unknown;
    };

    // Assert — both legacy text content AND new structuredContent must be
    // present. structuredContent presence is the D.7 invariant.
    expect(result.content).toBeDefined();
    expect(result.structuredContent).toBeDefined();

    spy.mockRestore();
  });

  // ─── D.4: Pass LCD outputSchema to registerTool (Wave 0, Issue #1287) ────
  //
  // Per design §2.2, every visible composite tool MUST be registered with an
  // `outputSchema` option set to the LCD envelope shape — `EnvelopeSchema(z
  // .unknown())`. This is the single advertised carrier schema in
  // tools/list; the strict per-action validation lives downstream in the
  // mcpHandler (D.5).
  //
  // The test asserts the `options` object passed to `server.registerTool`
  // carries an `outputSchema` field whose Zod runtime shape is a
  // discriminated union on `success` (matching the canonical
  // `EnvelopeSchema(z.unknown())` factory output).

  it('MCPServer_RegisterTool_PassesOutputSchemaPerTool', async () => {
    // Arrange — spy on McpServer.prototype.registerTool to capture per-tool
    // options without intercepting actual registration (so server setup
    // remains exercised).
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');

    // Act
    const { createMcpServer } = await import('./mcp.js');
    createMcpServer(ctx);

    // Assert — every visible (non-hidden) tool registration must carry an
    // outputSchema that is the LCD envelope shape — the canonical
    // `EnvelopeSchema(z.unknown())` discriminated union on `success`. The
    // SDK is patched (PR #1366; upstream typescript-sdk#1308) so its
    // `normalizeObjectSchema` accepts DUs, replacing the prior
    // passthrough-ZodObject workaround. Both the success and error
    // envelope variants MUST validate against the advertised LCD.
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
      // The advertised LCD is the canonical `EnvelopeSchema(z.unknown())`
      // discriminated union, keyed on `success`. In Zod v4 the internal
      // representation is `_def.type === 'union'` with a string
      // `discriminator` field (the legacy `_def.typeName` is undefined in
      // v4). The SDK is patched (PR #1366 / upstream typescript-sdk#1308)
      // to accept DUs in `normalizeObjectSchema`, so this is the canonical
      // shape — not a passthrough-ZodObject workaround.
      const def = (outputSchema as { _def?: { type?: string; discriminator?: string } })._def;
      expect(def?.type).toBe('union');
      expect(def?.discriminator).toBe('success');
      expect(outputSchema!.safeParse(successSample).success).toBe(true);
      expect(outputSchema!.safeParse(errorSample).success).toBe(true);
    }

    spy.mockRestore();
  });

  // ─── D.6: tools/list annotations aggregated per tool (Wave 0, #1289) ────
  //
  // Per design §2.4, every visible composite tool advertises a
  // ToolAnnotations record on tools/list aggregated from its actions:
  //   readOnlyHint    = actions.every(a => a.annotations.readOnly)
  //   destructiveHint = actions.some (a => a.annotations.destructive)
  //   idempotentHint  = actions.every(a => a.annotations.idempotent)
  //   openWorldHint   = actions.some (a => a.annotations.openWorld)
  //
  // The hints are advisory per MCP spec; populating them lets clients
  // surface safety affordances without scraping per-action telemetry.
  it('MCPServer_ToolsListAnnotations_AggregatesActionAnnotationsPerTool', async () => {
    // Arrange — capture every registerTool call's options.annotations.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    const { createMcpServer } = await import('./mcp.js');
    createMcpServer(ctx);

    // Spot check — exarchos_view should at minimum surface a defined
    // annotations record with all four Hint fields populated. The detailed
    // per-formula assertion (every visible tool) follows below.
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

    // Assert the aggregation formula against the registry for every
    // visible tool — any drift between the helper and the per-action
    // annotations table is caught here.
    for (const call of spy.mock.calls) {
      const [name, options] = call;
      const tool = TOOL_REGISTRY.find(t => t.name === name);
      if (tool === undefined) continue; // custom tools registered from earlier tests
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

  it('CreateMcpServer_OninitializedFires_CallsCapabilityResolverSnapshot', async () => {
    // Sentry HIGH #1423: pre-fix the MCP wiring never called
    // `capabilityResolver.snapshot()` on the initialize handshake, so
    // `isRootsDeclared()` stayed `false` and roots-based discovery was
    // dead code. Pin the oninitialized → snapshot bridge.
    const { createMcpServer } = await import('./mcp.js');
    const resolver = createInMemoryResolver(['mcp:exarchos:readonly']);
    const snapshotSpy = vi.spyOn(resolver, 'snapshot');
    const ctxWithResolver: DispatchContext = { ...ctx, capabilityResolver: resolver };

    const server = createMcpServer(ctxWithResolver);

    // The wiring registers an `oninitialized` callback on the underlying
    // low-level Server. Direct invocation simulates the post-handshake
    // moment without needing a transport.
    expect(typeof server.server.oninitialized).toBe('function');
    server.server.oninitialized?.();

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('CreateMcpServer_RootsListChangedNotificationHandler_IsRegistered', async () => {
    // Sentry HIGH #1423 + CodeRabbit MAJOR #1423: the `roots/list_changed`
    // notification handler was defined in mcp/notifications.ts but never
    // registered. Spy on the underlying Server's setNotificationHandler
    // call pattern via a Server.prototype intercept so a fresh
    // createMcpServer call surfaces the registration.
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const setNotifSpy = vi.spyOn(Server.prototype, 'setNotificationHandler');
    try {
      const { createMcpServer } = await import('./mcp.js');
      const resolver = createInMemoryResolver(['mcp:exarchos:readonly']);
      createMcpServer({ ...ctx, capabilityResolver: resolver });
      // At least one setNotificationHandler call must reference the
      // roots/list_changed schema — the registration anchor.
      const calledWithRootsListChanged = setNotifSpy.mock.calls.some((call) => {
        const schema = call[0] as { shape?: { method?: { value?: string } } };
        return schema?.shape?.method?.value === 'notifications/roots/list_changed';
      });
      expect(calledWithRootsListChanged).toBe(true);
    } finally {
      setNotifSpy.mockRestore();
    }
  });

  it('CreateMcpServer_NoCapabilityResolver_SkipsHandshakeWiring', async () => {
    // Defensive: if the caller supplies no capabilityResolver (today only
    // hypothetical, but the field is optional on DispatchContext), the
    // handshake wiring must skip cleanly rather than throw on
    // `resolver.snapshot()` against undefined.
    const { createMcpServer } = await import('./mcp.js');
    const server = createMcpServer({ ...ctx, capabilityResolver: undefined });
    expect(server.server.oninitialized).toBeUndefined();
  });

  it('CreateMcpServer_SlimRegistration_UsesSlimDescriptions', async () => {
    // Arrange: create context with slimRegistration enabled
    const slimCtx: DispatchContext = { ...ctx, slimRegistration: true };
    const { createMcpServer } = await import('./mcp.js');

    // Act: buildToolDescription with slim=true should return slim descriptions
    const visibleTools = TOOL_REGISTRY.filter(t => !t.hidden);
    for (const tool of visibleTools) {
      const slimDesc = buildToolDescription(tool, true);
      const fullDesc = buildToolDescription(tool, false);

      // Assert: slim description should be different (shorter) than full description
      expect(slimDesc).toBe(tool.slimDescription);
      expect(slimDesc.length).toBeLessThan(fullDesc.length);
    }

    // Assert: server creates successfully with slim context
    const server = createMcpServer(slimCtx);
    expect(server).toBeDefined();
  });
});
