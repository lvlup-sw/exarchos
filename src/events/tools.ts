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

  const reservedError = reservedEventAppendError(eventType);
  if (reservedError !== undefined) return reservedError;

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
    // Fall through to the legacy path when teamId is missing — the cross-
    // stream reducer can't scope its query without it, and the schema-level
    // validation below will produce the right error message.
  }

  try {
    // Validate at the system boundary (MCP tool handler = untrusted input)
    // Sequence 1 is a placeholder — appendValidated overwrites it with the real sequence
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

  // Resolve the events this batch will actually append (intra-batch dedup by
  // per-event idempotencyKey). A batch resolving to zero events is an error,
  // not an empty success — see `resolveBatchEvents`.
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

  // Validate every event this batch will actually APPEND — the resolved
  // survivors, not the raw input.
  //
  // The two validation classes disagreed about what deduplication means. These
  // structural checks ran over `args.events`, so a discarded duplicate with a
  // misplaced field rejected the whole batch; the per-type data validation
  // below ran over the survivors, so the same discarded duplicate with an
  // invalid `data` payload did not. `resolveBatchEvents` defines first
  // occurrence wins, so the survivors are the contract and both classes now
  // read the same population. Errors still carry the CALLER's index, which is
  // what `resolved.index` is for.
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

  // v2.11 Phase 1: sidecar fallback (#1082) deleted — no JSONL/sidecar split,
  // so AtomicAppender owns the only batch path.

  // Pre-dedup within batch by per-event idempotencyKey (preserves the
  // single-key-dedup contract `batchAppend_IdempotencyKey_DeduplicatesAcrossBatch`
  // exercises), carrying each survivor's original index so validation errors
  // can name the caller's position. The appender itself dedups across calls via
  // the batch idempotencyKey we derive below.
  const dedupedEvents = resolution.events.map((r) => r.event);

  // Validate envelope AND per-type event data. DR-1: `validateEventData` is the
  // same authority `append` uses via `buildValidatedEvent`, so the two write
  // paths agree on whether a payload is valid — before this, a `task.completed`
  // with a string `evidence` was rejected by one door and accepted by the
  // other. Atomicity is `BATCH_VALIDATION_ATOMICITY` (all-or-nothing): the
  // first invalid event rejects the whole batch, matching what the misplaced-
  // field and reserved-type checks above already do. Boundary misplaced-field
  // detection already ran. The placeholder sequence/streamId fields are
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
  const validatedEvents: ValidatedEvent[] = [];
  for (const { event, index } of resolution.events) {
    try {
      const parsed = WorkflowEventBase.parse({
        ...event,
        streamId: args.stream,
        sequence: 1, // placeholder; AtomicAppender allocates the real sequence
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
      const eventType = parsed.type as EventType;
      // The shared per-type data check — the same authority `append` reaches
      // through `buildValidatedEvent`.
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

  // `resolveBatchEvents` already rejected the empty cases, so an empty
  // validated set here means the loop above silently dropped every event.
  // That would append nothing while acking success — fail instead.
  if (validatedEvents.length === 0) {
    return {
      success: false,
      error: {
        code: 'BATCH_APPEND_FAILED',
        message: 'batch validation produced zero events from a non-empty resolution',
      },
    };
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

// ─── Typed admission fact handler ────────────────────────────────────────────

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
 * Upper bound `WorkflowEventBase.idempotencyKey` places on a claim key
 * (`z.string().min(1).max(200)`). `dispositionId` alone may be 256 chars, so
 * the derivation below must be able to shrink without becoming ambiguous.
 */
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * DR-36 / INV-8 — the claim key for one disagreement disposition.
 *
 * `dispositionId` IS the natural identity of the fact: the caller minted it to
 * name this disposition, and two attempts to record the same disposition carry
 * the same id. The key is therefore a pure, total function of that id —
 * NOTHING random (no `randomUUID`), nothing wall-clock-derived — so a retried
 * append recomputes the same key and collapses onto the stored row.
 *
 * Ids that would overflow the 200-char schema bound fold to a sha256 of the
 * id, which is equally deterministic and keeps distinct ids distinct.
 *
 * INV-13 (intent-before / result-after): a disposition is a RESULT record of a
 * human/agent adjudication that has already happened. It triggers no
 * non-idempotent external effect, so there is no effect needing a preceding
 * intent event — the claim key is the whole of its retry safety.
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
 * DR-36 — the typed CONFLICT arm of the replay contract.
 *
 * A replay carrying the SAME `dispositionId` but a DIFFERENT payload is not a
 * retry, it is a second, silently-different write hiding behind an existing
 * claim. The store returns the canonical stored row for it (never a duplicate),
 * and this turns that into an explicit refusal rather than a success envelope
 * that misreports whose rationale actually landed.
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
 * The v2.12 typed writer for disagreement dispositions.
 *
 * Its public input deliberately excludes issuer, role/posture, operation ID,
 * and timestamps. The strict schema rejects attempts to supply them, while the
 * handler derives every trusted value from the active DispatchContext.
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
      // DR-36 / INV-8: the natural-identity claim key. A retry of the same
      // disposition returns the STORED row (the store's cache-hit branch)
      // instead of appending a second, indistinguishable fact.
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

  // Window filters (type/time/sequence/operationId) narrow WHICH events match
  // and are pushed to the store. Pagination (limit/offset) is applied
  // in-handler over a newest-first ordering: the store orders ascending by
  // sequence, so deriving both `page.total` and a deterministic newest-first
  // window requires the full matching set. `limit`/`offset` are therefore NOT
  // forwarded to the store.
  //
  // `operationId` is validated (non-empty string) rather than blindly cast
  // like the other window keys: an empty string would otherwise pass the
  // `!== undefined` presence check and reach the store as a filter that
  // matches nothing, silently returning zero results instead of the whole
  // stream a caller would expect from an unfiltered query.
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
        // `QueryFilters.operationId` has no explicit `| undefined` arm, so
        // under `exactOptionalPropertyTypes` the key must be OMITTED rather
        // than set to `undefined` when no valid operationId was supplied.
        ...(operationId !== undefined ? { operationId } : {}),
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
