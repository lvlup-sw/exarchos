import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventStore, SequenceConflictError } from './store.js';
import type { EventType } from './schemas.js';
import { formatResult, pickFields, toEventAck, type ToolResult } from '../format.js';

// ─── Module-Level EventStore (injected via registerEventTools) ───────────────

let moduleEventStore: EventStore | null = null;

/** Returns a cached EventStore instance for the given state directory, creating one if needed. */
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

// ─── Event Append Handler ───────────────────────────────────────────────────

/** Handles the event_append tool: validates input, appends an event to the store, and returns an EventAck. */
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

    return { success: true, data: toEventAck(event) };
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

/** Handles the event_query tool: validates input, queries events with optional filters and pagination. */
export async function handleEventQuery(
  args: {
    stream?: string;
    filter?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    fields?: string[];
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

  const hasFilterFields = args.filter || args.limit !== undefined || args.offset !== undefined;
  const filters = hasFilterFields
    ? {
        type: args.filter?.type as string | undefined,
        sinceSequence: args.filter?.sinceSequence as number | undefined,
        since: args.filter?.since as string | undefined,
        until: args.filter?.until as string | undefined,
        limit: args.limit,
        offset: args.offset,
      }
    : undefined;

  try {
    const events = await store.query(args.stream, filters);

    // Apply field projection if requested
    if (args.fields && args.fields.length > 0) {
      const safeFields = args.fields.filter(
        (field) => !['__proto__', 'constructor', 'prototype'].includes(field),
      );
      const projected = events.map((event) =>
        pickFields(event as unknown as Record<string, unknown>, safeFields),
      );
      return { success: true, data: projected };
    }

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

// ─── Registration Function ──────────────────────────────────────────────────

export function registerEventTools(server: McpServer, stateDir: string, eventStore: EventStore): void {
  moduleEventStore = eventStore;
  server.tool(
    'exarchos_event_append',
    'Append an event to the event store with optional optimistic concurrency',
    {
      stream: z.string().min(1),
      event: z.record(z.string(), z.unknown()),
      expectedSequence: z.number().int().optional(),
    },
    async (args) => formatResult(await handleEventAppend(args, stateDir)),
  );

  server.tool(
    'exarchos_event_query',
    'Query events from the event store with optional filters (type, sinceSequence, since, until), pagination (limit, offset), and field projection (fields)',
    {
      stream: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      fields: z.array(z.string()).optional(),
    },
    async (args) => formatResult(await handleEventQuery(args, stateDir)),
  );
}
