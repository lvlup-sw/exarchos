import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const toolRegistrations = new Map<
  string,
  { description: string; schema: unknown; handler: (...args: unknown[]) => unknown }
>();

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
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock stack tool handlers
vi.mock('../../stack/tools.js', () => ({
  handleStackStatus: vi.fn().mockResolvedValue({ success: true, data: [] }),
  handleStackPlace: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// Mock next-action handler (now in its own module)
vi.mock('../../workflow/next-action.js', () => ({
  handleNextAction: vi.fn().mockResolvedValue({ success: true, data: { action: 'DONE' } }),
}));

// Mock cancel handler (now in its own module)
vi.mock('../../workflow/cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// Mock query handlers (now in their own module)
vi.mock('../../workflow/query.js', () => ({
  handleSummary: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleReconcile: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleTransitions: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// Mock all tool handlers so we don't need real state files
vi.mock('../../workflow/tools.js', () => ({
  handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' } }),
  handleList: vi.fn().mockResolvedValue({ success: true, data: [] }),
  handleGet: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleSet: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleSummary: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleReconcile: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleNextAction: vi.fn().mockResolvedValue({ success: true, data: { action: 'DONE' } }),
  handleTransitions: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: {} }),
  handleCheckpoint: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// Import after mocks are set up
import { createServer } from '../../index.js';
import {
  handleInit,
  handleList,
  handleGet,
  handleSet,
  handleCheckpoint,
} from '../../workflow/tools.js';
import { handleNextAction } from '../../workflow/next-action.js';
import { handleCancel } from '../../workflow/cancel.js';
import { handleSummary, handleReconcile, handleTransitions } from '../../workflow/query.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MCP Server Entry Point', () => {
  beforeEach(() => {
    toolRegistrations.clear();
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('should register all 27 tools with correct names', () => {
      createServer('/tmp/test-state-dir');

      const expectedWorkflowTools = [
        'exarchos_workflow_init',
        'exarchos_workflow_list',
        'exarchos_workflow_get',
        'exarchos_workflow_set',
        'exarchos_workflow_summary',
        'exarchos_workflow_reconcile',
        'exarchos_workflow_next_action',
        'exarchos_workflow_transitions',
        'exarchos_workflow_cancel',
        'exarchos_workflow_checkpoint',
      ];

      expect(toolRegistrations.size).toBe(27);

      for (const toolName of expectedWorkflowTools) {
        expect(toolRegistrations.has(toolName)).toBe(true);
      }
    });

    it('should register tools with non-empty descriptions', () => {
      createServer('/tmp/test-state-dir');

      for (const [name, registration] of toolRegistrations) {
        expect(registration.description).toBeTruthy();
        expect(typeof registration.description).toBe('string');
        expect(registration.description.length).toBeGreaterThan(10);
      }
    });

    it('should register tools with schemas', () => {
      createServer('/tmp/test-state-dir');

      for (const [name, registration] of toolRegistrations) {
        expect(registration.schema).toBeDefined();
        expect(typeof registration.schema).toBe('object');
      }
    });
  });

  describe('tool handler routing', () => {
    it('should route exarchos_workflow_init to handleInit', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_init')!.handler;
      const result = await handler({ featureId: 'test-feat', workflowType: 'feature' });

      expect(handleInit).toHaveBeenCalledWith(
        { featureId: 'test-feat', workflowType: 'feature' },
        '/tmp/test-state-dir',
      );

      const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(typedResult.content).toHaveLength(1);
      expect(typedResult.content[0].type).toBe('text');
      expect(typedResult.isError).toBe(false);

      const parsed = JSON.parse(typedResult.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('should route exarchos_workflow_list to handleList', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_list')!.handler;
      await handler({});

      expect(handleList).toHaveBeenCalledWith({}, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_get to handleGet', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_get')!.handler;
      await handler({ featureId: 'my-feat', query: '.phase' });

      expect(handleGet).toHaveBeenCalledWith(
        { featureId: 'my-feat', query: '.phase' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_set to handleSet', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_set')!.handler;
      await handler({ featureId: 'my-feat', phase: 'plan' });

      expect(handleSet).toHaveBeenCalledWith(
        { featureId: 'my-feat', phase: 'plan' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_summary to handleSummary', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_summary')!.handler;
      await handler({ featureId: 'my-feat' });

      expect(handleSummary).toHaveBeenCalledWith(
        { featureId: 'my-feat' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_reconcile to handleReconcile', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_reconcile')!.handler;
      await handler({ featureId: 'my-feat' });

      expect(handleReconcile).toHaveBeenCalledWith(
        { featureId: 'my-feat' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_next_action to handleNextAction', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_next_action')!.handler;
      await handler({ featureId: 'my-feat' });

      expect(handleNextAction).toHaveBeenCalledWith(
        { featureId: 'my-feat' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_transitions to handleTransitions', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_transitions')!.handler;
      await handler({ workflowType: 'feature' });

      expect(handleTransitions).toHaveBeenCalledWith(
        { workflowType: 'feature' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_cancel to handleCancel', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_cancel')!.handler;
      await handler({ featureId: 'my-feat', reason: 'no longer needed' });

      expect(handleCancel).toHaveBeenCalledWith(
        { featureId: 'my-feat', reason: 'no longer needed' },
        '/tmp/test-state-dir',
      );
    });

    it('should route exarchos_workflow_checkpoint to handleCheckpoint', async () => {
      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_checkpoint')!.handler;
      await handler({ featureId: 'my-feat', summary: 'mid-delegation' });

      expect(handleCheckpoint).toHaveBeenCalledWith(
        { featureId: 'my-feat', summary: 'mid-delegation' },
        '/tmp/test-state-dir',
      );
    });

    it('should set isError to true when handler returns success: false', async () => {
      vi.mocked(handleInit).mockResolvedValueOnce({
        success: false,
        error: { code: 'STATE_ALREADY_EXISTS', message: 'Already exists' },
      });

      createServer('/tmp/test-state-dir');

      const handler = toolRegistrations.get('exarchos_workflow_init')!.handler;
      const result = await handler({ featureId: 'dup', workflowType: 'feature' });

      const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(typedResult.isError).toBe(true);

      const parsed = JSON.parse(typedResult.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('STATE_ALREADY_EXISTS');
    });
  });

  describe('stub tools', () => {
    it('should return NOT_IMPLEMENTED for stub tools', async () => {
      createServer('/tmp/test-state-dir');

      const stubTools = [
        'exarchos_sync_now',
      ];

      for (const toolName of stubTools) {
        const handler = toolRegistrations.get(toolName)!.handler;
        const result = await handler({});

        const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
        expect(typedResult.isError).toBe(true);

        const parsed = JSON.parse(typedResult.content[0].text);
        expect(parsed.success).toBe(false);
        expect(parsed.error.code).toBe('NOT_IMPLEMENTED');
        expect(parsed.error.message).toBe('Coming soon');
      }
    });

    it('should register implemented team and task tools', async () => {
      createServer('/tmp/test-state-dir');

      const implementedTools = [
        'exarchos_team_spawn',
        'exarchos_team_message',
        'exarchos_team_broadcast',
        'exarchos_team_shutdown',
        'exarchos_team_status',
        'exarchos_task_claim',
        'exarchos_task_complete',
        'exarchos_task_fail',
        'exarchos_stack_status',
        'exarchos_stack_place',
      ];

      for (const toolName of implementedTools) {
        expect(toolRegistrations.has(toolName)).toBe(true);
        const reg = toolRegistrations.get(toolName)!;
        expect(reg.handler).toBeDefined();
        expect(typeof reg.handler).toBe('function');
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
        if (originalEnv === undefined) {
          delete process.env.WORKFLOW_STATE_DIR;
        } else {
          process.env.WORKFLOW_STATE_DIR = originalEnv;
        }
      }
    });

    it('should fallback to cwd when git command fails', async () => {
      const originalEnv = process.env.WORKFLOW_STATE_DIR;

      // Mock child_process to throw an error (simulating non-git directory)
      vi.doMock('node:child_process', () => ({
        execSync: vi.fn(() => {
          throw new Error('fatal: not a git repository');
        }),
      }));

      try {
        delete process.env.WORKFLOW_STATE_DIR;

        // Re-import to get fresh module with mocked child_process
        vi.resetModules();

        // Re-mock the SDK modules that were cleared by resetModules
        vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
          McpServer: vi.fn().mockImplementation(() => ({
            tool: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
          })),
        }));
        vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
          StdioServerTransport: vi.fn(),
        }));
        vi.doMock('../../workflow/tools.js', () => ({
          handleInit: vi.fn(),
          handleList: vi.fn(),
          handleGet: vi.fn(),
          handleSet: vi.fn(),
          handleSummary: vi.fn(),
          handleReconcile: vi.fn(),
          handleNextAction: vi.fn(),
          handleTransitions: vi.fn(),
          handleCancel: vi.fn(),
          handleCheckpoint: vi.fn(),
        }));
        vi.doMock('../../workflow/next-action.js', () => ({
          handleNextAction: vi.fn(),
        }));
        vi.doMock('../../workflow/cancel.js', () => ({
          handleCancel: vi.fn(),
        }));
        vi.doMock('../../workflow/query.js', () => ({
          handleSummary: vi.fn(),
          handleReconcile: vi.fn(),
          handleTransitions: vi.fn(),
        }));
        vi.doMock('../../stack/tools.js', () => ({
          handleStackStatus: vi.fn(),
          handleStackPlace: vi.fn(),
        }));

        const { resolveStateDir } = await import('../../index.js');
        const result = await resolveStateDir();

        // Should fallback to cwd-based path
        expect(result).toMatch(/docs[/\\]workflow-state$/);
        expect(result).toBe(`${process.cwd()}/docs/workflow-state`);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.WORKFLOW_STATE_DIR;
        } else {
          process.env.WORKFLOW_STATE_DIR = originalEnv;
        }
        vi.doUnmock('node:child_process');
        vi.resetModules();
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
      expect(SERVER_VERSION).toBe('1.0.0');
    });
  });
});
