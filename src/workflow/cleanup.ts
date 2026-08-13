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

// ─── Event-Sourcing Version Discriminator ───────────────────────────────────

const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

// ─── Module-Level SnapshotStore Configuration ────────────────────────────────

let moduleSnapshotStore: SnapshotStore | null = null;

/** Configure the SnapshotStore instance used by cleanup handlers. */
export function configureCleanupSnapshotStore(store: SnapshotStore | null): void {
  moduleSnapshotStore = store;
}

// ─── Event-First Emission ───────────────────────────────────────────────────

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
 * Emit cleanup events to the event store (v2 event-first contract).
 *
 * Events are emitted in order:
 * 1. `state.patched` — synthesis/review backfill (if applicable)
 * 2. `workflow.cleanup` — HSM transition events with idempotency keys
 * 3. `workflow.cleanup` — explicit cleanup completion event
 *
 * DR-7 (INV-9), third criterion — the whole trail commits in ONE atomic
 * transaction via `EventStore.appendTrailAtomically`. Previously these were
 * three sequential `append` calls, so a failure after event k left a PARTIAL
 * trail durably on the stream (characterized: injecting a failure on the
 * second append left exactly `["state.patched"]` behind, a half-written phase
 * mutation). Now the stream ends up with either the complete trail or nothing.
 *
 * @throws Error if the atomic append fails (caller aborts the state write)
 */
async function emitCleanupEvents(
  store: EventStore,
  payload: CleanupEventPayload,
): Promise<void> {
  const { featureId, currentPhase } = payload;
  const trail: Array<
    Parameters<EventStore['appendTrailAtomically']>[1][number]
  > = [];

  // 1. state.patched for backfilled fields
  const backfillPatch: Record<string, unknown> = {};
  if (payload.hasSynthesisBackfill) {
    backfillPatch.synthesis = payload.synthesis;
    backfillPatch.artifacts = payload.artifacts;
  }
  // DR-8: there is no `reviews` member here any more. Cleanup used to patch
  // `reviews` because it had just force-approved them; with the pass-state fix
  // retired, reviews are read-only evidence and there is nothing to backfill.
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

  // 2. Transition events with idempotency keys
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

  // 3. workflow.cleanup completion event
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
      // DR-8: recorded from the collected evidence, never a hard-coded literal.
      mergeVerified: payload.mergeVerified,
      mergeArtifact: payload.mergeArtifact,
      prUrl: payload.prUrl,
      mergedBranches: payload.mergedBranches,
    },
    idempotencyKey: `${featureId}:cleanup:complete`,
  });

  // `phaseAttemptId` is retry-stable (derived from the predecessor attempt),
  // so the operation id is stable across retries of the SAME cleanup.
  await store.appendTrailAtomically(
    featureId,
    trail,
    `cleanup:${featureId}:${payload.phaseAttemptId}`,
  );
}

// ─── Guarded-primitive error mapping ────────────────────────────────────────

/**
 * Map a `HSMTransitionGuard` failure code onto the MCP `ErrorCode` surface.
 * The primitive preserves CIRCUIT_OPEN / PHASE_BLOCKED as distinct codes
 * rather than collapsing them into GUARD_FAILED; that distinction must survive
 * the hop into cleanup's `ToolResult` (a substrate-integrity failure must not
 * masquerade as a generic guard fault).
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

// ─── V1 Legacy Event Emission ───────────────────────────────────────────────

/**
 * Emit transition events after state write (v1 legacy best-effort).
 * Failures are silently swallowed — state is already written.
 *
 * DR-7: still ONE atomic trail, so even the best-effort legacy path cannot
 * leave a half-written lifecycle trail behind.
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
    // V1 legacy: external store is supplementary; append failure must not break cleanup
  }
}

// ─── DR-8: cleanup evidence collection (replaces the pass-state fix) ────────

/**
 * What cleanup can PROVE about the merge, read out of the workflow state.
 *
 * DR-8 retires the `pass-state-fix` class for cleanup: production code must not
 * write the fields the guard reads. This collector is strictly read-only — it
 * never touches `state` — and its verdict is what cleanup hands to
 * `guards.mergeVerified` via the guarded primitive. Absent evidence therefore
 * FAILS the guard instead of manufacturing a pass.
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

/**
 * Read the first usable artifact reference out of a state field.
 *
 * Mirrors the DR-5 / T-08 discipline: an artifact reference is a non-empty
 * TRIMMED string (or the first such string in a list). `''`, `'   '`, `[]` and
 * non-strings are not references.
 */
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
 * Collect the evidence that a merge was actually verified.
 *
 * Two independent requirements, both read from state:
 *
 *  1. **Reviews that were actually approved.** Every review entry carrying a
 *     `status` (and every nested sub-review carrying one) must already read
 *     `'approved'`. Cleanup no longer rewrites them.
 *  2. **A merge that was actually recorded.** A typed artifact reference must
 *     exist under `synthesis.prUrl`, `artifacts.pr` or `synthesis.mergedBranches`.
 *     A bare `mergeVerified: true` boolean from the caller is an assertion, not
 *     evidence, and no longer suffices on its own.
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

  // ─── DR-8: the guard's inputs are EVIDENCE, never force-written ───────
  //
  // Characterized behaviour this replaces (the `pass-state-fix` class named in
  // `retirement/retirement-safety.ts`): cleanup walked `state.reviews` and
  // force-assigned `entry.status = 'approved'` (including nested sub-reviews),
  // then stamped `_cleanup = { mergeVerified: true }` — literally writing the
  // inputs of `guards.mergeVerified` on the line before asking it for
  // permission. Measured: `{ 't1': { status: 'needs_fixes' },
  // 't2': { specReview: { status: 'fail' } } }` came out of cleanup with every
  // status rewritten to `approved` and the phase advanced to `completed`. The
  // guard could not fail; it was decoration.
  //
  // Now cleanup READS the evidence and hands the guard the verdict that
  // evidence supports. Reviews are never rewritten, and when the evidence is
  // absent `mergeVerified` is FALSE, so the guarded primitive rejects the
  // transition instead of rubber-stamping it.
  //
  // T-12: the evidence is collected from the state AS THIS CALL FOUND IT —
  // strictly BEFORE `input.prUrl` / `input.mergedBranches` are backfilled onto
  // it. The prior order wrote the caller's own `prUrl` into `synthesis.prUrl` /
  // `artifacts.pr` and then read exactly those fields back as the merge
  // artifact, so `cleanup({ mergeVerified: true, prUrl: 'anything' })`
  // satisfied the merge arm with an unverified same-call assertion — the
  // pass-state fix reborn one level up. The input fields are now strictly
  // POST-GUARD metadata backfill (applied in the mutations section below).
  const evidence = collectCleanupEvidence(mutableState);
  mutableState._cleanup = { mergeVerified: evidence.verified };

  // ─── HSM transition — the SINGLE guarded primitive (DR-7 / INV-9) ─────
  //
  // Characterized bypass this replaces: cleanup called `executeTransition`
  // directly (cleanup.ts:303), so the phase mutation ran with NO guard
  // dispatch and NO shadow observation — `hsmTransitionGuard.attempt` was
  // called zero times on the cleanup path. `handleSet` was the only phase
  // mutation the primitive saw.
  //
  // Now the decision is the primitive's. `eventStore: null` puts it in its
  // documented pure-evaluation mode: it decides and shadow-observes, and this
  // handler keeps ownership of emission so the whole cleanup trail
  // (state.patched + lifecycle + completion) commits in ONE atomic
  // transaction — the third DR-7 criterion, which per-event emission inside
  // the primitive cannot give (its own docs note compound siblings are
  // sequenced independently).
  //
  // `allowUniversalFinalTransition` is why the bypass existed: `completed` is
  // a universal final edge with no explicit HSM definition, so the primitive's
  // Step-1 lookup used to reject it outright.

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
      // The SAME live shadow observer `tools.ts` wires onto the guarded
      // transition path, so cleanup's phase mutation is observed identically
      // to every other one. DR-23 / T-31: the guard context is in
      // pure-evaluation mode (`eventStore: null`) because THIS handler owns
      // authoritative emission — the non-authoritative shadow evidence is
      // still durable, via this handler's real store.
      shadowObserver: (observation) =>
        recordLiveTransition(observation, mutableState, eventStore),
    },
  );

  if (!attempt.ok) {
    // DR-8: when the EVIDENCE was insufficient, the failure is a guard failure
    // and must be reported as one. `guards.mergeVerified` denying the universal
    // cleanup edge makes `executeTransition` fall through to the ordinary
    // transition lookup, which then reports INVALID_TRANSITION — a downstream
    // artefact of the guard denial, not the cause. Report the cause, and name
    // the evidence the caller must actually produce (never have cleanup write).
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

  // Backfill synthesis metadata — POST-GUARD on purpose (T-12). The guard's
  // verdict above was derived from pre-existing evidence only; these input
  // fields are recorded as metadata on the admitted transition and can no
  // longer feed the evidence collection that admitted it.
  const synthesis = (mutableState.synthesis ?? {}) as Record<string, unknown>;
  if (input.prUrl !== undefined) {
    synthesis.prUrl = input.prUrl;
  }
  if (input.mergedBranches !== undefined) {
    synthesis.mergedBranches = input.mergedBranches;
  }
  mutableState.synthesis = synthesis;

  // Also mirror onto artifacts.pr for consumers that read there
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

  // ─── Event emission + state write ─────────────────────────────────────

  // Same nullish trap as `cancel.ts`: `!== null` does not exclude `undefined`,
  // and the block below needs a definite store. Narrowing into a local binds
  // the proof for the checker instead of re-asserting at each use.
  const eventFirstStore =
    isEventSourced(state) && eventStore !== null && eventStore !== undefined
      ? eventStore
      : undefined;
  const useEventFirst = eventFirstStore !== undefined;

  if (eventFirstStore !== undefined && phaseAttemptId !== undefined) {
    // ES v2: emit events BEFORE writing state
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

  // Write state file (after events for v2, as primary store for v1)
  await writeStateFile(stateFile, mutableState as WorkflowState);

  // V1 legacy: best-effort event emission AFTER state write
  if (!useEventFirst && eventStore) {
    await emitLegacyTransitionEvents(
      eventStore,
      input.featureId,
      `cleanup:legacy:${input.featureId}:${phaseAttemptId ?? currentPhase}`,
      attempt.emittedEvents,
    );
  }

  // Clean up derived snapshot files (best-effort — failures do not block cleanup)
  if (moduleSnapshotStore) {
    try {
      await moduleSnapshotStore.deleteAllForStream(input.featureId);
    } catch {
      // Snapshot files are derived artifacts; deletion failure is non-critical
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
