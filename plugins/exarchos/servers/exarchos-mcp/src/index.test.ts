import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track server.tool() calls
const toolCalls: Array<{ name: string; description: string }> = [];

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(
      (name: string, description: string, _schema: unknown, _handler: unknown) => {
        toolCalls.push({ name, description });
      },
    ),
  })),
}));

// Mock EventStore to prevent filesystem access
vi.mock('./event-store/store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({})),
}));

// Mock all module registration / configuration functions that index.ts imports.
// The configure* functions are no-ops; the register* functions are stubs that
// call server.tool() internally — but since we already mock McpServer, any calls
// they make will just be captured by our tracker above.
vi.mock('./workflow/tools.js', () => ({
  configureWorkflowEventStore: vi.fn(),
  registerWorkflowTools: vi.fn(),
}));

vi.mock('./workflow/next-action.js', () => ({
  configureNextActionEventStore: vi.fn(),
  registerNextActionTool: vi.fn(),
}));

vi.mock('./workflow/cancel.js', () => ({
  configureCancelEventStore: vi.fn(),
  registerCancelTool: vi.fn(),
}));

vi.mock('./workflow/query.js', () => ({
  configureQueryEventStore: vi.fn(),
  registerQueryTools: vi.fn(),
}));

vi.mock('./event-store/tools.js', () => ({
  registerEventTools: vi.fn(),
}));

vi.mock('./views/tools.js', () => ({
  registerViewTools: vi.fn(),
}));

vi.mock('./team/tools.js', () => ({
  registerTeamTools: vi.fn(),
}));

vi.mock('./tasks/tools.js', () => ({
  registerTaskTools: vi.fn(),
}));

vi.mock('./stack/tools.js', () => ({
  registerStackTools: vi.fn(),
}));

// Mock composite handlers (will be used after implementation)
vi.mock('./workflow/composite.js', () => ({
  handleWorkflow: vi.fn(),
}));

vi.mock('./event-store/composite.js', () => ({
  handleEvent: vi.fn(),
}));

vi.mock('./orchestrate/composite.js', () => ({
  handleOrchestrate: vi.fn(),
}));

vi.mock('./views/composite.js', () => ({
  handleView: vi.fn(),
}));

import { createServer } from './index.js';
import { configureWorkflowEventStore } from './workflow/tools.js';
import { configureNextActionEventStore } from './workflow/next-action.js';
import { configureCancelEventStore } from './workflow/cancel.js';
import { configureQueryEventStore } from './workflow/query.js';

describe('createServer', () => {
  beforeEach(() => {
    toolCalls.length = 0;
    vi.clearAllMocks();
  });

  it('should register exactly 5 tools', () => {
    createServer('/tmp/test-state');

    expect(toolCalls).toHaveLength(5);
  });

  it('should register the expected composite tool names', () => {
    createServer('/tmp/test-state');

    const names = toolCalls.map((c) => c.name);
    expect(names).toEqual([
      'exarchos_workflow',
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_sync',
    ]);
  });

  it('should include descriptions for each composite tool', () => {
    createServer('/tmp/test-state');

    for (const call of toolCalls) {
      expect(call.description.length).toBeGreaterThan(0);
    }
  });

  it('should still configure EventStore instances for modules', () => {
    createServer('/tmp/test-state');

    expect(configureWorkflowEventStore).toHaveBeenCalledTimes(1);
    expect(configureNextActionEventStore).toHaveBeenCalledTimes(1);
    expect(configureCancelEventStore).toHaveBeenCalledTimes(1);
    expect(configureQueryEventStore).toHaveBeenCalledTimes(1);
  });
});
