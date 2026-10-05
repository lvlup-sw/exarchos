/**
 * Handler for the `request_synthesize` action, the runtime opt-in for a oneshot workflow with `synthesisPolicy: 'on-request'`.
 * A `synthesize.requested` event sets the `synthesisOptedIn` guard, so the choice state routes to synthesize and not to a direct commit.
 * With `synthesisPolicy: 'never'`, the guard still resolves to opted-out, so the event only records the intent.
 * The guard counts one or more events, so a second call is safe.
 */

import * as path from 'node:path';

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveOneshotState } from '../tasks/oneshot-state.js';

export interface RequestSynthesizeArgs {
  readonly featureId: string;
  readonly reason?: string;
  /**
   * Explicit state-file path. Without it, the handler derives one from `stateDir` and `featureId`.
   * Without both, the resolver reads the state from the event store.
   */
  readonly stateFile?: string;
  readonly stateDir?: string;
  readonly eventStore?: EventStore;
}

/**
 * Phases that accept `request_synthesize`, the same set as the registry gate.
 * The event stays in the stream until `finalize_oneshot` reads it, so a call from `plan` is legal.
 * The handler rejects other phases, because a direct call skips the registry gate.
 * A late event after `finalize_oneshot` resolves the choice state corrupts the audit stream.
 */
const REQUEST_SYNTHESIZE_ALLOWED_PHASES: ReadonlySet<string> = new Set([
  'plan',
  'implementing',
]);

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

  const stateFile =
    args.stateFile
    ?? (args.stateDir
      ? path.join(args.stateDir, `${featureId}.state.json`)
      : undefined);

  const resolved = await resolveOneshotState({
    ...(stateFile !== undefined ? { stateFile } : {}),
    featureId,
    eventStore,
    action: 'request_synthesize',
  });

  if (!resolved.ok) {
    return resolved.error;
  }

  const state = resolved.state;

  const currentPhase =
    typeof state.phase === 'string' ? state.phase : String(state.phase);
  if (!REQUEST_SYNTHESIZE_ALLOWED_PHASES.has(currentPhase)) {
    return {
      success: false,
      error: {
        code: 'INVALID_PHASE',
        message: `request_synthesize may only be invoked from 'plan' or 'implementing'; got phase=${currentPhase}`,
      },
    };
  }

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
