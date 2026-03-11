import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

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

// ─── Module Mocks ────────────────────────────────────────────────────────────

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        toolRegistrations.set(name, { description, schema, handler });
      },
    ),
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
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock composite handlers
vi.mock('../../workflow/composite.js', () => ({
  handleWorkflow: mockHandleWorkflow,
}));

vi.mock('../../event-store/composite.js', () => ({
  handleEvent: mockHandleEvent,
}));

vi.mock('../../orchestrate/composite.js', () => ({
  handleOrchestrate: mockHandleOrchestrate,
}));

vi.mock('../../views/composite.js', () => ({
  handleView: mockHandleView,
}));

// Mock EventStore configuration (workflow modules require explicit injection)
vi.mock('../../workflow/tools.js', () => ({
  configureWorkflowEventStore: vi.fn(),
}));

vi.mock('../../workflow/next-action.js', () => ({
  configureNextActionEventStore: vi.fn(),
}));

vi.mock('../../workflow/cancel.js', () => ({
  configureCancelEventStore: vi.fn(),
}));

vi.mock('../../workflow/cleanup.js', () => ({
  configureCleanupEventStore: vi.fn(),
  configureCleanupSnapshotStore: vi.fn(),
}));

vi.mock('../../workflow/query.js', () => ({
  configureQueryEventStore: vi.fn(),
}));

vi.mock('../../event-store/store.js', () => ({
  EventStore: vi.fn(),
}));

vi.mock('../../views/snapshot-store.js', () => ({
  SnapshotStore: vi.fn(),
}));

// Mock telemetry middleware (pass-through by default)
vi.mock('../../telemetry/middleware.js', () => ({
  withTelemetry: vi.fn((handler: unknown) => handler),
}));

// Import after mocks are set up
import { createServer } from '../../index.js';
import { TOOL_REGISTRY } from '../../registry.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MCP Server Entry Point', () => {
  beforeEach(() => {
    toolRegistrations.clear();
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('should register only non-hidden composite tools', () => {
      createServer('/tmp/test-state-dir');

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

      // Hidden tools should NOT be registered
      expect(toolRegistrations.has('exarchos_sync')).toBe(false);
    });

    it('should register one tool per non-hidden registry entry', () => {
      createServer('/tmp/test-state-dir');

      for (const tool of TOOL_REGISTRY) {
        if (tool.hidden) {
          expect(toolRegistrations.has(tool.name)).toBe(false);
        } else {
          expect(toolRegistrations.has(tool.name)).toBe(true);
        }
      }
    });

    it('should register tools with non-empty descriptions', () => {
      createServer('/tmp/test-state-dir');
      for (const [, registration] of toolRegistrations) {
        expect(registration.description).toBeTruthy();
        expect(typeof registration.description).toBe('string');
        expect(registration.description.length).toBeGreaterThan(10);
      }
    });

    it('should include action signatures in descriptions', () => {
      createServer('/tmp/test-state-dir');

      const workflow = toolRegistrations.get('exarchos_workflow')!;
      expect(workflow.description).toContain('Actions:');
      expect(workflow.description).toContain('init(');
      expect(workflow.description).toContain('get(');
      expect(workflow.description).toContain('set(');
      expect(workflow.description).toContain('cancel(');
    });

    it('should register tools with schemas containing action field', () => {
      createServer('/tmp/test-state-dir');
      for (const [, registration] of toolRegistrations) {
        expect(registration.schema).toBeDefined();
        // Schema is a strict ZodObject; check the shape for the action field
        const schema = registration.schema as { shape: Record<string, unknown> };
        expect(schema.shape).toHaveProperty('action');
      }
    });

    it('should include telemetry action in exarchos_view', () => {
      createServer('/tmp/test-state-dir');

      const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
      expect(viewTool).toBeDefined();

      const actionNames = viewTool!.actions.map((a) => a.name);
      expect(actionNames).toContain('telemetry');
    });

    it('should mention telemetry in exarchos_view description', () => {
      createServer('/tmp/test-state-dir');

      const viewReg = toolRegistrations.get('exarchos_view')!;
      expect(viewReg.description).toContain('telemetry');
    });
  });

  describe('composite handler routing', () => {
    it('should route exarchos_workflow to handleWorkflow', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow')!.handler({
        action: 'init', featureId: 'test-feat', workflowType: 'feature',
      });

      expect(mockHandleWorkflow).toHaveBeenCalledWith(
        { action: 'init', featureId: 'test-feat', workflowType: 'feature' },
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should route exarchos_event to handleEvent', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_event')!.handler({
        action: 'append', stream: 'my-stream', event: { type: 'test' },
      });

      expect(mockHandleEvent).toHaveBeenCalledWith(
        { action: 'append', stream: 'my-stream', event: { type: 'test' } },
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should route exarchos_orchestrate to handleOrchestrate', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_orchestrate')!.handler({
        action: 'task_claim', taskId: 'T1', agentId: 'agent-1', streamId: 'feat-1',
      });

      expect(mockHandleOrchestrate).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'task_claim', taskId: 'T1' }),
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should route exarchos_view to handleView', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_view')!.handler({
        action: 'pipeline',
      });

      expect(mockHandleView).toHaveBeenCalledWith(
        { action: 'pipeline' },
        expect.objectContaining({ stateDir: '/tmp/test-state-dir' }),
      );
    });

    it('should wrap results with formatResult', async () => {
      createServer('/tmp/test-state-dir');
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

      createServer('/tmp/test-state-dir');
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
    it('should not register exarchos_sync (hidden tool)', () => {
      createServer('/tmp/test-state-dir');
      expect(toolRegistrations.has('exarchos_sync')).toBe(false);
    });
  });

  describe('telemetry integration', () => {
    it('should wrap handlers with withTelemetry when EXARCHOS_TELEMETRY is not false', async () => {
      const { withTelemetry } = await import('../../telemetry/middleware.js');
      const originalEnv = process.env.EXARCHOS_TELEMETRY;
      try {
        delete process.env.EXARCHOS_TELEMETRY;
        createServer('/tmp/test-state-dir');
        // Telemetry wrapping now happens during dispatch (tool invocation),
        // not during registration. Invoke a handler to trigger withTelemetry.
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
      const { resolveStateDir } = await import('../../index.js');
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

    it('should fallback to ~/.claude/workflow-state when env var is not set', async () => {
      const { resolveStateDir } = await import('../../index.js');
      const { homedir } = await import('node:os');
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      try {
        delete process.env.WORKFLOW_STATE_DIR;
        const result = await resolveStateDir();
        const { join } = await import('node:path');
        expect(result).toBe(join(homedir(), '.claude', 'workflow-state'));
      } finally {
        if (originalEnv === undefined) { delete process.env.WORKFLOW_STATE_DIR; }
        else { process.env.WORKFLOW_STATE_DIR = originalEnv; }
      }
    });
  });

  describe('exports', () => {
    it('should export SERVER_NAME', async () => {
      const { SERVER_NAME } = await import('../../index.js');
      expect(SERVER_NAME).toBe('exarchos-mcp');
    });

    it('should export SERVER_VERSION', async () => {
      const { SERVER_VERSION } = await import('../../index.js');
      expect(SERVER_VERSION).toBe('2.4.0');
    });
  });
});
