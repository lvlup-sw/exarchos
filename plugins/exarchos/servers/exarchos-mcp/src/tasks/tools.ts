// ─── Task MCP Tool Handlers ─────────────────────────────────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventStore, SequenceConflictError } from '../event-store/store.js';
import { formatResult, toEventAck, type ToolResult } from '../format.js';

// ─── Module-Level EventStore (injected via registerTaskTools) ────────────────

let moduleEventStore: EventStore | null = null;

function getStore(stateDir: string): EventStore {
  if (!moduleEventStore) {
    moduleEventStore = new EventStore(stateDir);
  }
  return moduleEventStore;
}

/** For testing: reset the module-level EventStore */
export function resetModuleEventStore(): void {
  moduleEventStore = null;
}

// ─── handleTaskClaim ──────────────────────────────────────────────────────

const MAX_CLAIM_RETRIES = 3;

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

  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      return await attemptTaskClaim(store, args);
    } catch (err) {
      if (err instanceof SequenceConflictError) {
        continue; // Retry: re-query and re-check
      }
      return {
        success: false,
        error: {
          code: 'CLAIM_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    success: false,
    error: {
      code: 'CLAIM_FAILED',
      message: `Task claim failed after ${MAX_CLAIM_RETRIES} retries due to concurrent modifications`,
    },
  };
}

/** Attempt a single claim with optimistic concurrency via expectedSequence. */
async function attemptTaskClaim(
  store: EventStore,
  args: { taskId: string; agentId: string; streamId: string },
): Promise<ToolResult> {
  // Query all events to get current sequence and check for existing claims
  const allEvents = await store.query(args.streamId);
  const currentSequence = allEvents.length;

  const alreadyClaimed = allEvents.some(
    (e) => e.type === 'task.claimed' && (e.data as Record<string, unknown>)?.taskId === args.taskId,
  );
  if (alreadyClaimed) {
    return {
      success: false,
      error: {
        code: 'ALREADY_CLAIMED',
        message: `Task '${args.taskId}' is already claimed`,
      },
    };
  }

  const event = await store.append(
    args.streamId,
    {
      type: 'task.claimed',
      data: {
        taskId: args.taskId,
        agentId: args.agentId,
        claimedAt: new Date().toISOString(),
      },
      agentId: args.agentId,
    },
    { expectedSequence: currentSequence },
  );

  return { success: true, data: toEventAck(event) };
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

export function registerTaskTools(server: McpServer, stateDir: string, eventStore: EventStore): void {
  moduleEventStore = eventStore;
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
