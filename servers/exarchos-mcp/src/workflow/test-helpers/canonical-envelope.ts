// Shared property-style assertion for #1325 envelope tests.
//
// Asserts the canonical-envelope invariant on a batch of WorkflowEvents:
//   1. `correlationId` is a non-empty string.
//   2. `source` is a non-empty string (registered emitter identifier).
//   3. If a per-event-type data schema is registered in
//      `EVENT_DATA_SCHEMAS`, the event's `data` shape parses cleanly.
//
// Used by:
//   - cancel.envelope.test.ts                (α-07)
//   - hsm-transition-guard.envelope.test.ts  (α-09)
//   - rehydrate.envelope.test.ts             (α-11)
//   - tools.envelope.test.ts                 (α-13)
//
// History: extracted preemptively in α-07 when the cancel.envelope test
// was written, then adopted by α-09 / α-11 / α-13 verbatim. α-15
// verified all four call sites resolve to this helper (no per-test
// inlined assertion shapes remain) and tidied the header comment.

import { expect } from 'vitest';
import type { WorkflowEvent } from '../../events/schemas.js';
import { EVENT_DATA_SCHEMAS } from '../../events/schemas.js';

export interface AssertEnvelopeOptions {
  /**
   * Skip the per-event-type data-schema check for these event types. Useful
   * when a fixture intentionally exercises a partial-data path that does
   * not satisfy the registered schema (e.g. compensation events whose data
   * shape is upstream of the data-schema work).
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
