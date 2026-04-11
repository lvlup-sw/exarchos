// ─── Finalize Oneshot Orchestrate Handler (T12) ────────────────────────────
//
// Resolves the oneshot workflow choice state at the end of the `implementing`
// phase, transitioning to either `synthesize` (PR-based path) or `completed`
// (direct-commit path) based on the synthesisOptedIn / synthesisOptedOut
// guards declared in T9.
//
// Approach: evaluate the synthesisOptedIn guard directly against the loaded
// state (the guard is pure — see workflow/guards.ts) to determine the
// target phase, then call handleSet to drive the HSM transition. This keeps
// the handler explicit about the choice and lets the state machine enforce
// guard semantics on the actual transition.
//
// Why not retry-with-fallthrough? An "attempt synthesize, on guard-fail try
// completed" approach would be more decoupled but produces a guard-failed
// event in the audit log on every direct-commit path, polluting the stream
// with diagnostic noise. Direct guard evaluation produces a single clean
// transition event.
// ────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { handleSet } from '../workflow/tools.js';
import { guards } from '../workflow/guards.js';
import { hydrateEventsFromStore } from '../workflow/state-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FinalizeOneshotArgs {
  readonly featureId: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

// ─── Handler ────────────────────────────────────────────────────────────────

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

  // ─── Read current workflow state ──────────────────────────────────────────
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  let state: Record<string, unknown>;
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    state = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        error: {
          code: 'STATE_NOT_FOUND',
          message: `State not found for feature: ${featureId}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'STATE_READ_FAILED',
        message: `Failed to read workflow state: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // ─── Verify workflow type ─────────────────────────────────────────────────
  const workflowType = state.workflowType;
  if (workflowType !== 'oneshot') {
    return {
      success: false,
      error: {
        code: 'INVALID_WORKFLOW_TYPE',
        message: `finalize_oneshot is only valid for oneshot workflows; got workflowType=${String(workflowType)}`,
      },
    };
  }

  // ─── Verify current phase ─────────────────────────────────────────────────
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

  // ─── Hydrate _events from the event store so the choice-state guards
  //     observe the same view that the HSM will see during the actual
  //     transition. Without this, an opt-in event appended after the state
  //     file was last written would be invisible to the inline guard check.
  try {
    state._events = await hydrateEventsFromStore(featureId, eventStore);
  } catch {
    // Best-effort: fall back to whatever events are already on the state.
    // The HSM will re-hydrate when handleSet executes the transition, so
    // any miss here is corrected before the actual phase change.
    state._events = state._events ?? [];
  }

  // ─── Resolve target phase via the synthesisOptedIn guard ─────────────────
  // Guards are pure — see workflow/guards.ts. We delegate to the guard
  // rather than re-implementing the policy/event logic so any future
  // change to the choice-state semantics happens in one place.
  const optedInResult = guards.synthesisOptedIn.evaluate(state);
  const targetPhase: 'synthesize' | 'completed' =
    optedInResult === true ? 'synthesize' : 'completed';

  // ─── Drive the transition through handleSet ──────────────────────────────
  // handleSet re-evaluates the corresponding HSM transition guard
  // (synthesisOptedIn / synthesisOptedOut) against the current state, so a
  // race that flips the policy or events between our read and the
  // transition is caught at the state-machine boundary rather than
  // silently driving an inconsistent target.
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
