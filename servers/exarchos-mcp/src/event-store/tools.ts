import { z, ZodError } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventStore, SequenceConflictError } from './store.js';
import { EVENT_DATA_SCHEMAS, type EventType, WorkflowEventBase } from './schemas.js';
import { pickFields, toEventAck, type EventAck, type ToolResult } from '../format.js';
import { buildValidatedEvent } from './event-factory.js';
import { randomUUID } from 'node:crypto';

/**
 * Find the highest-sequence `team.disbanded` event for a given team in the
 * parent stream's JSONL. Used by the C11 router-interception path to fabricate
 * an EventAck after `SubagentStreamRouter.emitDisbanded` (which has a void
 * return type) writes the corrected event. Returns -1 when the file can't be
 * read; the caller maps that to `sequencePending` via `toSafeEventAck`.
 */
async function readLatestDisbandedSequence(
  stateDir: string,
  streamId: string,
  teamId: string,
): Promise<number> {
  const filePath = path.join(stateDir, `${streamId}.events.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return -1;
  }
  let maxSeq = -1;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: { type?: string; sequence?: number; data?: { teamId?: string } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (
      parsed.type === 'team.disbanded'
      && parsed.data?.teamId === teamId
      && typeof parsed.sequence === 'number'
      && parsed.sequence > maxSeq
    ) {
      maxSeq = parsed.sequence;
    }
  }
  return maxSeq;
}

/**
 * Build an EventAck from a stored event. When the event has a non-positive
 * sequence (sidecar write pending merge), the ack uses sequence -1 and sets
 * `sequencePending: true` so callers do not misinterpret 0 as failure.
 */
function toSafeEventAck(event: { streamId: string; sequence: number; type: string }): EventAck {
  const ack = toEventAck(event);
  if (ack.sequence <= 0) {
    return { ...ack, sequence: -1, sequencePending: true };
  }
  return ack;
}

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

  // ─── C11: SubagentStreamRouter interception for team.disbanded (#1224) ───
  //
  // Agents bookkeep `tasksCompleted` in memory and frequently get the count
  // wrong (the #1224 off-by-N regression). The router queries the parent
  // stream for the actual `task.completed` count scoped to `teamId` — server
  // side enforcement at the boundary. Sidecar mode skips the router because
  // the router's JSONL scan won't see writes that haven't been merged from
  // the sidecar yet; the legacy path still preserves order.
  if (eventType === 'team.disbanded' && !store.inSidecarMode) {
    const data = (args.event.data ?? {}) as Record<string, unknown>;
    const teamId = data.teamId as string | undefined;
    if (typeof teamId === 'string' && teamId.length > 0) {
      // Construct DisbandedSummary — explicitly DROP `tasksCompleted` even if
      // the caller supplied one. The router computes the authoritative value.
      // Pass through every other field; the router persists them verbatim.
      const summary: Record<string, unknown> = { teamId };
      for (const [key, value] of Object.entries(data)) {
        if (key === 'tasksCompleted' || key === 'teamId') continue;
        summary[key] = value;
      }
      // Required by the schema and the router's DisbandedSummary contract.
      if (typeof summary.totalDurationMs !== 'number') {
        summary.totalDurationMs = 0;
      }
      if (typeof summary.tasksFailed !== 'number') {
        summary.tasksFailed = 0;
      }

      try {
        const router = store.getStreamRouter();
        await router.emitDisbanded(args.stream, summary as {
          teamId: string;
          totalDurationMs: number;
          tasksFailed: number;
          [k: string]: unknown;
        });
        // Recover the allocated sequence from the JSONL — the router's
        // void return type doesn't surface it, and AtomicAppender's per-
        // stream lock guarantees the most recent `team.disbanded` for this
        // teamId is the one we just wrote. Falls back to -1/sequencePending
        // when the file isn't readable for any reason; callers already
        // tolerate that shape via `toSafeEventAck`.
        const sequence = await readLatestDisbandedSequence(
          stateDir,
          args.stream,
          teamId,
        );
        return {
          success: true,
          data: toSafeEventAck({
            streamId: args.stream,
            sequence,
            type: eventType,
          }),
        };
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'APPEND_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }
    // Fall through to the legacy path when teamId is missing — the router
    // can't scope its query without it, and the schema-level validation
    // below will produce the right error message.
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

    return { success: true, data: toSafeEventAck(event) };
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

  // Sidecar mode: AtomicAppender does not model the JSONL/sidecar split, so we
  // preserve the legacy EventStore.batchAppend path when another process holds
  // the PID lock. Normal-mode batches route through AtomicAppender (C2).
  if (store.inSidecarMode) {
    return handleBatchAppendLegacy(args, store);
  }

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
  const acks: EventAck[] = result.kind === 'cache-hit'
    ? result.persistedEvents.map((e, i) => {
        const ack = toEventAck({
          streamId: args.stream,
          sequence: result.sequences[i],
          type: e.type,
        });
        return ack.sequence <= 0 ? { ...ack, sequence: -1, sequencePending: true } : ack;
      })
    : result.sequences.map((sequence, i) => {
        const ack = toEventAck({
          streamId: args.stream,
          sequence,
          type: validatedEvents[i].type,
        });
        return ack.sequence <= 0 ? { ...ack, sequence: -1, sequencePending: true } : ack;
      });
  return { success: true, data: acks };
}

/**
 * Legacy four-phase batch append path. Retained for sidecar mode where the
 * AtomicAppender's filesystem assumptions don't hold (sidecar mode routes
 * writes to a separate file with deferred sequence allocation).
 */
async function handleBatchAppendLegacy(
  args: {
    stream: string;
    events: Array<Record<string, unknown>>;
  },
  store: EventStore,
): Promise<ToolResult> {
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
      data: appended.map(toSafeEventAck),
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

