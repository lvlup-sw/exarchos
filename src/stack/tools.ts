// ─── Stack MCP Tool Handlers ────────────────────────────────────────────────

import type { EventStore } from '../events/store.js';
import { toEventAck, type ToolResult } from '../format.js';
import { getOrCreateMaterializer } from '../projections/views/tools.js';
import { STACK_VIEW } from '../projections/views/stack-view.js';
import type { StackViewState } from '../projections/views/stack-view.js';

// ─── handleStackStatus ─────────────────────────────────────────────────────

export async function handleStackStatus(
  args: {
    streamId?: string;
    limit?: number;
    offset?: number;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.streamId) {
    return { success: true, data: [] };
  }

  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);

    await materializer.loadFromSnapshot(args.streamId, STACK_VIEW);
    const events = await store.query(args.streamId);
    const view = materializer.materialize<StackViewState>(args.streamId, STACK_VIEW, events);

    let positions = view.positions;

    // Apply optional offset (before limit)
    if (args.offset !== undefined) {
      positions = positions.slice(args.offset);
    }

    // Apply optional limit (after offset)
    if (args.limit !== undefined) {
      positions = positions.slice(0, args.limit);
    }

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
  _stateDir: string,
  eventStore: EventStore,
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

  const store = eventStore;

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

