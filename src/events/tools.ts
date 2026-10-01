import { z, ZodError } from 'zod';
import { EventStore, SequenceConflictError } from './store.js';
import { EVENT_DATA_SCHEMAS, type EventType, WorkflowEventBase } from './schemas.js';
import { pickFields, toEventAck, type EventAck, type ToolResult } from '../format.js';
import { buildValidatedEvent } from './event-factory.js';
import {
  BATCH_VALIDATION_ATOMICITY,
  resolveBatchEvents,
  validateEventData,
} from './event-validation.js';
import { randomUUID, createHash } from 'node:crypto';
import { getDispatchContext } from '../dispatch/dispatch-context.js';
import { getReservedEventAppendRegistration } from '../registry.js';

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

type ReservedEventError = ToolResult & {
  readonly error: NonNullable<ToolResult['error']> & {
    readonly eventType: string;
    readonly registeredHandler?: string;
    readonly batchIndex?: number;
  };
};

function reservedEventAppendError(
  eventType: string,
  batchIndex?: number,
): ReservedEventError | undefined {
  const registration = getReservedEventAppendRegistration(eventType);
  if (registration === undefined) return undefined;

  const handlerGuidance = registration.typedHandler === undefined
    ? 'No typed action is registered in this release; replay it only through internal projection loading.'
    : `Use the registered typed handler "${registration.typedHandler}" instead.`;
  return {
    success: false,
    error: {
      code: 'RESERVED_EVENT_TYPE',
      message: `Event type "${eventType}" is a reserved admission fact and cannot be created through generic event append. ${handlerGuidance}`,
      eventType,
      ...(registration.typedHandler !== undefined
        ? { registeredHandler: registration.typedHandler }
        : {}),
      ...(batchIndex !== undefined ? { batchIndex } : {}),
    },
  };
}

/**
 * Handles the event_append tool: validates the input, appends one event, and returns an EventAck.
 *
 * For `team.disbanded` with a `teamId`, the handler counts `task.completed` events for that team
 * across the feature stream and its subagent streams. It replaces the `tasksCompleted` value of
 * the caller with this count, because agents often miscount. The query runs before the append, so
 * the count covers every child of the team. Without a `teamId`, the event takes the normal path.
 * The sequence `1` is a placeholder that `appendValidated` replaces.
 */
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

  const reservedError = reservedEventAppendError(eventType);
  if (reservedError !== undefined) return reservedError;

  const store = eventStore;

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

  if (eventType === 'team.disbanded') {
    const data = (args.event.data ?? {}) as Record<string, unknown>;
    const teamId = data.teamId as string | undefined;
    if (typeof teamId === 'string' && teamId.length > 0) {
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

      try {
        const validatedEvent = buildValidatedEvent(args.stream, 1, {
          type: eventType,
          data: persistedData,
          ...(args.event.correlationId !== undefined ? { correlationId: args.event.correlationId as string } : {}),
          ...(args.event.causationId !== undefined ? { causationId: args.event.causationId as string } : {}),
          ...(args.event.agentId !== undefined ? { agentId: args.event.agentId as string } : {}),
          ...(args.event.agentRole !== undefined ? { agentRole: args.event.agentRole as string } : {}),
          ...(args.event.tenantId !== undefined ? { tenantId: args.event.tenantId as string } : {}),
          ...(args.event.organizationId !== undefined ? { organizationId: args.event.organizationId as string } : {}),
          ...(args.event.source !== undefined ? { source: args.event.source as string } : {}),
          ...(args.event.timestamp !== undefined ? { timestamp: args.event.timestamp as string } : {}),
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
  }

  try {
    const validatedEvent = buildValidatedEvent(args.stream, 1, {
      type: eventType,
      ...(args.event.data !== undefined ? { data: args.event.data as Record<string, unknown> } : {}),
      ...(args.event.correlationId !== undefined ? { correlationId: args.event.correlationId as string } : {}),
      ...(args.event.causationId !== undefined ? { causationId: args.event.causationId as string } : {}),
      ...(args.event.agentId !== undefined ? { agentId: args.event.agentId as string } : {}),
      ...(args.event.agentRole !== undefined ? { agentRole: args.event.agentRole as string } : {}),
      ...(args.event.tenantId !== undefined ? { tenantId: args.event.tenantId as string } : {}),
      ...(args.event.organizationId !== undefined ? { organizationId: args.event.organizationId as string } : {}),
      ...(args.event.source !== undefined ? { source: args.event.source as string } : {}),
      ...(args.event.timestamp !== undefined ? { timestamp: args.event.timestamp as string } : {}),
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

/**
 * Handles the event batch_append tool: validates every event first, appends them atomically, and
 * returns an EventAck for each.
 *
 * `resolveBatchEvents` removes duplicates by `idempotencyKey`, and the first occurrence wins.
 * All checks run over these survivors, and each error names the index of the caller. The first
 * invalid event rejects the whole batch. `validateEventData` is the same data check that `append`
 * uses.
 *
 * When all events share one `idempotencyKey`, it is the batch key, so a retry gets the cached
 * events. Otherwise the batch key is a fresh UUID. On a cache hit, each ack takes the type of the
 * persisted event, because the cached batch can differ from this request.
 */
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

  const resolution = resolveBatchEvents(args.events);
  if (!resolution.ok) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          resolution.reason === 'empty-input'
            ? 'events array must be non-empty'
            : resolution.reason === 'malformed-element'
              ? `events[${resolution.index}] must be an object`
              : 'batch resolved to zero appendable events after intra-batch deduplication',
      },
    };
  }

  for (const { event, index: i } of resolution.events) {
    const eventType = event.type as EventType | undefined;
    if (!eventType) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `events[${i}].type is required` },
      };
    }

    const reservedError = reservedEventAppendError(eventType, i);
    if (reservedError !== undefined) return reservedError;

    const misplaced = detectMisplacedFields(event);
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

  const dedupedEvents = resolution.events.map((r) => r.event);

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
  const validatedEvents: ValidatedEvent[] = [];
  for (const { event, index } of resolution.events) {
    try {
      const parsed = WorkflowEventBase.parse({
        ...event,
        streamId: args.stream,
        sequence: 1,
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
      const eventType = parsed.type as EventType;
      validateEventData(eventType, parsed.data);

      const out: ValidatedEvent = { type: eventType };
      if (parsed.data !== undefined) out.data = parsed.data;
      if (parsed.correlationId !== undefined) out.correlationId = parsed.correlationId;
      if (parsed.causationId !== undefined) out.causationId = parsed.causationId;
      if (parsed.agentId !== undefined) out.agentId = parsed.agentId;
      if (parsed.agentRole !== undefined) out.agentRole = parsed.agentRole;
      if (parsed.tenantId !== undefined) out.tenantId = parsed.tenantId;
      if (parsed.organizationId !== undefined) out.organizationId = parsed.organizationId;
      if (parsed.source !== undefined) out.source = parsed.source;
      if (parsed.timestamp !== undefined) out.timestamp = parsed.timestamp;
      validatedEvents.push(out);
    } catch (err) {
      if (err instanceof ZodError) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Batch validation failed at events[${index}] (atomicity: ${BATCH_VALIDATION_ATOMICITY} — no event in this batch was appended): ${err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
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
  }

  if (validatedEvents.length === 0) {
    return {
      success: false,
      error: {
        code: 'BATCH_APPEND_FAILED',
        message: 'batch validation produced zero events from a non-empty resolution',
      },
    };
  }

  const perEventKeys = dedupedEvents
    .map((e) => e.idempotencyKey as string | undefined)
    .filter((k): k is string => typeof k === 'string');
  let batchIdempotencyKey: string;
  const firstKey = perEventKeys[0];
  if (perEventKeys.length === dedupedEvents.length && perEventKeys.length > 0 && firstKey !== undefined) {
    const allSame = perEventKeys.every((k) => k === firstKey);
    batchIdempotencyKey = allSame ? firstKey : `batch:${randomUUID()}`;
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

  const acks: EventAck[] = result.kind === 'cache-hit'
    ? result.persistedEvents.map((e, i) =>
        toEventAck({
          streamId: args.stream,
          sequence: result.sequences[i]!,
          type: e.type,
        }),
      )
    : result.sequences.map((sequence, i) =>
        toEventAck({
          streamId: args.stream,
          sequence,
          type: validatedEvents[i]!.type,
        }),
      );
  return { success: true, data: acks };
}

export const AdmissionDisagreementDispositionActionSchema = z
  .object({
    stream: z.string().min(1),
    dispositionId: z.string().min(1).max(256),
    shadowAttemptId: z.string().min(1).max(256),
    disposition: z.enum([
      'explained-legacy',
      'explained-admission',
      'accepted-risk',
      'unexplained',
    ]),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type AdmissionDisagreementDispositionAction = z.infer<
  typeof AdmissionDisagreementDispositionActionSchema
>;

/** The claim-key namespace for typed disposition appends. */
const ADMISSION_DISPOSITION_KEY_PREFIX = 'admission.disagreement-disposition:';

/**
 * The maximum length of `WorkflowEventBase.idempotencyKey`. A `dispositionId` can hold 256
 * characters, so the key derivation must shrink a long id without ambiguity.
 */
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * The claim key for one disagreement disposition. `dispositionId` is the natural identity of the
 * fact, so the key is a pure function of that id. A retried append computes the same key and finds
 * the stored row. An id that exceeds the length limit folds to a sha256 digest, which keeps
 * distinct ids distinct. A disposition causes no external effect, so the claim key alone makes a
 * retry safe.
 */
export function admissionDispositionIdempotencyKey(dispositionId: string): string {
  const natural = `${ADMISSION_DISPOSITION_KEY_PREFIX}${dispositionId}`;
  if (natural.length <= IDEMPOTENCY_KEY_MAX_LENGTH) return natural;
  const digest = createHash('sha256').update(dispositionId, 'utf8').digest('hex');
  return `${ADMISSION_DISPOSITION_KEY_PREFIX}sha256:${digest}`;
}

/** The identifying fields a replay must reproduce byte-for-byte. */
const DISPOSITION_CLAIM_FIELDS = [
  'dispositionId',
  'shadowAttemptId',
  'disposition',
  'rationale',
] as const;

/**
 * Refuse a replay that has the same `dispositionId` but a different payload. The store returns the
 * stored row for it, and a success envelope then misreports which rationale was recorded.
 */
function dispositionReplayConflict(
  requested: Omit<AdmissionDisagreementDispositionAction, 'stream'>,
  persisted: { readonly data?: Record<string, unknown> | undefined },
): ToolResult | undefined {
  const stored = (persisted.data ?? {}) as Partial<
    Record<(typeof DISPOSITION_CLAIM_FIELDS)[number], unknown>
  >;
  const divergent = DISPOSITION_CLAIM_FIELDS.filter(
    (field) => stored[field] !== requested[field],
  );
  if (divergent.length === 0) return undefined;

  return {
    success: false,
    error: {
      code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
      message:
        `Disposition "${requested.dispositionId}" was already recorded with a ` +
        `different payload (${divergent.join(', ')}); a silently-different ` +
        'second write is refused. Mint a new dispositionId to record a new fact.',
      action: 'handleAdmissionDisagreementDisposition',
    },
  };
}

/**
 * The typed writer for disagreement dispositions. The strict input schema rejects issuer, role,
 * posture, operation ID and timestamps. The handler derives each trusted value from the active
 * DispatchContext. A retry of the same disposition returns the stored row and appends no second
 * fact.
 */
export async function handleAdmissionDisagreementDisposition(
  untrustedArgs: unknown,
  eventStore: EventStore,
): Promise<ToolResult> {
  const parsed = AdmissionDisagreementDispositionActionSchema.safeParse(
    untrustedArgs,
  );
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `handleAdmissionDisagreementDisposition: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ')}`,
      },
    };
  }

  const dispatchContext = getDispatchContext();
  const authorization = dispatchContext?.authorization;
  if (
    dispatchContext === undefined ||
    authorization === undefined ||
    authorization.posture === 'read-only'
  ) {
    return {
      success: false,
      error: {
        code: 'CAPABILITY_DENIED',
        message:
          'handleAdmissionDisagreementDisposition requires resolver-authorized mutating posture.',
        action: 'handleAdmissionDisagreementDisposition',
      },
    };
  }

  const { stream, ...fact } = parsed.data;
  const recordedAt = authorization.resolvedAt;
  try {
    const validatedEvent = buildValidatedEvent(stream, 1, {
      type: 'admission.disagreement-disposition',
      timestamp: recordedAt,
      data: {
        eventVersion: '1.0',
        ...fact,
        recordedAt,
        caller: {
          principalKind:
            authorization.identity.role === 'operator' ? 'operator' : 'agent',
          principalId: authorization.identity.subjectId,
          role: authorization.identity.role,
        },
        authorization: {
          authorizationId: `${authorization.policy.id}:${dispatchContext.operationId}`,
          posture: authorization.posture,
          capabilityIds: [...authorization.capabilities],
          resolverVersion: authorization.resolver.version,
          resolvedAt: authorization.resolvedAt,
        },
      },
    });
    const event = await eventStore.appendValidated(stream, validatedEvent, {
      idempotencyKey: admissionDispositionIdempotencyKey(fact.dispositionId),
    });
    const conflict = dispositionReplayConflict(fact, event);
    if (conflict !== undefined) return conflict;
    return { success: true, data: toEventAck(event) };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'APPEND_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * The default page size for `event query`. Without an explicit `limit`, the handler returns the 20
 * newest events and `page` metadata, not the full stream. An explicit `limit` and `offset` reach
 * the full history.
 */
export const EVENT_QUERY_DEFAULT_LIMIT = 20;

/** Paging metadata returned with `event query` results. */
export interface EventQueryPage {
  /** Total events matching the window filters, before limit/offset. */
  readonly total: number;
  /** Zero-based offset into the newest-first ordering this page starts at. */
  readonly offset: number;
  /** Effective page size — the explicit `limit`, else {@link EVENT_QUERY_DEFAULT_LIMIT}. */
  readonly limit: number;
  /** True when events outside this page remain: `offset + shown < total`. */
  readonly hasMore: boolean;
}

/**
 * Handles the event_query tool: validates the input, then queries events with optional filters
 * and pagination.
 *
 * The store applies the window filters. The handler applies `limit` and `offset` over a
 * newest-first order, because `page.total` needs the full matching set. The handler ignores an
 * empty `operationId`, because as a filter it matches nothing. The `operationId` key is absent
 * when no valid value exists, because `exactOptionalPropertyTypes` forbids an `undefined` value.
 * Field projection applies only to the page.
 */
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

  const rawOperationId = args.filter?.operationId;
  const operationId =
    typeof rawOperationId === 'string' && rawOperationId.length > 0 ? rawOperationId : undefined;
  const hasWindowFilter =
    args.filter?.type !== undefined ||
    args.filter?.sinceSequence !== undefined ||
    args.filter?.since !== undefined ||
    args.filter?.until !== undefined ||
    operationId !== undefined;
  const filters = hasWindowFilter
    ? {
        type: args.filter?.type as string | undefined,
        sinceSequence: args.filter?.sinceSequence as number | undefined,
        since: args.filter?.since as string | undefined,
        until: args.filter?.until as string | undefined,
        ...(operationId !== undefined ? { operationId } : {}),
      }
    : undefined;

  try {
    const matching = await store.query(args.stream, filters);
    const total = matching.length;

    const newestFirst = matching.slice().reverse();

    const limit = args.limit ?? EVENT_QUERY_DEFAULT_LIMIT;
    const offset = args.offset ?? 0;
    const windowed = newestFirst.slice(offset, offset + limit);

    const page: EventQueryPage = {
      total,
      offset,
      limit,
      hasMore: offset + windowed.length < total,
    };

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
