import type { z } from 'zod';
import { EVENT_DATA_SCHEMAS, type EventType } from './schemas.js';

/**
 * DR-1 — the single authority for event-data validation.
 *
 * Both write paths (`exarchos_event.append` and `exarchos_event.batch_append`)
 * route their per-type data check through `validateEventData`. Before this
 * module existed the check lived inline in `buildValidatedEvent`, so only
 * `append` performed it; `batch_append` validated the envelope and stopped
 * there. A `task.completed` carrying a string `evidence` was rejected through
 * one door and accepted through the other, and six such events are permanently
 * on the `internal-mechanics-overhaul` stream (sequences 152-157) because the
 * store is authoritative and nothing downstream re-validates.
 *
 * Two agreeing copies would be the same defect waiting to recur. There is one
 * copy, and both callers import it.
 */

/** The per-type data schemas keyed by event type. Mutable at runtime: `registerEventType` adds entries. */
export type EventDataSchemaRegistry = Partial<Record<EventType, z.ZodSchema>>;

/**
 * Raised when the schema registry resolves zero schemas.
 *
 * A validator with an empty registry waves every payload through while
 * reporting success — the vacuous-pass shape this program exists to detect.
 * It is a wiring failure, not a valid state, so it fails loudly.
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
 * Batch atomicity, stated rather than inherited.
 *
 * One invalid event rejects the WHOLE batch. The alternative — appending the
 * valid subset — trades a silent bad write for a silent partial write: the
 * caller gets a success envelope whose acks no longer line up with the events
 * it submitted, and it has no way to learn which ones were dropped. Rejecting
 * wholesale is also what the batch path already does for every other class of
 * invalid event (unknown type, misplaced field, reserved type), and what the
 * underlying atomic appender does for its own sequence allocation.
 *
 * (The appender's class name is deliberately not spelled here: an acceptance
 * census greps production files for that literal to enumerate its consumers,
 * and this module is not one.)
 */
export const BATCH_VALIDATION_ATOMICITY = 'all-or-nothing';

/**
 * Validate one event's `data` against the schema registered for its type.
 *
 * Throws `ZodError` on a schema violation and `EmptySchemaRegistryError` when
 * the registry is empty. Event types with no registered schema pass (the
 * registry is deliberately partial — not every type constrains its data), and
 * so does an absent `data`; the registry-emptiness check runs first either way
 * so a mis-wired validator cannot look like a clean pass.
 *
 * The parse result is deliberately discarded: this is a check, not a
 * normalization step. Persisting the parsed value instead of the caller's
 * would silently strip unknown keys out of already-stored shapes.
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

export type BatchResolution =
  | { readonly ok: true; readonly events: readonly ResolvedBatchEvent[] }
  | { readonly ok: false; readonly reason: 'empty-input' | 'empty-after-dedup' }
  /** A non-object element — reported by position, never deduplicated. */
  | { readonly ok: false; readonly reason: 'malformed-element'; readonly index: number };

/**
 * Resolve the events a batch will actually append: drop intra-batch duplicates
 * (same per-event `idempotencyKey`, first occurrence wins) and carry each
 * survivor's original index.
 *
 * A batch resolving to zero events fails rather than returning a clean empty
 * success. An empty result means the caller's intent produced no write at all,
 * which is indistinguishable from a silent drop at the ack layer.
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
    // A `null` or non-object element is MALFORMED, not deduplicable. The
    // declared type says `Record<string, unknown>`, but this runs on MCP input:
    // `events: [null]` reached `null.idempotencyKey` and threw, so the handler
    // could never return its own INVALID_INPUT envelope. Reported by position
    // and fails the batch, which is what all-or-nothing atomicity already says
    // about any other invalid element.
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
