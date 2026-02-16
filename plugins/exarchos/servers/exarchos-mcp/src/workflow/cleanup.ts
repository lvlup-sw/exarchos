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
import type { ToolResult } from '../format.js';
import * as path from 'node:path';

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by cleanup handlers. */
export function configureCleanupEventStore(store: EventStore | null): void {
  moduleEventStore = store;
}

// ─── handleCleanup ──────────────────────────────────────────────────────────

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

  // Check if already completed
  if (state.phase === 'completed') {
    return {
      success: false,
      error: {
        code: ErrorCode.ALREADY_COMPLETED,
        message: `Workflow '${input.featureId}' is already completed`,
      },
    };
  }

  // Check if cancelled (cannot cleanup a cancelled workflow)
  if (state.phase === 'cancelled') {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_TRANSITION,
        message: `Cannot cleanup cancelled workflow '${input.featureId}'`,
      },
    };
  }

  // Check merge verification
  if (!input.mergeVerified) {
    return {
      success: false,
      error: {
        code: ErrorCode.GUARD_FAILED,
        message: 'Cleanup requires mergeVerified: true — verify PRs are merged before invoking cleanup',
      },
    };
  }

  // ─── Happy path (Task 5) ──────────────────────────────────────────────

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
  if (reviews) {
    for (const [, value] of Object.entries(reviews)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.status === 'string') {
        // Flat review: { status: "in-progress" } → { status: "approved" }
        entry.status = 'approved';
      } else {
        // Nested: { specReview: { status: "fail" }, qualityReview: { status: "needs_fixes" } }
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

  // Set _cleanup.mergeVerified for the guard
  mutableState._cleanup = { mergeVerified: true };

  // Execute HSM transition to completed
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

  // Event-first: emit cleanup event BEFORE state write
  if (moduleEventStore) {
    try {
      for (const transitionEvent of transitionResult.events) {
        await moduleEventStore.append(input.featureId, {
          type: mapInternalToExternalType(transitionEvent.type) as import('../event-store/schemas.js').EventType,
          data: {
            from: transitionEvent.from,
            to: transitionEvent.to,
            trigger: transitionEvent.trigger,
            featureId: input.featureId,
            ...(transitionEvent.metadata ?? {}),
          },
        });
      }
    } catch {
      // External store is supplementary; append failure must not break cleanup
    }
  }

  // Mutate state
  mutableState.phase = 'completed';

  // Apply history updates from transition
  if (transitionResult.historyUpdates) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(transitionResult.historyUpdates)) {
      history[key] = value;
    }
    mutableState._history = history;
  }

  // Reset checkpoint counter
  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    'completed',
    'Workflow completed via cleanup',
  );

  // Update timestamps
  mutableState.updatedAt = new Date().toISOString();
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Clean up internal cleanup flag
  delete mutableState._cleanup;

  // Write state
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: 'completed',
      previousPhase: currentPhase,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}
