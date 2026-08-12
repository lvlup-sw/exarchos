// ─── #1274 — Dispatch missing-required-param elicitation hand-off ────────────
//
// When the dispatch boundary detects a missing required parameter on a
// payload, AND the client has declared the MCP `elicitation` capability,
// dispatch routes the missing-param branch through this module instead of
// returning INVALID_INPUT outright. The hand-off:
//
//   1. Derives a JSON Schema fragment for ONLY the missing field via
//      `capabilities/elicitation.ts → deriveElicitationSchema`.
//   2. Emits `elicitation.requested` (operationId, field, schema) on the
//      per-operation pseudo-stream `elicitation/<operationId>` so audit
//      queries can correlate request/response.
//   3. Calls the transport's `elicitation/create` method via the injected
//      {@link ElicitationClient} adapter (thin wrapper in
//      `mcp/elicitation-method.ts`).
//   4. Emits `elicitation.fulfilled` (operationId, field, value).
//   5. Returns the elicited value so dispatch can retry the action with
//      the now-complete payload.
//
// Resolution priority is documented in `dispatch/core/dispatch.ts`:
// explicit > roots > cwd > elicitation > INVALID_INPUT.

import type { z } from 'zod';
import type { EventStore } from '../events/store.js';
import { deriveElicitationSchema } from '../capabilities/elicitation.js';

/**
 * Minimal `elicitation/create` surface consumed by {@link performElicitation}.
 * The MCP SDK's full `ElicitRequestFormParamsSchema` carries more fields
 * (message, mode, _meta, task ttl, etc.); we accept only the load-bearing
 * subset so callers can swap in a thin transport adapter or a test fixture
 * without dragging the SDK type graph into dispatch.
 *
 * The adapter is responsible for shaping the wire-level form-mode params
 * (mode: 'form', message, requestedSchema) and translating the client's
 * ElicitResult back into a `{value}` shape — keeping that translation
 * outside this module keeps the dispatch helper transport-agnostic and
 * testable without a live MCP transport.
 */
export interface ElicitationClient {
  create(input: {
    readonly field: string;
    readonly schema: Record<string, unknown>;
  }): Promise<{ readonly value: unknown }>;
}

/**
 * Result of a single elicitation round-trip. `fulfilled: false` indicates
 * the client declined or returned no value — dispatch should fall back to
 * the legacy INVALID_INPUT contract rather than retrying.
 */
export interface ElicitationResult {
  readonly fulfilled: boolean;
  readonly value: unknown;
}

export interface PerformElicitationOpts {
  /** Zod schema for the full action input — used to pick the missing field. */
  readonly inputSchema: z.ZodObject;
  /** The field name that triggered the missing-param branch. */
  readonly missingField: string;
  /** Transport adapter for `elicitation/create`. */
  readonly client: ElicitationClient;
  /** Event store used to record `elicitation.{requested,fulfilled}`. */
  readonly eventStore: EventStore;
  /**
   * Operation correlation id — same value lands in both `requested` and
   * `fulfilled` events so audit queries can pair the round-trip.
   */
  readonly operationId: string;
}

/**
 * Perform the elicitation hand-off and return the elicited value.
 *
 * Emits `elicitation.requested` BEFORE the round-trip fires (durable
 * intent; mirrors the Wave B two-event-split contract for non-idempotent
 * side effects) and `elicitation.fulfilled` AFTER the client responds.
 * Both events land on the per-operation pseudo-stream
 * `elicitation/<operationId>`.
 *
 * Callers (notably `dispatch/core/dispatch.ts`) are responsible for re-running the
 * Zod validation pass after splicing the elicited value back into the
 * payload — this helper produces the value; it does not retry the action.
 */
export async function performElicitation(
  opts: PerformElicitationOpts,
): Promise<ElicitationResult> {
  const { inputSchema, missingField, client, eventStore, operationId } = opts;
  const streamId = `elicitation/${operationId}`;
  const schema = deriveElicitationSchema(inputSchema, missingField) as Record<
    string,
    unknown
  >;

  // (1) Durable intent: emit BEFORE the side effect. If the transport
  // round-trip fails after this point, the audit trail still records the
  // server's intent to elicit, matching the Wave B two-event-split
  // contract for non-idempotent operations.
  await eventStore.append(streamId, {
    type: 'elicitation.requested',
    data: { operationId, field: missingField, schema },
  });

  // (2) Round-trip to the client. The adapter is responsible for the
  // wire-level form-mode params (mode: 'form', message, requestedSchema).
  const response = await client.create({ field: missingField, schema });

  // (3) Audit-trail: pair the request with its response. Sentry MEDIUM
  // #1424 root cause: the pre-fix branch emitted `elicitation.fulfilled`
  // for declines too, so downstream audit consumers couldn't tell apart
  // "the client supplied a value" from "the client refused / cancelled."
  // Emit `elicitation.declined` for the decline path so the round-trip
  // outcome is observable as a typed event rather than a value-shape
  // discriminator on a single overloaded event type.
  if (response.value !== undefined) {
    await eventStore.append(streamId, {
      type: 'elicitation.fulfilled',
      data: { operationId, field: missingField, value: response.value },
    });
  } else {
    await eventStore.append(streamId, {
      type: 'elicitation.declined',
      data: { operationId, field: missingField },
    });
  }

  return {
    fulfilled: response.value !== undefined,
    value: response.value,
  };
}
