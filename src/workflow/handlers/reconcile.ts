import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { ErrorCode } from '../schemas.js';
import { reconcileFromEvents, StateStoreError } from '../state-store.js';

// ─── handleReconcileState ───────────────────────────────────────────────

/**
 * Reconcile workflow state from events in the JSONL event store.
 *
 * Delegates to `reconcileFromEvents` which rebuilds state from events,
 * applying any that are newer than the state's `_eventSequence`.
 * Idempotent — running with no new events returns `{ reconciled: false, eventsApplied: 0 }`.
 */
export async function handleReconcileState(
  input: { featureId: string },
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  // Validate featureId
  if (!input.featureId) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: 'featureId is required for reconcile action',
      },
    };
  }

  // Guard: event store must be configured
  if (!eventStore) {
    return {
      success: false,
      error: {
        code: ErrorCode.EVENT_STORE_NOT_CONFIGURED,
        message: 'Event store is not configured — reconcile requires an event store',
      },
    };
  }

  try {
    const result = await reconcileFromEvents(stateDir, input.featureId, eventStore);
    return {
      success: true,
      data: {
        reconciled: result.reconciled,
        eventsApplied: result.eventsApplied,
      },
    };
  } catch (err) {
    if (err instanceof StateStoreError) {
      return {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      };
    }
    throw err;
  }
}
