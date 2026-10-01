/**
 * The single authority for event-data validation.
 *
 * `exarchos_event.append` and `exarchos_event.batch_append` both call
 * `validateEventData`, so the two write paths accept the same payloads. The store
 * is authoritative and nothing downstream validates the data again.
 */
import type { z } from 'zod';
import { EVENT_DATA_SCHEMAS, type EventType } from './schemas.js';

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
