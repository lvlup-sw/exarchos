import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { ErrorCode } from '../schemas.js';
import { handleSet } from './set.js';

export interface UpdateInput {
  readonly featureId: string;
  readonly updates: Record<string, unknown>;
}

/**
 * Canonical handler for non-phase state changes. It delegates to `handleSet`,
 * so an update gets the same event-first write and CAS check.
 *
 * A `phase` field in `updates` gets an `INVALID_INPUT` error. Phase changes go
 * through the HSM-guarded `transition` action, and this path must not bypass
 * that guard. The `suggestedFix` names the `transition` call with the offending
 * value as `target`, so an agent can correct itself in one call.
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
