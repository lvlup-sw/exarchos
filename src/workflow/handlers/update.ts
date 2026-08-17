import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { ErrorCode } from '../schemas.js';
import { handleSet } from './set.js';

// ─── handleUpdate ───────────────────────────────────────────────────────────
//
// Wave 0 (#1340, v2.10.0-preview.2): canonical state-mutation surface for
// non-phase fields. Delegates to `handleSet` with `updates` only after
// rejecting any caller that tries to smuggle a `phase` field through the
// `updates` payload. Phase mutation lives on the `transition` action and
// its HSM-guarded code path — accepting `phase` here would silently
// bypass guard evaluation, valid-target enumeration, and the
// `workflow.transition` event emission.
//
// The guard is a structured `INVALID_INPUT` + `suggestedFix` envelope
// (INV-5a — agent input ergonomics). Agents auto-correct off the
// suggestedFix shape without parsing the message string, so the guard
// stays robust under future error-message rewording.

export interface UpdateInput {
  readonly featureId: string;
  readonly updates: Record<string, unknown>;
}

/**
 * Canonical non-phase state-mutation handler. Validates that `updates`
 * does not contain a `phase` field (which would route around the HSM
 * transition guard), then delegates to `handleSet({featureId, updates})`
 * so the same event-first / CAS / per-stream-lock machinery serves both
 * the legacy `set({updates})` entry point (now removed) and the
 * canonical `update` action.
 *
 * On `phase`-in-updates: returns `{success: false, error: {code:
 * 'INVALID_INPUT', suggestedFix: {tool: 'exarchos_workflow', params:
 * {action: 'transition', ...}}}}` so callers can self-correct in one
 * tool call.
 */
export async function handleUpdate(
  input: UpdateInput,
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  if (Object.prototype.hasOwnProperty.call(input.updates, 'phase')) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message:
          "Cannot mutate 'phase' through update — phase changes go through the HSM-guarded transition action so guard evaluation, valid-target enumeration, and the workflow.transition event emission cannot be bypassed.",
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'transition',
            featureId: input.featureId,
            // Surface the offending value so callers can re-issue the
            // intended phase change with one search-and-replace; the
            // narrowed payload is a parameter shape, not a recommendation.
            target: input.updates.phase,
          },
        },
      },
    };
  }

  return handleSet(
    { featureId: input.featureId, updates: input.updates },
    stateDir,
    eventStore,
  );
}
