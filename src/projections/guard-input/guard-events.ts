/**
 * The map from event rows to the `_events` entries that the transition guards read.
 *
 * The module is a leaf. It imports only `mapExternalToInternalType` and the row type.
 * So the state store and the guard-input fold can both import it, and the import graph gets no cycle.
 */
import type { WorkflowEvent } from '../../events/schemas.js';
import { mapExternalToInternalType } from '../../workflow/events.js';

/**
 * Maps each row to one `_events` entry, in row order.
 * An entry holds the internal type, the timestamp, each data field at the top level and the data again as `metadata`.
 * A data field named `type` or `timestamp` replaces the envelope value.
 * An entry holds no `data` key, so a guard that reads `data` on an entry finds nothing.
 */
export function toGuardEvents(rows: readonly WorkflowEvent[]): readonly Record<string, unknown>[] {
  return rows.map((row) => ({
    type: mapExternalToInternalType(row.type),
    timestamp: row.timestamp,
    ...(row.data ?? {}),
    metadata: row.data ?? {},
  }));
}
