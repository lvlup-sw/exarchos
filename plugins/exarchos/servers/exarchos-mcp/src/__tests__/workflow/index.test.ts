import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const {
  toolRegistrations,
  mockHandleInit, mockHandleList, mockHandleGet, mockHandleSet, mockHandleCheckpoint,
  mockHandleNextAction, mockHandleCancel,
  mockHandleSummary, mockHandleReconcile, mockHandleTransitions,
} = vi.hoisted(() => ({
  toolRegistrations: new Map<
    string,
    { description: string; schema: unknown; handler: (...args: unknown[]) => unknown }
  >(),
  mockHandleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' } }),
  mockHandleList: vi.fn().mockResolvedValue({ success: true, data: [] }),
  mockHandleGet: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleSet: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleCheckpoint: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleNextAction: vi.fn().mockResolvedValue({ success: true, data: { action: 'DONE' } }),
  mockHandleCancel: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleSummary: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleReconcile: vi.fn().mockResolvedValue({ success: true, data: {} }),
  mockHandleTransitions: vi.fn().mockResolvedValue({ success: true, data: {} }),
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
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock workflow/tools.js - provide both handlers and registration function
vi.mock('../../workflow/tools.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const featureIdParam = z.string().min(1).regex(/^[a-z0-9-]+$/);
  const workflowTypeParam = z.enum(['feature', 'debug', 'refactor']);
  return {
    handleInit: mockHandleInit,
    handleList: mockHandleList,
    handleGet: mockHandleGet,
    handleSet: mockHandleSet,
    handleCheckpoint: mockHandleCheckpoint,
    handleNextAction: mockHandleNextAction,
    handleCancel: mockHandleCancel,
    handleSummary: mockHandleSummary,
    handleReconcile: mockHandleReconcile,
    handleTransitions: mockHandleTransitions,
    configureWorkflowEventStore: vi.fn(),
    registerWorkflowTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_workflow_init', 'Initialize a new workflow state file for a feature/debug/refactor workflow',
        { featureId: featureIdParam, workflowType: workflowTypeParam },
        async (args: unknown) => formatResult(await mockHandleInit(args, stateDir)));
      s.tool('exarchos_workflow_list', 'List all active workflow state files with staleness information',
        {},
        async (args: unknown) => formatResult(await mockHandleList(args, stateDir)));
      s.tool('exarchos_workflow_get', 'Query a field via dot-path (e.g. query:"phase") or get full state if no query',
        { featureId: featureIdParam, query: z.string().optional() },
        async (args: unknown) => formatResult(await mockHandleGet(args, stateDir)));
      s.tool('exarchos_workflow_set', 'Update fields and/or transition phase. Returns {phase, updatedAt}',
        { featureId: featureIdParam, updates: z.record(z.string(), z.unknown()).optional(), phase: z.string().optional() },
        async (args: unknown) => formatResult(await mockHandleSet(args, stateDir)));
      s.tool('exarchos_workflow_checkpoint', 'Create an explicit checkpoint, resetting the operation counter',
        { featureId: featureIdParam, summary: z.string().optional() },
        async (args: unknown) => formatResult(await mockHandleCheckpoint(args, stateDir)));
    },
  };
});

vi.mock('../../workflow/next-action.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  return {
    handleNextAction: mockHandleNextAction,
    configureNextActionEventStore: vi.fn(),
    registerNextActionTool: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_workflow_next_action', 'Determine the next auto-continue action based on current phase and guards',
        { featureId: z.string().min(1).regex(/^[a-z0-9-]+$/) },
        async (args: unknown) => formatResult(await mockHandleNextAction(args, stateDir)));
    },
  };
});

vi.mock('../../workflow/cancel.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  return {
    handleCancel: mockHandleCancel,
    configureCancelEventStore: vi.fn(),
    registerCancelTool: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_workflow_cancel', 'Cancel a workflow with saga compensation and cleanup',
        { featureId: z.string().min(1).regex(/^[a-z0-9-]+$/), reason: z.string().optional(), dryRun: z.boolean().optional() },
        async (args: unknown) => formatResult(await mockHandleCancel(args, stateDir)));
    },
  };
});

vi.mock('../../workflow/query.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const featureIdParam = z.string().min(1).regex(/^[a-z0-9-]+$/);
  return {
    handleSummary: mockHandleSummary,
    handleReconcile: mockHandleReconcile,
    handleTransitions: mockHandleTransitions,
    configureQueryEventStore: vi.fn(),
    registerQueryTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_workflow_summary', 'Get structured summary of workflow progress, events, and circuit breaker status',
        { featureId: featureIdParam },
        async (args: unknown) => formatResult(await mockHandleSummary(args, stateDir)));
      s.tool('exarchos_workflow_reconcile', 'Verify worktree paths and branches match state file',
        { featureId: featureIdParam },
        async (args: unknown) => formatResult(await mockHandleReconcile(args, stateDir)));
      s.tool('exarchos_workflow_transitions', 'Get available state machine transitions for a workflow type',
        { workflowType: z.enum(['feature', 'debug', 'refactor']), fromPhase: z.string().optional() },
        async (args: unknown) => formatResult(await mockHandleTransitions(args, stateDir)));
    },
  };
});

vi.mock('../../event-store/tools.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const mockAppend = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockQuery = vi.fn().mockResolvedValue({ success: true, data: [] });
  return {
    handleEventAppend: mockAppend,
    handleEventQuery: mockQuery,
    registerEventTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_event_append', 'Append an event to the event store with optional optimistic concurrency',
        { stream: z.string().min(1), event: z.record(z.string(), z.unknown()), expectedSequence: z.number().int().optional() },
        async (args: unknown) => formatResult(await mockAppend(args, stateDir)));
      s.tool('exarchos_event_query', 'Query events from the event store with optional filters (type, sinceSequence, since, until)',
        { stream: z.string().min(1), filter: z.record(z.string(), z.unknown()).optional() },
        async (args: unknown) => formatResult(await mockQuery(args, stateDir)));
    },
  };
});

vi.mock('../../views/tools.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const mockPipeline = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockTasks = vi.fn().mockResolvedValue({ success: true, data: [] });
  const mockWorkflowStatus = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockTeamStatus = vi.fn().mockResolvedValue({ success: true, data: {} });
  return {
    handleViewPipeline: mockPipeline,
    handleViewTasks: mockTasks,
    handleViewWorkflowStatus: mockWorkflowStatus,
    handleViewTeamStatus: mockTeamStatus,
    registerViewTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_view_pipeline', 'Get CQRS pipeline view aggregating all workflows with stack positions and phase tracking',
        {}, async (args: unknown) => formatResult(await mockPipeline(args, stateDir)));
      s.tool('exarchos_view_tasks', 'Get CQRS task detail view with optional filtering by workflowId and task properties',
        { workflowId: z.string().optional(), filter: z.record(z.string(), z.unknown()).optional() },
        async (args: unknown) => formatResult(await mockTasks(args, stateDir)));
      s.tool('exarchos_view_workflow_status', 'Get CQRS workflow status view with phase, task counts, and feature metadata',
        { workflowId: z.string().optional() },
        async (args: unknown) => formatResult(await mockWorkflowStatus(args, stateDir)));
      s.tool('exarchos_view_team_status', 'Get CQRS team status view with teammate composition and current task assignments',
        { workflowId: z.string().optional() },
        async (args: unknown) => formatResult(await mockTeamStatus(args, stateDir)));
    },
  };
});

vi.mock('../../team/tools.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const mockSpawn = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockMessage = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockBroadcast = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockShutdown = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockStatus = vi.fn().mockResolvedValue({ success: true, data: {} });
  return {
    handleTeamSpawn: mockSpawn, handleTeamMessage: mockMessage,
    handleTeamBroadcast: mockBroadcast, handleTeamShutdown: mockShutdown, handleTeamStatus: mockStatus,
    registerTeamTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_team_spawn', 'Spawn a new team member agent with a role assignment',
        { name: z.string().min(1), role: z.string().min(1), taskId: z.string().min(1), taskTitle: z.string().min(1), streamId: z.string().min(1), worktreePath: z.string().optional() },
        async (args: unknown) => formatResult(await mockSpawn(args, stateDir)));
      s.tool('exarchos_team_message', 'Send a direct message to a team member',
        { from: z.string().min(1), to: z.string().min(1), content: z.string().min(1), streamId: z.string().min(1), messageType: z.string().optional() },
        async (args: unknown) => formatResult(await mockMessage(args, stateDir)));
      s.tool('exarchos_team_broadcast', 'Broadcast a message to all team members',
        { from: z.string().min(1), content: z.string().min(1), streamId: z.string().min(1) },
        async (args: unknown) => formatResult(await mockBroadcast(args, stateDir)));
      s.tool('exarchos_team_shutdown', 'Shutdown a team member agent',
        { name: z.string().min(1), streamId: z.string().min(1) },
        async (args: unknown) => formatResult(await mockShutdown(args, stateDir)));
      s.tool('exarchos_team_status', 'Get status of all team members with health information',
        {}, async (args: unknown) => formatResult(await mockStatus(args, stateDir)));
    },
  };
});

vi.mock('../../tasks/tools.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const mockClaim = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockComplete = vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockFail = vi.fn().mockResolvedValue({ success: true, data: {} });
  return {
    handleTaskClaim: mockClaim, handleTaskComplete: mockComplete, handleTaskFail: mockFail,
    registerTaskTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_task_claim', 'Claim a task for execution by an agent',
        { taskId: z.string().min(1), agentId: z.string().min(1), streamId: z.string().min(1) },
        async (args: unknown) => formatResult(await mockClaim(args, stateDir)));
      s.tool('exarchos_task_complete', 'Mark a task as complete with optional artifacts',
        { taskId: z.string().min(1), result: z.record(z.string(), z.unknown()).optional(), streamId: z.string().min(1) },
        async (args: unknown) => formatResult(await mockComplete(args, stateDir)));
      s.tool('exarchos_task_fail', 'Mark a task as failed with error details and optional diagnostics',
        { taskId: z.string().min(1), error: z.string().min(1), diagnostics: z.record(z.string(), z.unknown()).optional(), streamId: z.string().min(1) },
        async (args: unknown) => formatResult(await mockFail(args, stateDir)));
    },
  };
});

vi.mock('../../stack/tools.js', async () => {
  const { z } = await import('zod');
  const { formatResult } = await import('../../format.js');
  const mockStackStatus = vi.fn().mockResolvedValue({ success: true, data: [] });
  const mockStackPlace = vi.fn().mockResolvedValue({ success: true, data: {} });
  return {
    handleStackStatus: mockStackStatus, handleStackPlace: mockStackPlace,
    registerStackTools: (server: unknown, stateDir: string) => {
      const s = server as { tool: (...args: unknown[]) => void };
      s.tool('exarchos_stack_status', 'Get current stack positions from stack.position-filled events',
        { streamId: z.string().optional() },
        async (args: unknown) => formatResult(await mockStackStatus(args, stateDir)));
      s.tool('exarchos_stack_place', 'Place an item on the stack by emitting a stack.position-filled event',
        { streamId: z.string().min(1), position: z.number().int(), taskId: z.string().min(1), branch: z.string().optional(), prUrl: z.string().optional() },
        async (args: unknown) => formatResult(await mockStackPlace(args, stateDir)));
    },
  };
});

// Import after mocks are set up
import { createServer } from '../../index.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MCP Server Entry Point', () => {
  beforeEach(() => {
    toolRegistrations.clear();
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('should register all 27 tools with correct names', () => {
      createServer('/tmp/test-state-dir');

      const expectedTools = [
        'exarchos_workflow_init', 'exarchos_workflow_list', 'exarchos_workflow_get',
        'exarchos_workflow_set', 'exarchos_workflow_summary', 'exarchos_workflow_reconcile',
        'exarchos_workflow_next_action', 'exarchos_workflow_transitions',
        'exarchos_workflow_cancel', 'exarchos_workflow_checkpoint',
        'exarchos_event_append', 'exarchos_event_query',
        'exarchos_view_pipeline', 'exarchos_view_tasks',
        'exarchos_view_workflow_status', 'exarchos_view_team_status',
        'exarchos_team_spawn', 'exarchos_team_message', 'exarchos_team_broadcast',
        'exarchos_team_shutdown', 'exarchos_team_status',
        'exarchos_task_claim', 'exarchos_task_complete', 'exarchos_task_fail',
        'exarchos_stack_status', 'exarchos_stack_place',
        'exarchos_sync_now',
      ];

      expect(toolRegistrations.size).toBe(27);

      for (const toolName of expectedTools) {
        expect(toolRegistrations.has(toolName)).toBe(true);
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

    it('should register tools with schemas', () => {
      createServer('/tmp/test-state-dir');
      for (const [, registration] of toolRegistrations) {
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

      expect(mockHandleInit).toHaveBeenCalledWith(
        { featureId: 'test-feat', workflowType: 'feature' }, '/tmp/test-state-dir');

      const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(typedResult.content).toHaveLength(1);
      expect(typedResult.content[0].type).toBe('text');
      expect(typedResult.isError).toBe(false);
      expect(JSON.parse(typedResult.content[0].text).success).toBe(true);
    });

    it('should route exarchos_workflow_list to handleList', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_list')!.handler({});
      expect(mockHandleList).toHaveBeenCalledWith({}, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_get to handleGet', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_get')!.handler({ featureId: 'my-feat', query: '.phase' });
      expect(mockHandleGet).toHaveBeenCalledWith({ featureId: 'my-feat', query: '.phase' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_set to handleSet', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_set')!.handler({ featureId: 'my-feat', phase: 'plan' });
      expect(mockHandleSet).toHaveBeenCalledWith({ featureId: 'my-feat', phase: 'plan' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_summary to handleSummary', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_summary')!.handler({ featureId: 'my-feat' });
      expect(mockHandleSummary).toHaveBeenCalledWith({ featureId: 'my-feat' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_reconcile to handleReconcile', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_reconcile')!.handler({ featureId: 'my-feat' });
      expect(mockHandleReconcile).toHaveBeenCalledWith({ featureId: 'my-feat' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_next_action to handleNextAction', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_next_action')!.handler({ featureId: 'my-feat' });
      expect(mockHandleNextAction).toHaveBeenCalledWith({ featureId: 'my-feat' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_transitions to handleTransitions', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_transitions')!.handler({ workflowType: 'feature' });
      expect(mockHandleTransitions).toHaveBeenCalledWith({ workflowType: 'feature' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_cancel to handleCancel', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_cancel')!.handler({ featureId: 'my-feat', reason: 'no longer needed' });
      expect(mockHandleCancel).toHaveBeenCalledWith({ featureId: 'my-feat', reason: 'no longer needed' }, '/tmp/test-state-dir');
    });

    it('should route exarchos_workflow_checkpoint to handleCheckpoint', async () => {
      createServer('/tmp/test-state-dir');
      await toolRegistrations.get('exarchos_workflow_checkpoint')!.handler({ featureId: 'my-feat', summary: 'mid-delegation' });
      expect(mockHandleCheckpoint).toHaveBeenCalledWith({ featureId: 'my-feat', summary: 'mid-delegation' }, '/tmp/test-state-dir');
    });

    it('should set isError to true when handler returns success: false', async () => {
      mockHandleInit.mockResolvedValueOnce({
        success: false,
        error: { code: 'STATE_ALREADY_EXISTS', message: 'Already exists' },
      });

      createServer('/tmp/test-state-dir');
      const result = await toolRegistrations.get('exarchos_workflow_init')!.handler({ featureId: 'dup', workflowType: 'feature' });

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
      const result = await toolRegistrations.get('exarchos_sync_now')!.handler({});

      const typedResult = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(typedResult.isError).toBe(true);
      const parsed = JSON.parse(typedResult.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('NOT_IMPLEMENTED');
      expect(parsed.error.message).toBe('Coming soon');
    });

    it('should register implemented team and task tools', () => {
      createServer('/tmp/test-state-dir');
      const implementedTools = [
        'exarchos_team_spawn', 'exarchos_team_message', 'exarchos_team_broadcast',
        'exarchos_team_shutdown', 'exarchos_team_status',
        'exarchos_task_claim', 'exarchos_task_complete', 'exarchos_task_fail',
        'exarchos_stack_status', 'exarchos_stack_place',
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
        if (originalEnv === undefined) { delete process.env.WORKFLOW_STATE_DIR; }
        else { process.env.WORKFLOW_STATE_DIR = originalEnv; }
      }
    });

    it('should fallback to cwd when git command fails', async () => {
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      vi.doMock('node:child_process', () => ({
        execSync: vi.fn(() => { throw new Error('fatal: not a git repository'); }),
      }));
      try {
        delete process.env.WORKFLOW_STATE_DIR;
        vi.resetModules();
        vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
          McpServer: vi.fn().mockImplementation(() => ({ tool: vi.fn(), connect: vi.fn().mockResolvedValue(undefined) })),
        }));
        vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: vi.fn() }));
        const { resolveStateDir } = await import('../../index.js');
        const result = await resolveStateDir();
        expect(result).toMatch(/docs[/\\]workflow-state$/);
        expect(result).toBe(`${process.cwd()}/docs/workflow-state`);
      } finally {
        if (originalEnv === undefined) { delete process.env.WORKFLOW_STATE_DIR; }
        else { process.env.WORKFLOW_STATE_DIR = originalEnv; }
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
