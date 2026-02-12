// ─── Stack MCP Tool Handlers ────────────────────────────────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventStore } from '../event-store/store.js';
import { formatResult, toEventAck, type ToolResult } from '../format.js';
import { getOrCreateMaterializer, getOrCreateEventStore } from '../views/tools.js';
import { STACK_VIEW } from '../views/stack-view.js';
import type { StackViewState } from '../views/stack-view.js';

// ─── Module-Level EventStore (injected via registerStackTools) ───────────────

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

  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);

    await materializer.loadFromSnapshot(args.streamId, STACK_VIEW);
    const events = await store.query(args.streamId);
    const view = materializer.materialize<StackViewState>(args.streamId, STACK_VIEW, events);

    return { success: true, data: view.positions };
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

export function registerStackTools(server: McpServer, stateDir: string, eventStore: EventStore): void {
  moduleEventStore = eventStore;
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
