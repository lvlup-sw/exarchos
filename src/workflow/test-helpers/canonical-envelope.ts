/**
 * Asserts the canonical envelope on a batch of workflow events.
 *
 * Each event must have a non-empty `correlationId` and a non-empty `source`.
 * If `EVENT_DATA_SCHEMAS` has a schema for the event type, the event `data` must parse.
 * The envelope tests for cancel, the HSM transition guard, rehydrate and tools use this helper.
 */

import { expect } from 'vitest';
import type { WorkflowEvent } from '../../events/schemas.js';
import { validateEventRowData } from '../../events/event-validation.js';

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
    expect(() => validateEventRowData(event), `${label}: data must satisfy the row contract`).not.toThrow();
  }
}
