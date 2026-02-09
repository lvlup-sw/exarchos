// ─── Stack MCP Tool Handlers ────────────────────────────────────────────────

import { EventStore } from '../event-store/store.js';

// ─── Tool Result Type ──────────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

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

    return { success: true, data: event };
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
