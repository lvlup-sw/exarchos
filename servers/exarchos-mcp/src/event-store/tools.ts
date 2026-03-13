import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodError } from 'zod';
import { coercedStringArray } from '../coerce.js';
import { EventStore, SequenceConflictError } from './store.js';
import type { EventType } from './schemas.js';
import { formatResult, pickFields, toEventAck, type ToolResult } from '../format.js';
import { buildValidatedEvent } from './event-factory.js';

// ─── Module-Level EventStore (removed — now threaded via DispatchContext) ─────

// ─── Event Append Handler ───────────────────────────────────────────────────

/** Handles the event_append tool: validates input, appends an event to the store, and returns an EventAck. */
export async function handleEventAppend(
  args: {
    stream: string;
    event: Record<string, unknown>;
    expectedSequence?: number;
    idempotencyKey?: string;
  },
  stateDir: string,
  eventStore: EventStore,
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

  const store = eventStore;

  try {
    // Validate at the system boundary (MCP tool handler = untrusted input)
    // Sequence 1 is a placeholder — appendValidated overwrites it with the real sequence
    const validatedEvent = buildValidatedEvent(args.stream, 1, {
      type: eventType,
      data: args.event.data as Record<string, unknown> | undefined,
      correlationId: args.event.correlationId as string | undefined,
      causationId: args.event.causationId as string | undefined,
      agentId: args.event.agentId as string | undefined,
      agentRole: args.event.agentRole as string | undefined,
      tenantId: args.event.tenantId as string | undefined,
      organizationId: args.event.organizationId as string | undefined,
      source: args.event.source as string | undefined,
      timestamp: args.event.timestamp as string | undefined,
    });

    // Append without re-validating (already validated above)
    const event = await store.appendValidated(
      args.stream,
      validatedEvent,
      (args.expectedSequence !== undefined || args.idempotencyKey !== undefined)
        ? {
            expectedSequence: args.expectedSequence,
            idempotencyKey: args.idempotencyKey,
          }
        : undefined,
    );

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Event data validation failed for type '${eventType}': ${err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        },
      };
    }
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

// ─── Batch Append Handler ───────────────────────────────────────────────────

/** Handles the event batch_append tool: validates all events upfront, appends atomically, and returns EventAck[]. */
export async function handleBatchAppend(
  args: {
    stream: string;
    events: Array<Record<string, unknown>>;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.stream) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'stream is required' },
    };
  }

  if (!args.events || args.events.length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'events array must be non-empty' },
    };
  }

  // Validate all events have a type before passing to store
  for (let i = 0; i < args.events.length; i++) {
    const eventType = args.events[i]?.type as EventType | undefined;
    if (!eventType) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `events[${i}].type is required` },
      };
    }
  }

  const store = eventStore;

  try {
    const storeEvents = args.events.map((event) => ({
      type: event.type as EventType,
      ...(event.data !== undefined && { data: event.data as Record<string, unknown> }),
      ...(event.correlationId !== undefined && { correlationId: event.correlationId as string }),
      ...(event.causationId !== undefined && { causationId: event.causationId as string }),
      ...(event.agentId !== undefined && { agentId: event.agentId as string }),
      ...(event.agentRole !== undefined && { agentRole: event.agentRole as string }),
      ...(event.tenantId !== undefined && { tenantId: event.tenantId as string }),
      ...(event.organizationId !== undefined && { organizationId: event.organizationId as string }),
      ...(event.source !== undefined && { source: event.source as string }),
      ...(event.timestamp !== undefined && { timestamp: event.timestamp as string }),
      ...(event.idempotencyKey !== undefined && { idempotencyKey: event.idempotencyKey as string }),
    }));

    const appended = await store.batchAppend(args.stream, storeEvents);

    return {
      success: true,
      data: appended.map(toEventAck),
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'BATCH_APPEND_FAILED',
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
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.stream) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'stream is required' },
    };
  }

  const store = eventStore;

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
  // moduleEventStore removed — EventStore now threaded via DispatchContext
  server.tool(
    'exarchos_event_append',
    'Append an event to the event store with optional optimistic concurrency and idempotency key',
    {
      stream: z.string().min(1),
      event: z.record(z.string(), z.unknown()),
      expectedSequence: z.number().int().optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => formatResult(await handleEventAppend(args, stateDir, eventStore)),
  );

  server.tool(
    'exarchos_event_query',
    'Query events from the event store with optional filters (type, sinceSequence, since, until), pagination (limit, offset), and field projection (fields)',
    {
      stream: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      fields: coercedStringArray().optional(),
    },
    async (args) => formatResult(await handleEventQuery(args, stateDir, eventStore)),
  );
}
