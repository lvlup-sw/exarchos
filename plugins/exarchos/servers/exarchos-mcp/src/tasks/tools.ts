// ─── Task MCP Tool Handlers ─────────────────────────────────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventStore } from '../event-store/store.js';
import { formatResult, toEventAck, type ToolResult } from '../format.js';

// ─── Shared Store Cache ────────────────────────────────────────────────────

const storeCache = new Map<string, EventStore>();

function getStore(stateDir: string): EventStore {
  let store = storeCache.get(stateDir);
  if (!store) {
    store = new EventStore(stateDir);
    storeCache.set(stateDir, store);
  }
  return store;
}

// ─── handleTaskClaim ──────────────────────────────────────────────────────

export async function handleTaskClaim(
  args: {
    taskId: string;
    agentId: string;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.agentId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'agentId is required' },
    };
  }

  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  const store = getStore(stateDir);

  try {
    const event = await store.append(args.streamId, {
      type: 'task.claimed',
      data: {
        taskId: args.taskId,
        agentId: args.agentId,
        claimedAt: new Date().toISOString(),
      },
      agentId: args.agentId,
    });

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'CLAIM_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTaskComplete ───────────────────────────────────────────────────

export async function handleTaskComplete(
  args: {
    taskId: string;
    result?: Record<string, unknown>;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  const store = getStore(stateDir);

  const data: Record<string, unknown> = { taskId: args.taskId };
  if (args.result) {
    if (args.result.artifacts) {
      data.artifacts = args.result.artifacts;
    }
    if (args.result.duration !== undefined) {
      data.duration = args.result.duration;
    }
  }

  try {
    const event = await store.append(args.streamId, {
      type: 'task.completed',
      data,
    });

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'COMPLETE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTaskFail ───────────────────────────────────────────────────────

export async function handleTaskFail(
  args: {
    taskId: string;
    error: string;
    diagnostics?: Record<string, unknown>;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.error) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'error is required' },
    };
  }

  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  const store = getStore(stateDir);

  const data: Record<string, unknown> = {
    taskId: args.taskId,
    error: args.error,
  };

  if (args.diagnostics) {
    data.diagnostics = args.diagnostics;
  }

  try {
    const event = await store.append(args.streamId, {
      type: 'task.failed',
      data,
    });

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'FAIL_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Registration Function ──────────────────────────────────────────────────

export function registerTaskTools(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_task_claim',
    'Claim a task for execution by an agent',
    {
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskClaim(args, stateDir)),
  );

  server.tool(
    'exarchos_task_complete',
    'Mark a task as complete with optional artifacts',
    {
      taskId: z.string().min(1),
      result: z.record(z.string(), z.unknown()).optional(),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskComplete(args, stateDir)),
  );

  server.tool(
    'exarchos_task_fail',
    'Mark a task as failed with error details and optional diagnostics',
    {
      taskId: z.string().min(1),
      error: z.string().min(1),
      diagnostics: z.record(z.string(), z.unknown()).optional(),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskFail(args, stateDir)),
  );
}
