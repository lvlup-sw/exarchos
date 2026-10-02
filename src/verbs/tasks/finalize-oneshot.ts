/**
 * Resolves the oneshot choice state at the end of the `implementing` phase.
 * The target is `synthesize` for the PR path or `completed` for the direct-commit path.
 * The handler evaluates the `synthesisOptedIn` guard directly, then calls `handleSet` for the transition.
 * A try-and-fall-through approach puts a guard-failed event in the log on each direct-commit path, so the handler does not use it.
 */

import * as path from 'node:path';

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { handleSet } from '../../workflow/tools.js';
import { guards } from '../../workflow/guards.js';
import { hydrateEventsFromStore } from '../../workflow/state-store.js';
import { resolveOneshotState } from './oneshot-state.js';

export interface FinalizeOneshotArgs {
  readonly featureId: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

/**
 * Finalizes a oneshot workflow. `resolveOneshotState` resolves the state from the state file or the event store and checks the workflow type.
 * The handler loads `_events` from the event store, so the guard sees opt-in events that the state file does not hold yet.
 * When that load fails, it keeps the events on the state, because `handleSet` loads them again before the transition.
 * `handleSet` evaluates the transition guard again, so a change between the read and the transition cannot drive the wrong target.
 */
export async function handleFinalizeOneshot(
  args: FinalizeOneshotArgs,
): Promise<ToolResult> {
  const { featureId, stateDir, eventStore } = args;

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
        code: 'INVALID_INPUT',
        message: 'eventStore is required for finalize_oneshot',
      },
    };
  }

  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const resolved = await resolveOneshotState({
    stateFile,
    featureId,
    eventStore,
    action: 'finalize_oneshot',
  });

  if (!resolved.ok) {
    return resolved.error;
  }

  const state: Record<string, unknown> = resolved.state;

  const currentPhase = state.phase;
  if (currentPhase !== 'implementing') {
    return {
      success: false,
      error: {
        code: 'INVALID_PHASE',
        message: `finalize_oneshot may only be invoked from the implementing phase; got phase=${String(currentPhase)}`,
      },
    };
  }

  try {
    state._events = await hydrateEventsFromStore(featureId, eventStore);
  } catch {
    state._events = state._events ?? [];
  }

  const optedInResult = guards.synthesisOptedIn.evaluate(state);
  const targetPhase: 'synthesize' | 'completed' =
    optedInResult === true ? 'synthesize' : 'completed';

  const setResult = await handleSet(
    { featureId, phase: targetPhase },
    stateDir,
    eventStore,
  );

  if (!setResult.success) {
    return setResult;
  }

  return {
    success: true,
    data: {
      featureId,
      previousPhase: 'implementing',
      newPhase: targetPhase,
    },
  };
}
