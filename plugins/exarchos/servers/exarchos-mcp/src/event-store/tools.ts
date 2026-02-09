import { EventStore, SequenceConflictError } from './store.js';
import type { WorkflowEvent, EventType } from './schemas.js';
import { Outbox } from '../sync/outbox.js';
import { loadSyncConfig } from '../sync/config.js';

// ─── Tool Result Type ───────────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  data?: WorkflowEvent | WorkflowEvent[];
  error?: { code: string; message: string };
}

// ─── Shared Store Instance Cache ────────────────────────────────────────────

const storeCache = new Map<string, EventStore>();

function getStore(stateDir: string): EventStore {
  let store = storeCache.get(stateDir);
  if (!store) {
    store = new EventStore(stateDir);
    storeCache.set(stateDir, store);
  }
  return store;
}

// ─── Event Append Handler ───────────────────────────────────────────────────

export async function handleEventAppend(
  args: {
    stream: string;
    event: Record<string, unknown>;
    expectedSequence?: number;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.stream) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'stream is required' },
    };
  }

  const eventType = args.event?.type as EventType | undefined;
  if (!eventType) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'event.type is required' },
    };
  }

  const store = getStore(stateDir);

  try {
    const event = await store.append(
      args.stream,
      {
        type: eventType,
        data: args.event.data as Record<string, unknown> | undefined,
        correlationId: args.event.correlationId as string | undefined,
        causationId: args.event.causationId as string | undefined,
        agentId: args.event.agentId as string | undefined,
        agentRole: args.event.agentRole as string | undefined,
        source: args.event.source as string | undefined,
        timestamp: args.event.timestamp as string | undefined,
      },
      args.expectedSequence !== undefined
        ? { expectedSequence: args.expectedSequence }
        : undefined,
    );

    // Dual-write to outbox if sync mode is not local
    try {
      const syncConfig = loadSyncConfig(stateDir);
      if (syncConfig.mode !== 'local') {
        const outbox = new Outbox(stateDir);
        await outbox.addEntry(args.stream, event);
      }
    } catch {
      // Outbox write failure should not fail the primary append
    }

    return { success: true, data: event };
  } catch (err) {
    if (err instanceof SequenceConflictError) {
      return {
        success: false,
        error: {
          code: 'SEQUENCE_CONFLICT',
          message: `Expected sequence ${err.expected}, actual ${err.actual}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'APPEND_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Event Query Handler ────────────────────────────────────────────────────

export async function handleEventQuery(
  args: {
    stream?: string;
    filter?: Record<string, unknown>;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.stream) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'stream is required' },
    };
  }

  const store = getStore(stateDir);

  const filters = args.filter
    ? {
        type: args.filter.type as string | undefined,
        sinceSequence: args.filter.sinceSequence as number | undefined,
        since: args.filter.since as string | undefined,
        until: args.filter.until as string | undefined,
      }
    : undefined;

  try {
    const events = await store.query(args.stream, filters);
    return { success: true, data: events };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'QUERY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
