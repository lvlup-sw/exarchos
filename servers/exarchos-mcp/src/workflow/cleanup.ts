import type { CleanupInput, WorkflowState } from './types.js';
import { ErrorCode } from './schemas.js';
import {
  readStateFile,
  writeStateFile,
  StateStoreError,
} from './state-store.js';
import {
  buildCheckpointMeta,
  resetCounter,
} from './checkpoint.js';
import { mapInternalToExternalType } from './events.js';
import { getHSMDefinition, executeTransition } from './state-machine.js';
import type { EventStore } from '../event-store/store.js';
import type { EventType } from '../event-store/schemas.js';
import type { ToolResult } from '../format.js';
import * as path from 'node:path';

// ─── Event-Sourcing Version Discriminator ───────────────────────────────────

const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by cleanup handlers. */
export function configureCleanupEventStore(store: EventStore | null): void {
  moduleEventStore = store;
}

// ─── Event-First Emission ───────────────────────────────────────────────────

interface CleanupEventPayload {
  featureId: string;
  currentPhase: string;
  synthesis: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  reviews: Record<string, unknown> | undefined;
  hasReviewEntries: boolean;
  hasSynthesisBackfill: boolean;
  transitionEvents: ReadonlyArray<{
    type: string;
    from: string;
    to: string;
    trigger: string;
    metadata?: Record<string, unknown>;
  }>;
  prUrl?: string | string[];
  mergedBranches?: string[];
}

/**
 * Emit cleanup events to the event store (v2 event-first contract).
 *
 * Events are emitted in order:
 * 1. `state.patched` — synthesis/review backfill (if applicable)
 * 2. `workflow.cleanup` — HSM transition events with idempotency keys
 * 3. `workflow.cleanup` — explicit cleanup completion event
 *
 * @throws Error if any event append fails (caller should abort state write)
 */
async function emitCleanupEvents(
  store: EventStore,
  payload: CleanupEventPayload,
): Promise<void> {
  const { featureId, currentPhase } = payload;

  // 1. Emit state.patched for backfilled fields
  const backfillPatch: Record<string, unknown> = {};
  if (payload.hasSynthesisBackfill) {
    backfillPatch.synthesis = payload.synthesis;
    backfillPatch.artifacts = payload.artifacts;
  }
  if (payload.hasReviewEntries) {
    backfillPatch.reviews = payload.reviews;
  }
  if (Object.keys(backfillPatch).length > 0) {
    await store.append(featureId, {
      type: 'state.patched' as EventType,
      correlationId: featureId,
      source: 'workflow',
      data: {
        featureId,
        fields: Object.keys(backfillPatch),
        patch: backfillPatch,
      },
    }, { idempotencyKey: `${featureId}:cleanup:patch:${currentPhase}` });
  }

  // 2. Emit transition events with idempotency keys
  for (const evt of payload.transitionEvents) {
    await store.append(featureId, {
      type: mapInternalToExternalType(evt.type) as EventType,
      correlationId: featureId,
      source: 'workflow',
      data: {
        from: evt.from,
        to: evt.to,
        trigger: evt.trigger,
        featureId,
        ...(evt.metadata ?? {}),
      },
    }, { idempotencyKey: `${featureId}:cleanup:transition:${evt.from}:${evt.to}:${currentPhase}` });
  }

  // 3. Emit workflow.cleanup completion event
  await store.append(featureId, {
    type: 'workflow.cleanup' as EventType,
    correlationId: featureId,
    source: 'workflow',
    data: {
      featureId,
      previousPhase: currentPhase,
      mergeVerified: true,
      prUrl: payload.prUrl,
      mergedBranches: payload.mergedBranches,
    },
  }, { idempotencyKey: `${featureId}:cleanup:complete` });
}

// ─── V1 Legacy Event Emission ───────────────────────────────────────────────

/**
 * Emit transition events after state write (v1 legacy best-effort).
 * Failures are silently swallowed — state is already written.
 */
async function emitLegacyTransitionEvents(
  store: EventStore,
  featureId: string,
  transitionEvents: ReadonlyArray<{
    type: string;
    from: string;
    to: string;
    trigger: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<void> {
  try {
    for (const evt of transitionEvents) {
      await store.append(featureId, {
        type: mapInternalToExternalType(evt.type) as EventType,
        correlationId: featureId,
        source: 'workflow',
        data: {
          from: evt.from,
          to: evt.to,
          trigger: evt.trigger,
          featureId,
          ...(evt.metadata ?? {}),
        },
      });
    }
  } catch {
    // V1 legacy: external store is supplementary; append failure must not break cleanup
  }
}

// ─── handleCleanup ──────────────────────────────────────────────────────────

/**
 * Clean up a workflow by transitioning it to completed.
 *
 * **Event-first contract (ES v2):** When the workflow uses event-sourcing v2,
 * cleanup events (`state.patched`, `workflow.cleanup`) are appended to the
 * event store BEFORE the state file is written. If event append fails, no
 * state file is written and an error is returned. All events carry
 * idempotency keys for safe retry.
 *
 * **Legacy path (v1):** State file is written first; events are emitted
 * after as best-effort (failures are silently swallowed).
 */
export async function handleCleanup(
  input: CleanupInput,
  stateDir: string,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  let state: WorkflowState;
  try {
    state = await readStateFile(stateFile);
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_NOT_FOUND,
          message: `State not found for feature: ${input.featureId}`,
        },
      };
    }
    throw err;
  }

  // Guard: terminal states
  if (state.phase === 'completed') {
    return {
      success: false,
      error: {
        code: ErrorCode.ALREADY_COMPLETED,
        message: `Workflow '${input.featureId}' is already completed`,
      },
    };
  }

  if (state.phase === 'cancelled') {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_TRANSITION,
        message: `Cannot cleanup cancelled workflow '${input.featureId}'`,
      },
    };
  }

  // Guard: merge verification
  if (!input.mergeVerified) {
    return {
      success: false,
      error: {
        code: ErrorCode.GUARD_FAILED,
        message: 'Cleanup requires mergeVerified: true — verify PRs are merged before invoking cleanup',
      },
    };
  }

  // ─── Build mutations ──────────────────────────────────────────────────

  const mutableState = structuredClone(state) as Record<string, unknown>;
  const currentPhase = state.phase;
  const dryRun = input.dryRun ?? false;

  // Backfill synthesis metadata
  const synthesis = (mutableState.synthesis ?? {}) as Record<string, unknown>;
  if (input.prUrl !== undefined) {
    synthesis.prUrl = input.prUrl;
  }
  if (input.mergedBranches !== undefined) {
    synthesis.mergedBranches = input.mergedBranches;
  }
  mutableState.synthesis = synthesis;

  // Also set artifacts.pr for guards that check there
  const artifacts = (mutableState.artifacts ?? {}) as Record<string, unknown>;
  if (input.prUrl !== undefined && artifacts.pr == null) {
    artifacts.pr = input.prUrl;
  }
  mutableState.artifacts = artifacts;

  // Force-resolve all blocking review statuses
  const reviews = mutableState.reviews as Record<string, unknown> | undefined;
  const hasReviewEntries = reviews !== undefined && Object.keys(reviews).length > 0;
  if (reviews) {
    for (const [, value] of Object.entries(reviews)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.status === 'string') {
        entry.status = 'approved';
      } else {
        for (const [, subValue] of Object.entries(entry)) {
          if (typeof subValue === 'object' && subValue !== null) {
            const sub = subValue as Record<string, unknown>;
            if (typeof sub.status === 'string') {
              sub.status = 'approved';
            }
          }
        }
      }
    }
  }

  // Set _cleanup.mergeVerified for the HSM guard
  mutableState._cleanup = { mergeVerified: true };

  // ─── HSM transition ───────────────────────────────────────────────────

  const hsm = getHSMDefinition(state.workflowType);
  const transitionResult = executeTransition(hsm, mutableState, 'completed');

  if (!transitionResult.success) {
    return {
      success: false,
      error: {
        code: transitionResult.errorCode ?? ErrorCode.INVALID_TRANSITION,
        message: transitionResult.errorMessage ?? 'Failed to transition to completed',
      },
    };
  }

  // dryRun: return preview without modifying state
  if (dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        currentPhase,
        wouldTransitionTo: 'completed',
        synthesisBackfill: {
          prUrl: input.prUrl ?? null,
          mergedBranches: input.mergedBranches ?? null,
        },
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  }

  // ─── Apply state mutations ────────────────────────────────────────────

  mutableState.phase = 'completed';

  if (transitionResult.historyUpdates) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(transitionResult.historyUpdates)) {
      history[key] = value;
    }
    mutableState._history = history;
  }

  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    'completed',
    'Workflow completed via cleanup',
  );

  mutableState.updatedAt = new Date().toISOString();
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  delete mutableState._cleanup;

  // ─── Event emission + state write ─────────────────────────────────────

  const stateRecord = state as unknown as Record<string, unknown>;
  const useEventFirst = isEventSourced(stateRecord) && moduleEventStore !== null;

  if (useEventFirst) {
    // ES v2: emit events BEFORE writing state
    try {
      await emitCleanupEvents(moduleEventStore!, {
        featureId: input.featureId,
        currentPhase,
        synthesis,
        artifacts,
        reviews,
        hasReviewEntries,
        hasSynthesisBackfill: input.prUrl !== undefined || input.mergedBranches !== undefined,
        transitionEvents: transitionResult.events,
        prUrl: input.prUrl,
        mergedBranches: input.mergedBranches,
      });
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Event append failed during cleanup: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // Write state file (after events for v2, as primary store for v1)
  await writeStateFile(stateFile, mutableState as WorkflowState);

  // V1 legacy: best-effort event emission AFTER state write
  if (!useEventFirst && moduleEventStore) {
    await emitLegacyTransitionEvents(
      moduleEventStore,
      input.featureId,
      transitionResult.events,
    );
  }

  return {
    success: true,
    data: {
      phase: 'completed',
      previousPhase: currentPhase,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}
