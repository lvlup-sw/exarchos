// ─── Request Synthesize Orchestrate Handler (T11) ──────────────────────────
//
// Runtime opt-in path for oneshot workflows with `synthesisPolicy: 'on-request'`.
// Appending a `synthesize.requested` event flips the `synthesisOptedIn` guard
// and routes the choice-state toward the synthesize phase instead of direct
// commit. For `synthesisPolicy: 'always'`, this event is redundant but not
// harmful; for `synthesisPolicy: 'never'`, the guard still short-circuits to
// opted-out, so this handler simply records the (ignored) intent.
//
// Append semantics are intentional: the downstream guard uses count >= 1
// semantics, so calling the handler twice is safe — multiple events collapse
// to a single "opted in" decision.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { resolveWorkflowState } from './resolve-state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RequestSynthesizeArgs {
  readonly featureId: string;
  readonly reason?: string;
  readonly stateFile?: string;
  readonly eventStore?: EventStore;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleRequestSynthesize(
  args: RequestSynthesizeArgs,
): Promise<ToolResult> {
  const { featureId, reason, eventStore } = args;

  if (!featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!eventStore) {
    return {
      success: false,
      error: {
        code: 'NO_EVENT_STORE',
        message: 'eventStore is required to append synthesize.requested',
      },
    };
  }

  // Derive a default state-file path from featureId when the caller has not
  // supplied one explicitly. This matches how other orchestrate handlers
  // (e.g. reconcile-state) resolve workflow state on disk.
  const stateFile =
    args.stateFile ?? `.exarchos/state/${featureId}.state.json`;

  const resolved = await resolveWorkflowState({
    stateFile,
    featureId,
    eventStore,
  });

  if ('error' in resolved) {
    // resolveWorkflowState returns NO_STATE_SOURCE when no source resolves;
    // translate that into STATE_NOT_FOUND so the error taxonomy matches
    // handleGet / cleanup / cancel.
    const code = resolved.error.error?.code;
    if (code === 'NO_STATE_SOURCE' || code === 'EVENT_STORE_ERROR') {
      return {
        success: false,
        error: {
          code: 'STATE_NOT_FOUND',
          message: `State not found for feature: ${featureId}`,
        },
      };
    }
    return resolved.error;
  }

  const state = resolved.state;
  const workflowType = state.workflowType;

  if (workflowType !== 'oneshot') {
    return {
      success: false,
      error: {
        code: 'INVALID_WORKFLOW_TYPE',
        message: `request_synthesize is only valid for oneshot workflows; got workflowType=${String(workflowType)}`,
      },
    };
  }

  // Append the synthesize.requested event. Payload matches
  // SynthesizeRequestedData in event-store/schemas.ts (T2).
  const timestamp = new Date().toISOString();
  try {
    await eventStore.append(featureId, {
      type: 'synthesize.requested',
      data: {
        featureId,
        ...(reason !== undefined ? { reason } : {}),
        timestamp,
      },
    });
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'APPEND_FAILED',
        message: `Failed to append synthesize.requested: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  return {
    success: true,
    data: {
      eventAppended: true,
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}
