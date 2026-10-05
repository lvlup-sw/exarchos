/**
 * Asserts the canonical envelope on a batch of workflow events.
 *
 * Each event must have a non-empty `correlationId` and a non-empty `source`.
 * If `EVENT_DATA_SCHEMAS` has a schema for the event type, the event `data` must parse.
 * The envelope tests for cancel, the HSM transition guard, rehydrate and tools use this helper.
 */

import { expect } from 'vitest';
import type { WorkflowEvent } from '../../events/schemas.js';
import { EVENT_DATA_SCHEMAS } from '../../events/schemas.js';

export interface AssertEnvelopeOptions {
  /**
   * Event types that skip the data-schema check.
   * Use it when a fixture sends partial data on purpose, for example compensation events.
   */
  skipDataSchema?: ReadonlyArray<string>;
}

export function assertCanonicalEnvelope(
  events: ReadonlyArray<WorkflowEvent>,
  opts: AssertEnvelopeOptions = {},
): void {
  const skipDataSchema = new Set(opts.skipDataSchema ?? []);

  for (const event of events) {
    const label = `${event.type}#${event.sequence}`;

    expect(event.correlationId, `${label}: correlationId must be non-empty`).toBeDefined();
    expect(
      typeof event.correlationId === 'string' && event.correlationId.length > 0,
      `${label}: correlationId must be a non-empty string (got ${JSON.stringify(event.correlationId)})`,
    ).toBe(true);

    expect(event.source, `${label}: source must be non-empty`).toBeDefined();
    expect(
      typeof event.source === 'string' && event.source.length > 0,
      `${label}: source must be a non-empty string (got ${JSON.stringify(event.source)})`,
    ).toBe(true);

    if (skipDataSchema.has(event.type)) continue;
    const dataSchema = EVENT_DATA_SCHEMAS[event.type as keyof typeof EVENT_DATA_SCHEMAS];
    if (dataSchema && event.data !== undefined) {
      const parsed = dataSchema.safeParse(event.data);
      expect(
        parsed.success,
        `${label}: data must satisfy EVENT_DATA_SCHEMAS — ${
          parsed.success ? '' : JSON.stringify(parsed.error.issues)
        }`,
      ).toBe(true);
    }
  }
}
