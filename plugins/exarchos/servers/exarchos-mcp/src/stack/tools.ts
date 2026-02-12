// ─── Stack MCP Tool Handlers ────────────────────────────────────────────────

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

// ─── Stack Position Type ───────────────────────────────────────────────────

interface StackPosition {
  position: number;
  taskId: string;
  branch?: string;
  prUrl?: string;
}

// ─── handleStackStatus ─────────────────────────────────────────────────────

export async function handleStackStatus(
  args: {
    streamId?: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.streamId) {
    return { success: true, data: [] };
  }

  const store = getStore(stateDir);

  try {
    const events = await store.query(args.streamId, { type: 'stack.position-filled' });

    const positions: StackPosition[] = events.map((event) => {
      const data = event.data as Record<string, unknown>;
      const position: StackPosition = {
        position: data.position as number,
        taskId: data.taskId as string,
      };
      if (data.branch !== undefined) {
        position.branch = data.branch as string;
      }
      if (data.prUrl !== undefined) {
        position.prUrl = data.prUrl as string;
      }
      return position;
    });

    return { success: true, data: positions };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'STATUS_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleStackPlace ──────────────────────────────────────────────────────

export async function handleStackPlace(
  args: {
    streamId: string;
    position: number;
    taskId: string;
    branch?: string;
    prUrl?: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!Number.isInteger(args.position) || args.position < 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'position must be a non-negative integer' },
    };
  }

  const store = getStore(stateDir);

  const data: Record<string, unknown> = {
    position: args.position,
    taskId: args.taskId,
  };

  if (args.branch !== undefined) {
    data.branch = args.branch;
  }

  if (args.prUrl !== undefined) {
    data.prUrl = args.prUrl;
  }

  try {
    const event = await store.append(args.streamId, {
      type: 'stack.position-filled',
      data,
    });

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'PLACE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Registration Function ──────────────────────────────────────────────────

export function registerStackTools(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_stack_status',
    'Get current stack positions from stack.position-filled events',
    { streamId: z.string().optional() },
    async (args) => formatResult(await handleStackStatus(args, stateDir)),
  );

  server.tool(
    'exarchos_stack_place',
    'Place an item on the stack by emitting a stack.position-filled event',
    {
      streamId: z.string().min(1),
      position: z.number().int().nonnegative(),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
    },
    async (args) => formatResult(await handleStackPlace(args, stateDir)),
  );
}
