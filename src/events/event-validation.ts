/**
 * Event-data validation keeps historical type-only contracts separate from versioned row contracts.
 * Generic writers also enforce caller admission before they discard raw envelope metadata.
 */
import { z } from 'zod';
import { WorkflowTypeSchema } from '../workflow/schemas.js';
import { EVENT_DATA_SCHEMAS, WorkflowStartedData, WorkflowStartedV11Data, WORKFLOW_STARTED_SCHEMA_VERSION, type EventType } from './schemas.js';

/** The per-type data schemas keyed by event type. Mutable at runtime: `registerEventType` adds entries. */
export type EventDataSchemaRegistry = Partial<Record<EventType, z.ZodSchema>>;

/**
 * Thrown when the schema registry resolves zero schemas. An empty registry
 * passes every payload, so it is a wiring failure and not a valid state.
 */
export class EmptySchemaRegistryError extends Error {
  constructor(eventType: string) {
    super(
      `Event-data schema registry resolved zero schemas while validating '${eventType}'. ` +
        'An empty registry cannot validate anything; this is a wiring failure, not a clean pass.',
    );
    this.name = 'EmptySchemaRegistryError';
  }
}

/**
 * One invalid event rejects the whole batch. A partial append returns acks that
 * do not match the submitted events, and the caller cannot learn which events dropped.
 *
 * This text does not name the appender class. An acceptance census greps
 * production files for that name to find its consumers, and this module is not one.
 */
export const BATCH_VALIDATION_ATOMICITY = 'all-or-nothing';

/**
 * Validate one event's `data` against the schema registered for its type.
 *
 * Throws `ZodError` on a schema violation and `EmptySchemaRegistryError` when the
 * registry is empty. The emptiness check runs first. An event type with no
 * schema passes, and an absent `data` passes.
 *
 * The function discards the parse result, because a persisted parse result loses unknown keys.
 */
export function validateEventData(
  eventType: EventType,
  data: unknown,
  registry: EventDataSchemaRegistry = EVENT_DATA_SCHEMAS,
): void {
  if (Object.keys(registry).length === 0) {
    throw new EmptySchemaRegistryError(eventType);
  }
  if (data === undefined) return;

  const dataSchema = registry[eventType];
  if (dataSchema === undefined) return;

  dataSchema.parse(data);
}

/** Row context selects the complete versioned start contract. */
export interface EventRowData {
  readonly type: string;
  readonly schemaVersion?: unknown;
  readonly data?: unknown;
}

/** Legacy extras have no phase authority and do not need parsing. */
export function recordedInitialPhaseOf(row: EventRowData): string | undefined {
  if (row.type !== 'workflow.started' || row.schemaVersion !== WORKFLOW_STARTED_SCHEMA_VERSION) return undefined;
  return WorkflowStartedV11Data.parse(row.data).initialPhase;
}

/** Validate a row without changing the legacy data-only registry contract. */
export function validateEventRowData(row: EventRowData, registry: EventDataSchemaRegistry = EVENT_DATA_SCHEMAS): void {
  if (row.type === 'workflow.started' && row.schemaVersion === WORKFLOW_STARTED_SCHEMA_VERSION) {
    WorkflowStartedV11Data.parse(row.data);
    return;
  }
  validateEventData(row.type as EventType, row.data, registry);
}

const GenericStartedData = WorkflowStartedData.extend({ workflowType: WorkflowTypeSchema });

/** Inspect raw generic input before handlers discard caller versions. Trusted writers use row validation directly. */
export function validateGenericEventAdmission(row: EventRowData): void {
  if (row.type !== 'workflow.started') return;
  if (row.schemaVersion === WORKFLOW_STARTED_SCHEMA_VERSION ||
      (row.data !== null && typeof row.data === 'object' && Object.hasOwn(row.data, 'initialPhase'))) {
    throw new z.ZodError([{ code: 'custom', path: ['data', 'initialPhase'], message: 'Generic starts cannot supply a recorded initial phase or its epoch' }]);
  }
  if (row.data !== undefined) GenericStartedData.parse(row.data);
}

/** One event of a batch, paired with its position in the caller's array. */
export interface ResolvedBatchEvent {
  readonly event: Record<string, unknown>;
  /** Index in the caller's `events` array — survives dedup so errors can name the right position. */
  readonly index: number;
}

/** The events a batch appends, or why it fails. A `malformed-element` failure names the position of a non-object element. */
export type BatchResolution =
  | { readonly ok: true; readonly events: readonly ResolvedBatchEvent[] }
  | { readonly ok: false; readonly reason: 'empty-input' | 'empty-after-dedup' }
  | { readonly ok: false; readonly reason: 'malformed-element'; readonly index: number };

/**
 * Resolve the events that a batch appends. Drop duplicates of the same
 * `idempotencyKey`, keep the first occurrence, and carry each original index.
 *
 * A batch with zero events fails, because an empty success looks like a silent
 * drop at the ack layer. A `null` or non-object element fails the batch, because
 * this function runs on untrusted MCP input.
 */
export function resolveBatchEvents(
  events: ReadonlyArray<Record<string, unknown>> | undefined,
): BatchResolution {
  if (events === undefined || events.length === 0) {
    return { ok: false, reason: 'empty-input' };
  }

  const seenKeys = new Set<string>();
  const resolved: ResolvedBatchEvent[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event === undefined || event === null || typeof event !== 'object') {
      return { ok: false, reason: 'malformed-element', index };
    }
    const key = event.idempotencyKey;
    if (typeof key === 'string') {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    resolved.push({ event, index });
  }

  if (resolved.length === 0) {
    return { ok: false, reason: 'empty-after-dedup' };
  }
  return { ok: true, events: resolved };
}
