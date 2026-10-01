import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { ErrorCode } from '../schemas.js';
import { reconcileFromEvents, StateStoreError } from '../state-store.js';

/**
 * Reconcile workflow state from the event store.
 *
 * `reconcileFromEvents` applies the events that are newer than the
 * `_eventSequence` of the state. With no new events, the result is
 * `{ reconciled: false, eventsApplied: 0 }`.
 */
export async function handleReconcileState(
  input: { featureId: string },
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  if (!input.featureId) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: 'featureId is required for reconcile action',
      },
    };
  }

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
