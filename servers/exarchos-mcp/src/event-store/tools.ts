import { z, ZodError } from 'zod';
import { EventStore, SequenceConflictError } from './store.js';
import { EVENT_DATA_SCHEMAS, type EventType, WorkflowEventBase } from './schemas.js';
import { pickFields, toEventAck, type EventAck, type ToolResult } from '../format.js';
import { buildValidatedEvent } from './event-factory.js';
import { randomUUID } from 'node:crypto';

// `toSafeEventAck` previously translated synthetic sequence-0 acks emitted by
// the EventStore sidecar fallback (#1082) into a `{sequence: -1,
// sequencePending: true}` envelope. v2.11 Phase 1 deleted that fallback —
// every successful append now returns a real positive sequence — so the
// helper is gone. Use `toEventAck` directly.

// ─── Misplaced Field Detection ──────────────────────────────────────────────

/** Known envelope fields that belong at the top level of an event. */
const ENVELOPE_FIELDS = new Set([
  'type', 'data', 'correlationId', 'causationId', 'agentId', 'agentRole',
  'tenantId', 'organizationId', 'source', 'timestamp', 'idempotencyKey',
  'schemaVersion',
]);

/**
 * Detect event-type-specific fields that were placed at the top level
 * instead of inside the `data` envelope. Returns misplaced field names
 * or an empty array if none are found.
 */
function detectMisplacedFields(event: Record<string, unknown>): string[] {
  const eventType = event.type as EventType | undefined;
  if (!eventType) return [];

  const dataSchema = EVENT_DATA_SCHEMAS[eventType];
  if (!dataSchema) return [];

  // Extract known field names from the Zod schema
  const schemaShape = (dataSchema as z.ZodObject<z.ZodRawShape>).shape;
  if (!schemaShape || typeof schemaShape !== 'object') return [];

  const dataFieldNames = new Set(Object.keys(schemaShape));
  const misplaced: string[] = [];

  for (const key of Object.keys(event)) {
    if (!ENVELOPE_FIELDS.has(key) && dataFieldNames.has(key)) {
      misplaced.push(key);
    }
  }

  return misplaced;
}

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

  // Detect fields that should be inside data but were placed at the top level
  const misplaced = detectMisplacedFields(args.event);
  if (misplaced.length > 0) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: `Event fields placed at wrong level — ${misplaced.map(f => `"${f}"`).join(', ')} should be inside "data", not at the top level. Wrap them: { type: "${eventType}", data: { ${misplaced.join(', ')}: ... } }`,
      },
    };
  }

  // ─── DR-3: cross-stream reducer for team.disbanded (T26) ─────────────────
  //
  // Agents bookkeep `tasksCompleted` in memory and frequently get the count
  // wrong (the #1224 off-by-N regression). The handler reduces over the
  // events table via `EventStore.queryByType` with `streamPrefix: <featureId>`,
  // counting `task.completed` events scoped to `teamId` across the parent
  // stream AND every namespaced subagent stream (`<featureId>/<subagent-id>`).
  // No derived state is consulted — the only source of truth is the events
  // table, satisfying INV-1 (stores-as-projections).
  if (eventType === 'team.disbanded') {
    const data = (args.event.data ?? {}) as Record<string, unknown>;
    const teamId = data.teamId as string | undefined;
    if (typeof teamId === 'string' && teamId.length > 0) {
      // Reduce over the events table: query every task.completed event whose
      // stream is `<featureId>` or `<featureId>/<segment>`, filter by teamId,
      // and count. The query runs BEFORE the team.disbanded append so the
      // count reflects the team's complete set of children at emission time.
      let tasksCompleted: number;
      try {
        const taskCompletedEvents = await store.queryByType('task.completed', {
          streamPrefix: args.stream,
        });
        tasksCompleted = 0;
        for (const event of taskCompletedEvents) {
          const eventData = (event.data ?? {}) as Record<string, unknown>;
          if (eventData.teamId === teamId) tasksCompleted += 1;
        }
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'APPEND_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      // Construct the persisted data: drop the caller-supplied tasksCompleted
      // (it's the regression vector) and overwrite with the canonical count.
      const persistedData: Record<string, unknown> = { teamId };
      for (const [key, value] of Object.entries(data)) {
        if (key === 'tasksCompleted' || key === 'teamId') continue;
        persistedData[key] = value;
      }
      persistedData.tasksCompleted = tasksCompleted;
      if (typeof persistedData.totalDurationMs !== 'number') {
        persistedData.totalDurationMs = 0;
      }
      if (typeof persistedData.tasksFailed !== 'number') {
        persistedData.tasksFailed = 0;
      }

      // Append the corrected event via the standard validated path. The
      // append runs under AtomicAppender's per-stream lock so concurrent
      // late-arriving task.completed events (which are themselves serialized
      // through their own stream's lock) don't race with this emission's
      // count read. If a late arrival lands AFTER the read, it lands AFTER
      // this team.disbanded too — its count will simply be reflected in any
      // subsequent re-emission, which is the expected convergence semantic.
      try {
        const validatedEvent = buildValidatedEvent(args.stream, 1, {
          type: eventType,
          data: persistedData,
          correlationId: args.event.correlationId as string | undefined,
          causationId: args.event.causationId as string | undefined,
          agentId: args.event.agentId as string | undefined,
          agentRole: args.event.agentRole as string | undefined,
          tenantId: args.event.tenantId as string | undefined,
          organizationId: args.event.organizationId as string | undefined,
          source: args.event.source as string | undefined,
          timestamp: args.event.timestamp as string | undefined,
        });
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
    // Fall through to the legacy path when teamId is missing — the cross-
    // stream reducer can't scope its query without it, and the schema-level
    // validation below will produce the right error message.
  }

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

  // Validate all events have a type and no misplaced fields
  for (let i = 0; i < args.events.length; i++) {
    const eventType = args.events[i]?.type as EventType | undefined;
    if (!eventType) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `events[${i}].type is required` },
      };
    }

    const misplaced = detectMisplacedFields(args.events[i]);
    if (misplaced.length > 0) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `events[${i}]: fields placed at wrong level — ${misplaced.map(f => `"${f}"`).join(', ')} should be inside "data", not at the top level. Wrap them: { type: "${eventType}", data: { ${misplaced.join(', ')}: ... } }`,
        },
      };
    }
  }

  const store = eventStore;

  // v2.11 Phase 1: sidecar fallback (#1082) deleted — no JSONL/sidecar split,
  // so AtomicAppender owns the only batch path.

  // Pre-dedup within batch by per-event idempotencyKey (preserves the
  // single-key-dedup contract `batchAppend_IdempotencyKey_DeduplicatesAcrossBatch`
  // exercises). The appender itself dedups across calls via the batch
  // idempotencyKey we derive below.
  const seenBatchKeys = new Set<string>();
  const dedupedEvents: Array<Record<string, unknown>> = [];
  for (const event of args.events) {
    const key = event.idempotencyKey as string | undefined;
    if (key !== undefined) {
      if (seenBatchKeys.has(key)) continue;
      seenBatchKeys.add(key);
    }
    dedupedEvents.push(event);
  }

  // Validate envelope only (matches legacy EventStore.batchAppend behavior:
  // type must be a known EventType, but the per-type data schema is enforced
  // elsewhere — we don't tighten that contract here). Boundary misplaced-field
  // detection already ran above. The placeholder sequence/streamId fields are
  // overwritten by AtomicAppender; they're present only because the schema
  // requires them.
  type ValidatedEvent = {
    type: EventType;
    data?: Record<string, unknown>;
    correlationId?: string;
    causationId?: string;
    agentId?: string;
    agentRole?: string;
    tenantId?: string;
    organizationId?: string;
    source?: string;
    timestamp?: string;
  };
  let validatedEvents: ValidatedEvent[];
  try {
    validatedEvents = dedupedEvents.map((event) => {
      const parsed = WorkflowEventBase.parse({
        ...event,
        streamId: args.stream,
        sequence: 1, // placeholder; AtomicAppender allocates the real sequence
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
      const out: ValidatedEvent = { type: parsed.type as EventType };
      if (parsed.data !== undefined) out.data = parsed.data;
      if (parsed.correlationId !== undefined) out.correlationId = parsed.correlationId;
      if (parsed.causationId !== undefined) out.causationId = parsed.causationId;
      if (parsed.agentId !== undefined) out.agentId = parsed.agentId;
      if (parsed.agentRole !== undefined) out.agentRole = parsed.agentRole;
      if (parsed.tenantId !== undefined) out.tenantId = parsed.tenantId;
      if (parsed.organizationId !== undefined) out.organizationId = parsed.organizationId;
      if (parsed.source !== undefined) out.source = parsed.source;
      if (parsed.timestamp !== undefined) out.timestamp = parsed.timestamp;
      return out;
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Batch validation failed: ${err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'BATCH_APPEND_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // If dedup pruned everything (all events shared a key already in flight), the
  // legacy contract returns success with empty data. Match that for byte-compat.
  if (validatedEvents.length === 0) {
    return { success: true, data: [] };
  }

  // Derive the batch idempotencyKey:
  //   - All events share one key  -> use it (preserves cross-batch retry semantics).
  //   - Mixed or absent           -> synthesize a fresh UUID (no cross-batch dedup).
  // The AtomicAppender's idempotency cache is keyed by this batch key; subsequent
  // batches that pass the same key get the cached events back without re-appending.
  const perEventKeys = dedupedEvents
    .map((e) => e.idempotencyKey as string | undefined)
    .filter((k): k is string => typeof k === 'string');
  let batchIdempotencyKey: string;
  if (perEventKeys.length === dedupedEvents.length && perEventKeys.length > 0) {
    const allSame = perEventKeys.every((k) => k === perEventKeys[0]);
    batchIdempotencyKey = allSame ? perEventKeys[0] : `batch:${randomUUID()}`;
  } else {
    batchIdempotencyKey = `batch:${randomUUID()}`;
  }

  const appender = store.getAppender();
  const result = await appender.append(args.stream, validatedEvents, batchIdempotencyKey);

  if (!result.ok) {
    return {
      success: false,
      error: {
        code: 'BATCH_APPEND_FAILED',
        message: result.cause ? result.cause.message : `Append failed: ${result.reason}`,
      },
    };
  }

  // Map AppendResult.sequences/eventIds back to EventAck shape — preserves the
  // success envelope `{success: true, data: EventAck[]}` callers depend on.
  //
  // Cache-hit branch: a retry reusing the same `batchIdempotencyKey` may
  // pass FEWER events than the originally-cached batch (or different
  // events entirely). `result.sequences.length` reflects the cached
  // batch, NOT `validatedEvents.length`. Indexing `validatedEvents[i]`
  // for the type field would crash with `Cannot read properties of
  // undefined` whenever the cached batch is longer (Sentry comment
  // 3205861163). Use `persistedEvents[i].type` from the appender's
  // cache-hit payload instead — that's the type ACTUALLY persisted, which
  // is what the EventAck should reflect.
  // v2.11 Phase 1: with sidecar fallback gone, every successful append
  // returns a real positive sequence — no `sequencePending` envelope.
  const acks: EventAck[] = result.kind === 'cache-hit'
    ? result.persistedEvents.map((e, i) =>
        toEventAck({
          streamId: args.stream,
          sequence: result.sequences[i],
          type: e.type,
        }),
      )
    : result.sequences.map((sequence, i) =>
        toEventAck({
          streamId: args.stream,
          sequence,
          type: validatedEvents[i].type,
        }),
      );
  return { success: true, data: acks };
}

// ─── Event Query Handler ────────────────────────────────────────────────────

/**
 * DR-5 — default page size for `event query`.
 *
 * When the caller supplies no explicit `limit`, the handler returns the 20
 * NEWEST events plus `page` metadata instead of the unbounded stream (the
 * audit measured a 112-event stream at 5,755 tokens unbounded vs 1,490 at
 * limit 20). Full history stays reachable via an explicit `limit`/`offset`.
 */
export const EVENT_QUERY_DEFAULT_LIMIT = 20;

/** Paging metadata returned alongside `event query` results (DR-5). */
export interface EventQueryPage {
  /** Total events matching the window filters, before limit/offset. */
  readonly total: number;
  /** Zero-based offset into the newest-first ordering this page starts at. */
  readonly offset: number;
  /** Effective page size — the explicit `limit`, else {@link EVENT_QUERY_DEFAULT_LIMIT}. */
  readonly limit: number;
  /** True when events outside this page remain, i.e. `offset + shown < total`. */
  readonly hasMore: boolean;
}

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

  // Window filters (type/time/sequence) narrow WHICH events match and are
  // pushed to the store. Pagination (limit/offset) is applied in-handler over a
  // newest-first ordering: the store orders ascending by sequence, so deriving
  // both `page.total` and a deterministic newest-first window requires the full
  // matching set. `limit`/`offset` are therefore NOT forwarded to the store.
  const hasWindowFilter =
    args.filter?.type !== undefined ||
    args.filter?.sinceSequence !== undefined ||
    args.filter?.since !== undefined ||
    args.filter?.until !== undefined;
  const filters = hasWindowFilter
    ? {
        type: args.filter?.type as string | undefined,
        sinceSequence: args.filter?.sinceSequence as number | undefined,
        since: args.filter?.since as string | undefined,
        until: args.filter?.until as string | undefined,
      }
    : undefined;

  try {
    const matching = await store.query(args.stream, filters);
    const total = matching.length;

    // Newest-first, stable: `sequence` is unique + monotonic per stream, so the
    // ascending set reversed is a total, deterministic descending order.
    const newestFirst = matching.slice().reverse();

    // Default to the 20 newest when no explicit limit; explicit `limit`/`offset`
    // page deterministically through the same descending order (no gaps, no
    // duplicates). `offset` counts from the newest event.
    const limit = args.limit ?? EVENT_QUERY_DEFAULT_LIMIT;
    const offset = args.offset ?? 0;
    const windowed = newestFirst.slice(offset, offset + limit);

    const page: EventQueryPage = {
      total,
      offset,
      limit,
      hasMore: offset + windowed.length < total,
    };

    // Apply field projection if requested — over the windowed page only.
    let events: unknown[] = windowed;
    if (args.fields && args.fields.length > 0) {
      const safeFields = args.fields.filter(
        (field) => !['__proto__', 'constructor', 'prototype'].includes(field),
      );
      events = windowed.map((event) =>
        pickFields(event as unknown as Record<string, unknown>, safeFields),
      );
    }

    return { success: true, data: { events, page } };
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

