// ─── Shared oneshot-state resolution + validation (DR-10 dedup) ──────────────
//
// `finalize-oneshot.ts` and `request-synthesize.ts` each resolved the workflow
// state and ran the SAME three guards before doing their action-specific work:
//
//   1. translate the resolver's NO_STATE_SOURCE / EVENT_STORE_ERROR codes into
//      the STATE_NOT_FOUND taxonomy the rest of the oneshot handlers expect;
//   2. treat the event-store's zero-initialized projection (an unknown feature
//      that never emitted `workflow.started`) as "no workflow exists"; and
//   3. reject a non-`oneshot` workflow type.
//
// This helper is the single home for those three steps. Callers pass the
// action label used in the INVALID_WORKFLOW_TYPE message; each caller keeps its
// own phase gate (finalize requires `implementing`; request-synthesize allows
// `plan` or `implementing`) since that is where the two genuinely differ.

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveWorkflowState } from '../resolve-state.js';

/** Inputs for {@link resolveOneshotState}. */
export interface ResolveOneshotStateArgs {
  readonly featureId: string;
  readonly eventStore: EventStore;
  /**
   * Action label surfaced in the INVALID_WORKFLOW_TYPE message
   * (e.g. `finalize_oneshot`, `request_synthesize`).
   */
  readonly action: string;
  /**
   * Explicit state-file path. Omitted ⇒ the resolver falls back to event-store
   * materialization from `featureId` + `eventStore` (matching the conditional
   * spread both handlers used before DR-10).
   */
  readonly stateFile?: string;
}

/**
 * Discriminated result: the validated workflow state, or a ready-to-return
 * error `ToolResult` carrying the correct STATE_NOT_FOUND / INVALID_WORKFLOW_TYPE
 * / passthrough code.
 */
export type OneshotStateResult =
  | { readonly ok: true; readonly state: Record<string, unknown> }
  | { readonly ok: false; readonly error: ToolResult };

/** STATE_NOT_FOUND envelope shared by every "no workflow" branch. */
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
 * Resolve + validate a oneshot workflow's state. Returns `{ ok: true, state }`
 * only when the state resolves, is a real (non-empty-projection) workflow, and
 * is of type `oneshot`; otherwise `{ ok: false, error }` with the appropriate
 * structured code. The caller still owns its phase gate.
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
    // Translate the resolver's NO_STATE_SOURCE / EVENT_STORE_ERROR codes into
    // the STATE_NOT_FOUND taxonomy the oneshot handlers (and their callers)
    // expect; forward any other structured error verbatim.
    const code = resolved.error.error?.code;
    if (code === 'NO_STATE_SOURCE' || code === 'EVENT_STORE_ERROR') {
      return { ok: false, error: stateNotFound(featureId) };
    }
    return { ok: false, error: resolved.error };
  }

  const state = resolved.state;

  // The resolver falls back to the event-store projection when no state file
  // exists, returning a zero-initialized view (`featureId: ''`, `createdAt: ''`,
  // `workflowType: 'feature'`) even for feature IDs that never emitted an event.
  // Treat the empty projection as "no workflow exists" so callers cannot
  // silently act on a workflow that was never created.
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
