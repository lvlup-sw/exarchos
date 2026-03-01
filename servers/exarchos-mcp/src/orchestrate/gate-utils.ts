// ─── Gate Utils ──────────────────────────────────────────────────────────────
//
// Shared utility for emitting gate.executed events across gate handlers.
// ─────────────────────────────────────────────────────────────────────────────

import type { EventStore } from '../event-store/store.js';

/**
 * Emit a gate.executed event to the event store.
 *
 * @param store - The event store to append to
 * @param streamId - The stream (feature) ID
 * @param gateName - Name of the gate (e.g. 'test-suite', 'typecheck', 'design-completeness')
 * @param layer - The workflow layer (e.g. 'CI', 'design', 'planning', 'testing', 'post-merge')
 * @param passed - Whether the gate passed
 * @param details - Optional details payload
 */
export async function emitGateEvent(
  store: EventStore,
  streamId: string,
  gateName: string,
  layer: string,
  passed: boolean,
  details?: Record<string, unknown>,
): Promise<void> {
  await store.append(streamId, {
    type: 'gate.executed',
    data: {
      gateName,
      layer,
      passed,
      ...(details !== undefined ? { details } : {}),
    },
  });
}
