/**
 * Resolves and checks the state of a oneshot workflow for `finalize-oneshot.ts` and `request-synthesize.ts`.
 * It maps the resolver codes `NO_STATE_SOURCE` and `EVENT_STORE_ERROR` to `STATE_NOT_FOUND`.
 * It treats an empty projection as no workflow, and it rejects a workflow type other than `oneshot`.
 * Each caller keeps its own phase gate.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveWorkflowState } from '../resolve-state.js';

/** Inputs for {@link resolveOneshotState}. */
export interface ResolveOneshotStateArgs {
  readonly featureId: string;
  readonly eventStore: EventStore;
  /** The action label in the `INVALID_WORKFLOW_TYPE` message, for example `finalize_oneshot`. */
  readonly action: string;
  /** The state-file path. When it is absent, the resolver builds the state from the event store. */
  readonly stateFile?: string;
}

/** The checked workflow state, or an error `ToolResult` that the caller can return as it is. */
export type OneshotStateResult =
  | { readonly ok: true; readonly state: Record<string, unknown> }
  | { readonly ok: false; readonly error: ToolResult };

/** The `STATE_NOT_FOUND` result for each branch that finds no workflow. */
function stateNotFound(featureId: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'STATE_NOT_FOUND',
      message: `State not found for feature: ${featureId}`,
    },
  };
}

/**
 * Resolves and checks the state of a oneshot workflow. The function forwards a resolver error other than the two mapped codes as it is.
 * With no state file, the resolver returns a zero-initialized projection even for an unknown feature. The function treats that projection as no workflow.
 */
export async function resolveOneshotState(
  args: ResolveOneshotStateArgs,
): Promise<OneshotStateResult> {
  const { featureId, eventStore, action, stateFile } = args;

  const resolved = await resolveWorkflowState({
    ...(stateFile !== undefined ? { stateFile } : {}),
    featureId,
    eventStore,
  });

  if ('error' in resolved) {
    const code = resolved.error.error?.code;
    if (code === 'NO_STATE_SOURCE' || code === 'EVENT_STORE_ERROR') {
      return { ok: false, error: stateNotFound(featureId) };
    }
    return { ok: false, error: resolved.error };
  }

  const state = resolved.state;

  if (
    state.workflowType === undefined ||
    state.workflowType === null ||
    state.createdAt === '' ||
    state.featureId === ''
  ) {
    return { ok: false, error: stateNotFound(featureId) };
  }

  if (state.workflowType !== 'oneshot') {
    return {
      ok: false,
      error: {
        success: false,
        error: {
          code: 'INVALID_WORKFLOW_TYPE',
          message: `${action} is only valid for oneshot workflows; got workflowType=${String(state.workflowType)}`,
        },
      },
    };
  }

  return { ok: true, state };
}
