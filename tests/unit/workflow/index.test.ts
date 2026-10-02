/**
 * Tests `createServer` and the other exports of `src/index.ts`.
 * The tests mock `contract/sdk/seam.ts`, not the SDK packages, because production reaches the SDK only through the seam.
 * The mock keeps the real seam constants, so a typo in a method name fails here.
 * The mock server has a `server` object, because `createMcpServer` sets `oninitialized` and calls `setNotificationHandler` on it.
 *
 * The composite handlers are mocked, so nothing appends an event.
 * The post-dispatch emission verifier still runs and expects `workflow.started` after `workflow.init`.
 * So the `EventStore` double returns that event for a query with an `operationId` and no `type`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  toolRegistrations,
  mockHandleWorkflow,
  mockHandleEvent,
  mockHandleOrchestrate,
  mockHandleView,
} = vi.hoisted(() => ({
  toolRegistrations: new Map<
    string,
    { description: string; schema: unknown; handler: (...args: unknown[]) => unknown }
  >(),
  mockHandleWorkflow: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' } }),
  mockHandleEvent: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleOrchestrate: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleView: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

vi.mock('../../../src/contract/sdk/seam.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/contract/sdk/seam.js')>();
  return {
    ...actual,
    createV2McpServer: vi.fn().mockImplementation(() => ({
      registerTool: vi.fn(
        (
          name: string,
          config: { description: string; inputSchema: unknown },
          handler: (...args: unknown[]) => unknown,
        ) => {
          toolRegistrations.set(name, {
            description: config.description,
            schema: config.inputSchema,
            handler,
          });
        },
      ),
      connect: vi.fn().mockResolvedValue(undefined),
      server: {
        oninitialized: undefined,
        getClientCapabilities: vi.fn().mockReturnValue({}),
        setNotificationHandler: vi.fn(),
      },
    })),
    createV2StdioServerTransport: vi.fn(),
    connectV2Server: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/workflow/composite.js', () => ({
  handleWorkflow: mockHandleWorkflow,
}));

vi.mock('../../../src/events/composite.js', () => ({
  handleEvent: mockHandleEvent,
}));

vi.mock('../../../src/verbs/composite.js', () => ({
  handleOrchestrate: mockHandleOrchestrate,
}));

vi.mock('../../../src/projections/views/composite.js', () => ({
  handleView: mockHandleView,
}));

vi.mock('../../../src/workflow/cleanup.js', () => ({
  configureCleanupSnapshotStore: vi.fn(),
}));

vi.mock('../../../src/events/store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue({ sequence: 1 }),
    query: vi.fn().mockImplementation(
      (_streamId: string, filters?: { type?: string; operationId?: string }) =>
        Promise.resolve(
          filters?.type === undefined && filters?.operationId !== undefined
            ? [{ type: 'workflow.started', operationId: filters.operationId, data: {} }]
            : [{ type: filters?.type, operationId: filters?.operationId, data: {} }],
        ),
    ),
  })),
}));

vi.mock('../../../src/projections/views/snapshot-store.js', () => ({
  SnapshotStore: vi.fn(),
}));

vi.mock('../../../src/projections/telemetry/middleware.js', () => ({
  withTelemetry: vi.fn((handler: unknown) => handler),
}));

import { createServer } from '../../../src/index.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';

describe('MCP Server Entry Point', () => {
  beforeEach(() => {
    toolRegistrations.clear();
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('should register only non-hidden composite tools', async () => {
      await createServer('/tmp/test-state-dir');

      const expectedTools = [
        'exarchos_workflow',
        'exarchos_event',
        'exarchos_orchestrate',
        'exarchos_view',
      ];

      expect(toolRegistrations.size).toBe(4);

      for (const toolName of expectedTools) {
        expect(toolRegistrations.has(toolName)).toBe(true);
      }

      expect(toolRegistrations.has('exarchos_sync')).toBe(false);
    });

    it('should register one tool per non-hidden registry entry', async () => {
      await createServer('/tmp/test-state-dir');

      for (const tool of TOOL_REGISTRY) {
        if (tool.hidden) {
          expect(toolRegistrations.has(tool.name)).toBe(false);
        } else {
          expect(toolRegistrations.has(tool.name)).toBe(true);
        }
      }
    });

    it('should register tools with non-empty descriptions', async () => {
      await createServer('/tmp/test-state-dir');
      for (const [, registration] of toolRegistrations) {
        expect(registration.description).toBeTruthy();
        expect(typeof registration.description).toBe('string');
        expect(registration.description.length).toBeGreaterThan(10);
      }
    });

    /**
     * Slim registration is the default. The description lists the action names and points to the `describe` action.
     * It does not inline signatures such as `init(...)`. `registry.test.ts` tests the full mode of `buildToolDescription`.
     */
    it('should enumerate action names and point to describe (slim registration, DR-6/INV-5a)', async () => {
      await createServer('/tmp/test-state-dir');

      const workflow = toolRegistrations.get('exarchos_workflow')!;
      expect(workflow.description).toContain('Actions:');
      expect(workflow.description).toContain('init');
      expect(workflow.description).toContain('get');
      expect(workflow.description).toContain('transition');
      expect(workflow.description).toContain('cancel');
      expect(workflow.description).toContain('describe');
      expect(workflow.description).not.toContain('init(');
    });

    it('should register tools with schemas containing action field', async () => {
      await createServer('/tmp/test-state-dir');
      for (const [, registration] of toolRegistrations) {
        expect(registration.schema).toBeDefined();
        const schema = registration.schema as { shape: Record<string, unknown> };
        expect(schema.shape).toHaveProperty('action');
      }
    });

    it('should include telemetry action in exarchos_view', async () => {
      await createServer('/tmp/test-state-dir');

      const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
      expect(viewTool).toBeDefined();

      const actionNames = viewTool!.actions.map((a) => a.name);
      expect(actionNames).toContain('telemetry');
    });

    it('should mention telemetry in exarchos_view description', async () => {
      await createServer('/tmp/test-state-dir');

      const viewReg = toolRegistrations.get('exarchos_view')!;
      expect(viewReg.description).toContain('telemetry');
    });
  });

  describe('composite handler routing', () => {
    it('should route exarchos_workflow to handleWorkflow', async () => {
      await createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow')!.handler({
        action: 'init', featureId: 'test-feat', workflowType: 'feature',
      });

      expect(mockHandleWorkflow).toHaveBeenCalledWith(
        { action: 'init', featureId: 'test-feat', workflowType: 'feature' },
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should route exarchos_event to handleEvent', async () => {
      await createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_event')!.handler({
        action: 'append', stream: 'my-stream', event: { type: 'test' },
      });

      expect(mockHandleEvent).toHaveBeenCalledWith(
        { action: 'append', stream: 'my-stream', event: { type: 'test' } },
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should route exarchos_orchestrate to handleOrchestrate', async () => {
      await createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_orchestrate')!.handler({
        action: 'task_claim', taskId: 'T1', agentId: 'agent-1', streamId: 'feat-1',
      });

      expect(mockHandleOrchestrate).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'task_claim', taskId: 'T1' }),
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should route exarchos_view to handleView', async () => {
      await createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_view')!.handler({
        action: 'pipeline',
      });

      expect(mockHandleView).toHaveBeenCalledWith(
        { action: 'pipeline' },
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should wrap results with toEnvelope/toMcpResult', async () => {
      await createServer('/tmp/test-state-dir');
      const result = await toolRegistrations.get('exarchos_workflow')!.handler({
        action: 'init', featureId: 'test-feat', workflowType: 'feature',
      });

      const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(typedResult.content).toHaveLength(1);
      expect(typedResult.content[0].type).toBe('text');
      expect(typedResult.isError).toBe(false);
      expect(JSON.parse(typedResult.content[0].text).success).toBe(true);
    });

    it('should set isError to true when handler returns success: false', async () => {
      mockHandleWorkflow.mockResolvedValueOnce({
        success: false,
        error: { code: 'STATE_ALREADY_EXISTS', message: 'Already exists' },
      });

      await createServer('/tmp/test-state-dir');
      const result = await toolRegistrations.get('exarchos_workflow')!.handler({
        action: 'init', featureId: 'dup', workflowType: 'feature',
      });

      const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(typedResult.isError).toBe(true);
      const parsed = JSON.parse(typedResult.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('STATE_ALREADY_EXISTS');
    });
  });

  describe('sync tools', () => {
    it('should not register exarchos_sync (hidden tool)', async () => {
      await createServer('/tmp/test-state-dir');
      expect(toolRegistrations.has('exarchos_sync')).toBe(false);
    });
  });

  describe('telemetry integration', () => {
    /** The telemetry wrap happens at dispatch, not at registration, so the test calls a handler. */
    it('should wrap handlers with withTelemetry when EXARCHOS_TELEMETRY is not false', async () => {
      const { withTelemetry } = await import('../../../src/projections/telemetry/middleware.js');
      const originalEnv = process.env.EXARCHOS_TELEMETRY;
      try {
        delete process.env.EXARCHOS_TELEMETRY;
        await createServer('/tmp/test-state-dir');
        await toolRegistrations.get('exarchos_workflow')!.handler({
          action: 'init', featureId: 'test-feat', workflowType: 'feature',
        });
        expect(withTelemetry).toHaveBeenCalled();
      } finally {
        if (originalEnv === undefined) { delete process.env.EXARCHOS_TELEMETRY; }
        else { process.env.EXARCHOS_TELEMETRY = originalEnv; }
      }
    });
  });

  describe('resolveStateDir', () => {
    it('should use WORKFLOW_STATE_DIR env var when set', async () => {
      const { resolveStateDir } = await import('../../../src/index.js');
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      try {
        process.env.WORKFLOW_STATE_DIR = '/custom/state/dir';
        const result = await resolveStateDir();
        expect(result).toBe('/custom/state/dir');
      } finally {
        if (originalEnv === undefined) { delete process.env.WORKFLOW_STATE_DIR; }
        else { process.env.WORKFLOW_STATE_DIR = originalEnv; }
      }
    });

    /** `resolveStateDir` returns a POSIX path. The expected path must also be POSIX, or the test fails on Windows. */
    it('should fallback to ~/.exarchos/state when no env vars are set', async () => {
      const { resolveStateDir } = await import('../../../src/index.js');
      const { homedir } = await import('node:os');
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      const originalPlugin = process.env.CLAUDE_PLUGIN_ROOT;
      const originalExPlugin = process.env.EXARCHOS_PLUGIN_ROOT;
      const originalXdg = process.env.XDG_STATE_HOME;
      try {
        delete process.env.WORKFLOW_STATE_DIR;
        delete process.env.CLAUDE_PLUGIN_ROOT;
        delete process.env.EXARCHOS_PLUGIN_ROOT;
        delete process.env.XDG_STATE_HOME;
        const result = await resolveStateDir();
        const { join } = await import('node:path');
        const { toPosix } = await import('../../../src/utils/paths.js');
        expect(result).toBe(toPosix(join(homedir(), '.exarchos', 'state')));
      } finally {
        if (originalEnv === undefined) { delete process.env.WORKFLOW_STATE_DIR; }
        else { process.env.WORKFLOW_STATE_DIR = originalEnv; }
        if (originalPlugin === undefined) { delete process.env.CLAUDE_PLUGIN_ROOT; }
        else { process.env.CLAUDE_PLUGIN_ROOT = originalPlugin; }
        if (originalExPlugin === undefined) { delete process.env.EXARCHOS_PLUGIN_ROOT; }
        else { process.env.EXARCHOS_PLUGIN_ROOT = originalExPlugin; }
        if (originalXdg === undefined) { delete process.env.XDG_STATE_HOME; }
        else { process.env.XDG_STATE_HOME = originalXdg; }
      }
    });
  });

  describe('exports', () => {
    it('should export SERVER_NAME', async () => {
      const { SERVER_NAME } = await import('../../../src/index.js');
      expect(SERVER_NAME).toBe('exarchos-mcp');
    });

    /** The test compares with `package.json`, not a literal. `tools/release/sync-versions.sh` keeps the two versions the same. */
    it('should export SERVER_VERSION matching package.json', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = fileURLToPath(new URL('.', import.meta.url));
      const pkg = JSON.parse(
        readFileSync(resolve(here, '../../../package.json'), 'utf-8'),
      );
      const { SERVER_VERSION } = await import('../../../src/index.js');
      expect(SERVER_VERSION).toBe(pkg.version);
    });
  });
});
