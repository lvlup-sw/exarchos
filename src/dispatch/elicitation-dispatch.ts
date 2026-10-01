/**
 * The elicitation hand-off for a missing required parameter. When the client declares the MCP
 * `elicitation` capability, dispatch calls this module and does not return `INVALID_INPUT` at once.
 *
 * The hand-off derives a JSON Schema for the missing field only, and it emits
 * `elicitation.requested`. It then calls `elicitation/create` through the injected
 * {@link ElicitationClient}, emits the outcome event, and returns the value. The events go to the
 * pseudo-stream `elicitation/<operationId>`. `dispatch/core/dispatch.ts` gives the resolution
 * order: explicit, roots, cwd, elicitation, then `INVALID_INPUT`.
 */

import type { z } from 'zod';
import type { EventStore } from '../events/store.js';
import { deriveElicitationSchema } from '../workflow/capabilities/elicitation.js';

/**
 * The minimal `elicitation/create` surface for {@link performElicitation}. It holds a subset of the
 * SDK request fields, so a thin adapter or a test fixture can implement it without the SDK types.
 *
 * The adapter builds the form-mode wire params and turns the client result into `{ value }`. This
 * keeps dispatch independent of the transport.
 */
export interface ElicitationClient {
  create(input: {
    readonly field: string;
    readonly schema: Record<string, unknown>;
  }): Promise<{ readonly value: unknown }>;
}

/**
 * The result of one elicitation round trip. `fulfilled: false` means that the client declined or
 * returned no value. Dispatch then returns `INVALID_INPUT` and does not retry.
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
 * Runs the elicitation hand-off and returns the elicited value. It emits `elicitation.requested`
 * before the round trip, so the audit trail records the intent even when the transport fails.
 * After the client responds, it emits `elicitation.fulfilled` for a value, or
 * `elicitation.declined` for no value.
 *
 * The caller puts the value into the payload and validates it again. This function does not retry
 * the action.
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

  await eventStore.append(streamId, {
    type: 'elicitation.requested',
    data: { operationId, field: missingField, schema },
  });

  const response = await client.create({ field: missingField, schema });

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
