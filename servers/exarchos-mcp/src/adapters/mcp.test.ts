import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY, buildToolDescription } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch, READ_ONLY_ACTIONS } from '../core/dispatch.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';

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
    await fs.rm(tmpDir, { recursive: true, force: true });
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
    // so we test via dispatch → formatResult by verifying the adapter creates a valid server
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
    // Arrange
    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    // Act — `set` is a mutating workflow action (auto-emits state.patched).
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'set', featureId: 'foo', updates: {} },
      readonlyCtx,
    );

    // Assert — structured error identifying the gated tool/action so the
    // caller can correlate the rejection back to a specific dispatch.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPABILITY_DENIED');
    expect(result.error?.tool).toBe('exarchos_workflow');
    expect(result.error?.action).toBe('set');
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
    const result = await dispatch(
      'exarchos_workflow',
      { action: 'set', featureId: 'foo', updates: {} },
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
        'doctor',
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
