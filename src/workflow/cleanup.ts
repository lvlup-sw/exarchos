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
import { decide } from './decide/decide.js';
import { compileDecideDefinition, type DecideDefinition } from './decide/edges.js';
import { phaseMoveEvents, type TransitionEvent } from './decide/emit.js';
import { builtInDefinition, isBuiltInDefinitionType } from './definitions/built-in.js';
import type { EventStore } from '../events/store.js';
import type { EventType, WorkflowEvent } from '../events/schemas.js';
import { foldGuardInput } from '../projections/guard-input/fold.js';
import {
  recordGuardInputShadow,
  runGuardInputShadow,
  type GuardInputShadowRun,
  type GuardInputShadowSink,
} from '../projections/guard-input/shadow.js';
import type { SnapshotStore } from '../projections/views/snapshot-store.js';
import type { ToolResult } from '../format.js';
import * as path from 'node:path';

/** The `_esVersion` of a workflow on the pure event-sourcing path. */
const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

/** The type of the row that starts a workflow stream. */
const START_ROW_TYPE = 'workflow.started';

/** The text that starts the warning of a cleanup that the state document decided. */
const DOCUMENT_FALLBACK_WARNING = 'GUARD_INPUT_DOCUMENT_FALLBACK';

/**
 * The route of one cleanup. The fold route decides on the ledger fold of the rows of a built-in type.
 * The fold-failed route refuses after the checks of the document. The document route keeps the path of
 * the state document, with the warnings of a fallback.
 */
type CleanupRoute =
  | {
      readonly kind: 'fold';
      readonly def: DecideDefinition;
      /** The guard input of the fold, with no cleanup evidence and no phase attempt id. */
      readonly input: Readonly<Record<string, unknown>>;
      readonly from: string;
      /** The phase attempt id of the fold, the predecessor of the move. */
      readonly foldAttemptId: string | undefined;
      /** The highest sequence of the rows. */
      readonly version: number;
    }
  | { readonly kind: 'fold-failed'; readonly message: string }
  | { readonly kind: 'document'; readonly warnings: readonly string[] };

/** The rows of the stream, or the error of a failed read. With no event store, both are absent. */
interface StreamRead {
  readonly rows?: readonly WorkflowEvent[];
  readonly error?: unknown;
}

/** Returns the message of a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns the highest sequence of the rows, or 0 when the rows are empty. */
function highestSequence(rows: readonly WorkflowEvent[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sequence), 0);
}

/** Reads the rows of the stream once. The decide and the guard-input shadow both read them. */
async function readStream(eventStore: EventStore | null, featureId: string): Promise<StreamRead> {
  if (!eventStore) return {};
  try {
    return { rows: await eventStore.query(featureId) };
  } catch (err) {
    return { error: err };
  }
}

/** Returns the document route with one fallback warning that names the reason. */
function documentFallback(reason: string): CleanupRoute {
  return {
    kind: 'document',
    warnings: [`${DOCUMENT_FALLBACK_WARNING}: the state document decided this cleanup, because ${reason}.`],
  };
}

/**
 * Picks the route of a cleanup. A type that is not a built-in type keeps the document route with no warning.
 * A built-in type decides on the fold when the store holds its rows: an event store, a document on the ledger and a start row.
 * Otherwise the document decides, and the route carries one fallback warning. A failed read or fold of the rows refuses.
 */
function cleanupRouteOf(state: WorkflowState, eventStore: EventStore | null, read: StreamRead): CleanupRoute {
  const workflowType = state.workflowType;
  if (!isBuiltInDefinitionType(workflowType)) return { kind: 'document', warnings: [] };
  if (eventStore === null || eventStore === undefined) return documentFallback('no event store is open');
  if (state._esVersion !== CURRENT_ES_VERSION) return documentFallback('the state document is not on the ledger');
  const rows = read.rows;
  if (rows === undefined) return { kind: 'fold-failed', message: `the rows could not be read: ${messageOf(read.error)}` };
  if (!rows.some((row) => row.type === START_ROW_TYPE)) return documentFallback('the stream holds no start row');
  try {
    const input = foldGuardInput(rows);
    return {
      kind: 'fold',
      def: compileDecideDefinition(workflowType, builtInDefinition(workflowType), []),
      input,
      from: typeof input.phase === 'string' ? input.phase : '',
      foldAttemptId: readPhaseAttemptId(input),
      version: highestSequence(rows),
    };
  } catch (err) {
    return { kind: 'fold-failed', message: messageOf(err) };
  }
}

/** Puts the warnings of a route before the warnings of a result. A route with no warning returns the result unchanged. */
function withRouteWarnings(result: ToolResult, route: CleanupRoute): ToolResult {
  if (route.kind !== 'document' || route.warnings.length === 0) return result;
  return { ...result, warnings: [...route.warnings, ...(result.warnings ?? [])] };
}

/** The events of an admitted cleanup move and the history that the move records. */
interface CleanupMove {
  readonly events: readonly TransitionEvent[];
  readonly historyUpdates: Readonly<Record<string, string>>;
}

/** The outcome of the decide of a cleanup: the move, or the error of a refusal. */
type CleanupDecision =
  | { readonly ok: true; readonly move: CleanupMove }
  | { readonly ok: false; readonly error: NonNullable<ToolResult['error']> };

/**
 * Decides the cleanup move on the fold. The legacy guard runs on the same input with no store, so it feeds
 * only the admission live shadow and the message of a refusal. A throw of the legacy guard changes nothing.
 * A refusal with insufficient evidence names the evidence, as the path of the document does.
 */
async function decideCleanupOnTheFold(
  featureId: string,
  route: Extract<CleanupRoute, { kind: 'fold' }>,
  input: Record<string, unknown>,
  evidence: CleanupEvidence,
  eventStore: EventStore | null,
): Promise<CleanupDecision> {
  let legacyError: NonNullable<ToolResult['error']> | undefined;
  try {
    const legacy = await hsmTransitionGuard.attempt(featureId, route.from, 'completed', {
      state: input,
      workflowType: route.def.workflowType,
      eventStore: null,
      allowUniversalFinalTransition: true,
      shadowObserver: (observation) => recordLiveTransition(observation, input, eventStore),
    });
    if (!legacy.ok) legacyError = { code: mapAttemptErrorCode(legacy.errorCode), message: legacy.errorMessage };
  } catch {
    legacyError = undefined;
  }
  const outcome = decide(route.def, input, { kind: 'cleanup' });
  if (outcome.kind === 'admit') {
    const moved = phaseMoveEvents(route.def, input, outcome.move);
    if (moved.success) {
      return { ok: true, move: { events: moved.events, historyUpdates: { ...(moved.historyUpdates ?? {}) } } };
    }
    return {
      ok: false,
      error: {
        code: moved.errorCode === 'CIRCUIT_OPEN' ? ErrorCode.CIRCUIT_OPEN : moved.errorCode === 'PHASE_BLOCKED' ? ErrorCode.PHASE_BLOCKED : ErrorCode.GUARD_FAILED,
        message: moved.errorMessage ?? `The cleanup of '${featureId}' did not move the phase`,
      },
    };
  }
  if (!evidence.verified) {
    return {
      ok: false,
      error: {
        code: ErrorCode.GUARD_FAILED,
        message: `Cleanup guard 'merge-verified' failed — cleanup evidence insufficient: ${evidence.reasons.join('; ')}`,
      },
    };
  }
  if (legacyError !== undefined) return { ok: false, error: legacyError };
  return {
    ok: false,
    error: {
      code: outcome.kind === 'deny' ? ErrorCode.GUARD_FAILED : ErrorCode.INVALID_TRANSITION,
      message: `No cleanup move from '${route.from}' to 'completed' admits`,
    },
  };
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
 * It returns false when a stored claim of that operation answered the append, so this call wrote no row.
 *
 * @throws When the atomic append fails. The caller then does not write the state.
 */
async function emitCleanupEvents(
  store: EventStore,
  payload: CleanupEventPayload,
): Promise<boolean> {
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

  return store.appendTrailAtomically(
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
 * Record the guard-input shadow run of the cleanup after the decision, and add its warnings to the result.
 * Each exit after the guard calls it. The success calls it before the state write, so a throw of that write follows the record.
 * The document side of the run keeps the stored `_events`, because the cleanup guard reads that list.
 * A cleanup with no run returns the result unchanged.
 */
async function withShadowRecord(
  result: ToolResult,
  run: GuardInputShadowRun | undefined,
  sink: GuardInputShadowSink,
): Promise<ToolResult> {
  const warnings = await recordGuardInputShadow(run, sink);
  if (warnings.length === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
}

/**
 * Clean up a workflow by moving it to `completed`. The merge guard reads the evidence before the backfill of
 * `prUrl` and `mergedBranches`. Insufficient evidence gives `GUARD_FAILED`, not `INVALID_TRANSITION`.
 *
 * A built-in type with a store, a ledger document and a start row decides on the ledger fold.
 * The fold gives the source phase, the attempt id, the terminal checks, the guard events and the merge evidence.
 * A fold that throws refuses with `PROJECTION_REPLAY_FAILED`. The fallback cases keep the document path with one warning.
 *
 * An event-sourced workflow with a store appends the whole trail before the state write. Otherwise cleanup writes
 * the state first and emits the events on a best-effort basis. A failed snapshot deletion does not fail cleanup.
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

  const read = await readStream(eventStore, input.featureId);
  const route = cleanupRouteOf(state, eventStore, read);
  const outcome = await cleanupOnRoute(input, stateDir, eventStore, stateFile, state, read, route);
  if (!isTrailClaimHit(outcome)) return withRouteWarnings(outcome, route);
  return cleanupAfterAClaimHit(input, stateDir, eventStore, stateFile);
}

/** The outcome of a cleanup whose trail operation another call committed. This call wrote no row. */
interface TrailClaimHit {
  readonly claimHit: true;
}

/** True when the outcome of a cleanup is a claim hit of its trail operation. */
function isTrailClaimHit(outcome: ToolResult | TrailClaimHit): outcome is TrailClaimHit {
  return 'claimHit' in outcome && outcome.claimHit === true;
}

/**
 * Replies to a cleanup whose trail operation another call committed. This call wrote no row and no document.
 * It reads the document and the rows again and runs the cleanup once more. A fold at `completed` then refuses
 * with `ALREADY_COMPLETED`. A second claim hit refuses with `EVENT_APPEND_FAILED`.
 */
async function cleanupAfterAClaimHit(
  input: CleanupInput,
  stateDir: string,
  eventStore: EventStore | null,
  stateFile: string,
): Promise<ToolResult> {
  const state = await readStateFile(stateFile);
  const read = await readStream(eventStore, input.featureId);
  const route = cleanupRouteOf(state, eventStore, read);
  const outcome = await cleanupOnRoute(input, stateDir, eventStore, stateFile, state, read, route);
  if (!isTrailClaimHit(outcome)) return withRouteWarnings(outcome, route);
  return {
    success: false,
    error: {
      code: ErrorCode.EVENT_APPEND_FAILED,
      message: `Another call committed the cleanup trail of '${input.featureId}', and a second read of the rows does not show the phase 'completed'`,
    },
  };
}

/**
 * Runs one cleanup on its route. The caller adds the warnings of the route.
 * On the fold route, a stored claim of the trail operation gives a claim hit, and this call writes no document.
 */
async function cleanupOnRoute(
  input: CleanupInput,
  stateDir: string,
  eventStore: EventStore | null,
  stateFile: string,
  state: WorkflowState,
  read: StreamRead,
  route: CleanupRoute,
): Promise<ToolResult | TrailClaimHit> {
  const terminalPhase = route.kind === 'fold' ? route.from : state.phase;
  if (terminalPhase === 'completed') {
    return {
      success: false,
      error: {
        code: ErrorCode.ALREADY_COMPLETED,
        message: `Workflow '${input.featureId}' is already completed`,
      },
    };
  }

  if (terminalPhase === 'cancelled') {
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
  const currentPhase = route.kind === 'fold' ? route.from : state.phase;
  const dryRun = input.dryRun ?? false;

  const documentEvidence = collectCleanupEvidence(mutableState);
  mutableState._cleanup = { mergeVerified: documentEvidence.verified };

  const phaseAttemptId = dryRun
    ? undefined
    : allocatePhaseAttemptId(
        input.featureId,
        currentPhase,
        'completed',
        route.kind === 'fold' ? route.foldAttemptId : readPhaseAttemptId(state),
        route.kind === 'fold' ? route.version : (state._version ?? 1),
      );
  if (phaseAttemptId !== undefined) {
    mutableState._pendingPhaseAttemptId = phaseAttemptId;
  }

  const shadowRun = runGuardInputShadow({
    call: 'cleanup',
    featureId: input.featureId,
    target: 'completed',
    hasUpdates: false,
    document: mutableState,
    rows: read.rows,
    pass: 0,
    fold: { cleanupEvidence: (folded) => collectCleanupEvidence(folded).verified },
  });
  const shadowSink: GuardInputShadowSink = { stateDir };

  if (route.kind === 'fold-failed') {
    return withShadowRecord({
      success: false,
      error: {
        code: ErrorCode.PROJECTION_REPLAY_FAILED,
        message: `The ledger fold of '${input.featureId}' failed, so no guard decided: ${route.message}`,
      },
    }, shadowRun, shadowSink);
  }

  let evidence = documentEvidence;
  let move: CleanupMove;
  if (route.kind === 'fold') {
    evidence = collectCleanupEvidence(route.input);
    const foldInput: Record<string, unknown> = {
      ...route.input,
      _cleanup: { mergeVerified: evidence.verified },
      ...(phaseAttemptId === undefined ? {} : { _pendingPhaseAttemptId: phaseAttemptId }),
    };
    const decided = await decideCleanupOnTheFold(input.featureId, route, foldInput, evidence, eventStore);
    if (!decided.ok) return withShadowRecord({ success: false, error: decided.error }, shadowRun, shadowSink);
    move = decided.move;
  } else {
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
        return withShadowRecord({
          success: false,
          error: {
            code: ErrorCode.GUARD_FAILED,
            message: `Cleanup guard 'merge-verified' failed — cleanup evidence insufficient: ${evidence.reasons.join('; ')}`,
          },
        }, shadowRun, shadowSink);
      }
      return withShadowRecord({
        success: false,
        error: {
          code: mapAttemptErrorCode(attempt.errorCode),
          message: attempt.errorMessage,
        },
      }, shadowRun, shadowSink);
    }
    move = { events: attempt.emittedEvents, historyUpdates: attempt.historyUpdates };
  }

  if (dryRun) {
    return withShadowRecord({
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
    }, shadowRun, { stateDir, writeLine: false });
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

  if (Object.keys(move.historyUpdates).length > 0) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(move.historyUpdates)) {
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
      const landed = await emitCleanupEvents(eventFirstStore, {
        featureId: input.featureId,
        currentPhase,
        synthesis,
        artifacts,
        hasSynthesisBackfill: input.prUrl !== undefined || input.mergedBranches !== undefined,
        mergeVerified: evidence.verified,
        mergeArtifact: evidence.mergeArtifact,
        transitionEvents: move.events,
        prUrl: input.prUrl,
        mergedBranches: input.mergedBranches,
        phaseAttemptId,
      });
      if (route.kind === 'fold' && landed === false) return { claimHit: true };
    } catch (err) {
      return withShadowRecord({
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Event append failed during cleanup: ${err instanceof Error ? err.message : String(err)}`,
        },
      }, shadowRun, shadowSink);
    }
  }

  const completed = await withShadowRecord({
    success: true,
    data: {
      phase: 'completed',
      previousPhase: currentPhase,
      phaseAttemptId,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  }, shadowRun, shadowSink);

  await writeStateFile(stateFile, mutableState as WorkflowState);

  if (!useEventFirst && eventStore) {
    await emitLegacyTransitionEvents(
      eventStore,
      input.featureId,
      `cleanup:legacy:${input.featureId}:${phaseAttemptId ?? currentPhase}`,
      move.events,
    );
  }

  if (moduleSnapshotStore) {
    try {
      await moduleSnapshotStore.deleteAllForStream(input.featureId);
    } catch {
    }
  }

  return completed;
}
