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

import * as path from 'node:path';

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { resolveWorkflowState } from './resolve-state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RequestSynthesizeArgs {
  readonly featureId: string;
  readonly reason?: string;
  /**
   * Explicit state-file path. When omitted, the handler derives one from
   * `stateDir` + `featureId` (the composite dispatcher injects `stateDir`
   * from the DispatchContext). When `stateDir` is also omitted, the
   * resolver falls back to event-store materialization using only
   * `featureId` + `eventStore`.
   */
  readonly stateFile?: string;
  readonly stateDir?: string;
  readonly eventStore?: EventStore;
}

/**
 * Phases from which `request_synthesize` may be invoked. Matches the phase
 * gating in `registry.ts:request_synthesize`: the event is idempotent and
 * sits in the stream until `finalize_oneshot` reads it, so emitting it
 * from `plan` (before implementing starts) is legal. Any terminal phase
 * — `synthesize`, `completed`, `cancelled`, or any non-oneshot phase
 * reachable via cancel — MUST be rejected at the handler boundary so a
 * direct handler call (bypassing the registry layer) cannot corrupt the
 * audit stream after the workflow has already been resolved.
 */
const REQUEST_SYNTHESIZE_ALLOWED_PHASES: ReadonlySet<string> = new Set([
  'plan',
  'implementing',
]);

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

  // Defer state-file path derivation to the caller (explicit `stateFile`)
  // or the composite dispatcher (injected `stateDir`). When neither is
  // provided, the resolver falls back to event-store materialization from
  // `featureId` + `eventStore`, matching the `finalize_oneshot` pattern.
  // Previously this used a hardcoded `.exarchos/state/...` fallback that
  // didn't match the configured workflow-state location — callers running
  // under a non-default `stateDir` saw bogus "state not found" errors.
  const stateFile =
    args.stateFile
    ?? (args.stateDir
      ? path.join(args.stateDir, `${featureId}.state.json`)
      : undefined);

  const resolved = await resolveWorkflowState({
    ...(stateFile !== undefined ? { stateFile } : {}),
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

  // The resolver falls back to the event-store projection when no state
  // file exists, returning a zero-initialized view (`featureId: ''`,
  // `createdAt: ''`, `workflowType: 'feature'`) even for feature IDs that
  // have never emitted a single event. Treat the empty projection as
  // "no workflow exists" so callers see a proper STATE_NOT_FOUND instead
  // of tripping the downstream workflow-type check. Matches the sentinel
  // used by `finalize-oneshot.ts`.
  if (
    state.workflowType === undefined ||
    state.workflowType === null ||
    state.createdAt === '' ||
    state.featureId === ''
  ) {
    return {
      success: false,
      error: {
        code: 'STATE_NOT_FOUND',
        message: `State not found for feature: ${featureId}`,
      },
    };
  }

  if (workflowType !== 'oneshot') {
    return {
      success: false,
      error: {
        code: 'INVALID_WORKFLOW_TYPE',
        message: `request_synthesize is only valid for oneshot workflows; got workflowType=${String(workflowType)}`,
      },
    };
  }

  // Runtime phase guard. The registry layer gates this action at the MCP
  // tool boundary, but direct handler calls (e.g. from composite tests
  // or sibling orchestrate handlers) bypass the registry. Without this
  // check a terminal-phase workflow could receive a `synthesize.requested`
  // event after `finalize_oneshot` already resolved the choice state —
  // permanently corrupting the audit stream with a phantom opt-in signal
  // that could be replayed on rematerialization. Explicit reject mirrors
  // the registry's `phases: ['plan', 'implementing']` restriction.
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
