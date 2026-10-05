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
import { hsmTransitionGuard } from './hsm-transition-guard.js';
import { recordLiveTransition } from './admission/live-shadow-observer.js';
import { allocatePhaseAttemptId, readPhaseAttemptId } from './phase-attempt-id.js';
import type { EventStore } from '../events/store.js';
import type { EventType } from '../events/schemas.js';
import type { SnapshotStore } from '../projections/views/snapshot-store.js';
import type { ToolResult } from '../format.js';
import * as path from 'node:path';

/** The `_esVersion` of a workflow on the pure event-sourcing path. */
const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

/** The store whose derived snapshot files cleanup deletes. `null` skips the deletion. */
let moduleSnapshotStore: SnapshotStore | null = null;

/** Configure the SnapshotStore instance used by cleanup handlers. */
export function configureCleanupSnapshotStore(store: SnapshotStore | null): void {
  moduleSnapshotStore = store;
}

/** The input of `emitCleanupEvents`. */
interface CleanupEventPayload {
  featureId: string;
  currentPhase: string;
  synthesis: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  hasSynthesisBackfill: boolean;
  /** The evidence verdict that satisfied `guards.mergeVerified`. */
  mergeVerified: boolean;
  /** The typed artifact reference backing that verdict. */
  mergeArtifact: string | null;
  transitionEvents: ReadonlyArray<{
    type: string;
    from: string;
    to: string;
    trigger: string;
    metadata?: Record<string, unknown>;
  }>;
  prUrl?: string | string[] | undefined;
  mergedBranches?: string[] | undefined;
  phaseAttemptId: string;
}

/**
 * Append the cleanup trail of an event-sourced (v2) workflow to the event store.
 * The trail is the `state.patched` backfill when present, the HSM transition events, and the `workflow.cleanup` completion event.
 * The whole trail commits in one atomic transaction, so the stream gets the complete trail or nothing.
 * The operation id uses the retry-stable `phaseAttemptId`, so a retry of the same cleanup reuses it.
 *
 * @throws When the atomic append fails. The caller then does not write the state.
 */
async function emitCleanupEvents(
  store: EventStore,
  payload: CleanupEventPayload,
): Promise<void> {
  const { featureId, currentPhase } = payload;
  const trail: Array<
    Parameters<EventStore['appendTrailAtomically']>[1][number]
  > = [];

  const backfillPatch: Record<string, unknown> = {};
  if (payload.hasSynthesisBackfill) {
    backfillPatch.synthesis = payload.synthesis;
    backfillPatch.artifacts = payload.artifacts;
  }
  if (Object.keys(backfillPatch).length > 0) {
    trail.push({
      type: 'state.patched' as EventType,
      correlationId: featureId,
      source: 'workflow',
      data: {
        featureId,
        fields: Object.keys(backfillPatch),
        patch: backfillPatch,
      },
      idempotencyKey: `${featureId}:cleanup:patch:${currentPhase}`,
    });
  }

  for (const evt of payload.transitionEvents) {
    trail.push({
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
      idempotencyKey: `${featureId}:cleanup:transition:${evt.from}:${evt.to}:${currentPhase}`,
    });
  }

  trail.push({
    type: 'workflow.cleanup' as EventType,
    correlationId: featureId,
    source: 'workflow',
    data: {
      featureId,
      from: currentPhase,
      to: 'completed',
      trigger: 'cleanup',
      phaseAttemptId: payload.phaseAttemptId,
      previousPhase: currentPhase,
      mergeVerified: payload.mergeVerified,
      mergeArtifact: payload.mergeArtifact,
      prUrl: payload.prUrl,
      mergedBranches: payload.mergedBranches,
    },
    idempotencyKey: `${featureId}:cleanup:complete`,
  });

  await store.appendTrailAtomically(
    featureId,
    trail,
    `cleanup:${featureId}:${payload.phaseAttemptId}`,
  );
}

/**
 * Map a `HSMTransitionGuard` failure code to the MCP `ErrorCode`.
 * `CIRCUIT_OPEN` and `PHASE_BLOCKED` stay distinct, so a substrate-integrity failure does not look like a generic guard failure.
 */
function mapAttemptErrorCode(
  code: 'GUARD_FAILED' | 'CIRCUIT_OPEN' | 'PHASE_BLOCKED' | 'INVALID_TRANSITION',
): (typeof ErrorCode)[keyof typeof ErrorCode] {
  switch (code) {
    case 'CIRCUIT_OPEN':
      return ErrorCode.CIRCUIT_OPEN;
    case 'PHASE_BLOCKED':
      return ErrorCode.PHASE_BLOCKED;
    case 'INVALID_TRANSITION':
      return ErrorCode.INVALID_TRANSITION;
    default:
      return ErrorCode.GUARD_FAILED;
  }
}

/**
 * Emit the transition events of a legacy (v1) workflow after the state write, as one atomic trail.
 * The function ignores a failure, because the state file is the primary store and is already written.
 */
async function emitLegacyTransitionEvents(
  store: EventStore,
  featureId: string,
  operationId: string,
  transitionEvents: ReadonlyArray<{
    type: string;
    from: string;
    to: string;
    trigger: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<void> {
  try {
    await store.appendTrailAtomically(
      featureId,
      transitionEvents.map((evt) => ({
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
      })),
      operationId,
    );
  } catch {
  }
}

/**
 * What cleanup can prove about the merge, read from the workflow state.
 * The collector never writes `state`. Its verdict goes to `guards.mergeVerified`, so absent evidence fails the guard.
 */
export interface CleanupEvidence {
  /** True only when every evidence requirement below is satisfied. */
  readonly verified: boolean;
  /** Human-readable reasons the evidence is insufficient (empty when verified). */
  readonly reasons: readonly string[];
  /** Review keys (or `entry.subEntry` paths) that are NOT approved. */
  readonly unapprovedReviews: readonly string[];
  /** The typed merge artifact reference backing the merge, or null. */
  readonly mergeArtifact: string | null;
}

/** Read the first artifact reference from a state field: a non-empty trimmed string, or the first such string in a list. */
function firstArtifactRef(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = firstArtifactRef(item);
      if (ref !== null) return ref;
    }
  }
  return null;
}

/**
 * Collect the evidence that a merge happened. Both requirements read only the state.
 *  1. Every review entry with a `status`, or else each nested sub-review with a `status`, reads `'approved'`.
 *  2. A merge artifact reference exists under `synthesis.prUrl`, `artifacts.pr`, or `synthesis.mergedBranches`.
 * A `mergeVerified: true` from the caller is an assertion, not evidence.
 */
export function collectCleanupEvidence(
  state: Record<string, unknown>,
): CleanupEvidence {
  const reasons: string[] = [];
  const unapprovedReviews: string[] = [];

  const reviews = state.reviews as Record<string, unknown> | undefined;
  if (reviews) {
    for (const [key, value] of Object.entries(reviews)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.status === 'string') {
        if (entry.status !== 'approved') unapprovedReviews.push(key);
        continue;
      }
      for (const [subKey, subValue] of Object.entries(entry)) {
        if (typeof subValue !== 'object' || subValue === null) continue;
        const sub = subValue as Record<string, unknown>;
        if (typeof sub.status === 'string' && sub.status !== 'approved') {
          unapprovedReviews.push(`${key}.${subKey}`);
        }
      }
    }
  }
  if (unapprovedReviews.length > 0) {
    reasons.push(
      `reviews are not approved: ${unapprovedReviews.join(', ')} — approve them on their own review path, cleanup will not`,
    );
  }

  const synthesis = state.synthesis as Record<string, unknown> | undefined;
  const artifacts = state.artifacts as Record<string, unknown> | undefined;
  const mergeArtifact =
    firstArtifactRef(synthesis?.prUrl) ??
    firstArtifactRef(artifacts?.pr) ??
    firstArtifactRef(synthesis?.mergedBranches);
  if (mergeArtifact === null) {
    reasons.push(
      'no merge artifact reference recorded (synthesis.prUrl / artifacts.pr / synthesis.mergedBranches)',
    );
  }

  return {
    verified: reasons.length === 0,
    reasons,
    unapprovedReviews,
    mergeArtifact,
  };
}

/**
 * Clean up a workflow by moving it to `completed`.
 * The merge guard reads the evidence in the state before cleanup backfills the `prUrl` and `mergedBranches` inputs.
 * Cleanup does not rewrite reviews, and it sets the `_cleanup.mergeVerified` guard input from the evidence verdict.
 * Insufficient evidence gives `GUARD_FAILED`, not the downstream `INVALID_TRANSITION`.
 * The phase change goes through `hsmTransitionGuard.attempt` with `eventStore: null`, so this handler owns the emission.
 * `allowUniversalFinalTransition` admits `completed`, a universal final edge with no explicit HSM definition.
 *
 * With an event store, an event-sourced (v2) workflow appends the whole trail before the state write.
 * When that append fails, the state file stays unchanged.
 * Otherwise cleanup writes the state first, and then emits the events on a best-effort basis when a store exists.
 * A failed deletion of derived snapshot files does not fail cleanup.
 */
export async function handleCleanup(
  input: CleanupInput,
  stateDir: string,
  eventStore: EventStore | null,
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

  if (!input.mergeVerified) {
    return {
      success: false,
      error: {
        code: ErrorCode.GUARD_FAILED,
        message: 'Cleanup requires mergeVerified: true — verify PRs are merged before invoking cleanup',
      },
    };
  }

  const mutableState = structuredClone(state) as Record<string, unknown>;
  const currentPhase = state.phase;
  const dryRun = input.dryRun ?? false;

  const evidence = collectCleanupEvidence(mutableState);
  mutableState._cleanup = { mergeVerified: evidence.verified };

  const phaseAttemptId = dryRun
    ? undefined
    : allocatePhaseAttemptId(
        input.featureId,
        currentPhase,
        'completed',
        readPhaseAttemptId(state),
        state._version ?? 1,
      );
  if (phaseAttemptId !== undefined) {
    mutableState._pendingPhaseAttemptId = phaseAttemptId;
  }

  const attempt = await hsmTransitionGuard.attempt(
    input.featureId,
    currentPhase,
    'completed',
    {
      state: mutableState,
      workflowType: state.workflowType,
      eventStore: null,
      allowUniversalFinalTransition: true,
      shadowObserver: (observation) =>
        recordLiveTransition(observation, mutableState, eventStore),
    },
  );

  if (!attempt.ok) {
    if (!evidence.verified) {
      return {
        success: false,
        error: {
          code: ErrorCode.GUARD_FAILED,
          message: `Cleanup guard 'merge-verified' failed — cleanup evidence insufficient: ${evidence.reasons.join('; ')}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: mapAttemptErrorCode(attempt.errorCode),
        message: attempt.errorMessage,
      },
    };
  }

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

  const synthesis = (mutableState.synthesis ?? {}) as Record<string, unknown>;
  if (input.prUrl !== undefined) {
    synthesis.prUrl = input.prUrl;
  }
  if (input.mergedBranches !== undefined) {
    synthesis.mergedBranches = input.mergedBranches;
  }
  mutableState.synthesis = synthesis;

  const artifacts = (mutableState.artifacts ?? {}) as Record<string, unknown>;
  if (input.prUrl !== undefined && artifacts.pr == null) {
    artifacts.pr = input.prUrl;
  }
  mutableState.artifacts = artifacts;

  mutableState.phase = 'completed';
  mutableState.phaseAttemptId = phaseAttemptId;

  if (Object.keys(attempt.historyUpdates).length > 0) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(attempt.historyUpdates)) {
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
  delete mutableState._pendingPhaseAttemptId;

  const eventFirstStore =
    isEventSourced(state) && eventStore !== null && eventStore !== undefined
      ? eventStore
      : undefined;
  const useEventFirst = eventFirstStore !== undefined;

  if (eventFirstStore !== undefined && phaseAttemptId !== undefined) {
    try {
      await emitCleanupEvents(eventFirstStore, {
        featureId: input.featureId,
        currentPhase,
        synthesis,
        artifacts,
        hasSynthesisBackfill: input.prUrl !== undefined || input.mergedBranches !== undefined,
        mergeVerified: evidence.verified,
        mergeArtifact: evidence.mergeArtifact,
        transitionEvents: attempt.emittedEvents,
        prUrl: input.prUrl,
        mergedBranches: input.mergedBranches,
        phaseAttemptId,
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

  await writeStateFile(stateFile, mutableState as WorkflowState);

  if (!useEventFirst && eventStore) {
    await emitLegacyTransitionEvents(
      eventStore,
      input.featureId,
      `cleanup:legacy:${input.featureId}:${phaseAttemptId ?? currentPhase}`,
      attempt.emittedEvents,
    );
  }

  if (moduleSnapshotStore) {
    try {
      await moduleSnapshotStore.deleteAllForStream(input.featureId);
    } catch {
    }
  }

  return {
    success: true,
    data: {
      phase: 'completed',
      previousPhase: currentPhase,
      phaseAttemptId,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}
