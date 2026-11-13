import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { stampFromAmbient } from '../../dispatch/core/outer-correlation.js';
import { OperationDigestMismatchError, type DecideOnceStoredEvent } from '../../events/atomic-appender.js';
import { buildEvent, buildValidatedEvent } from '../../events/event-factory.js';
import { migrateEvents } from '../../events/event-migration.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { SequenceConflictError, type EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { workflowLogger } from '../../logger.js';
import { injectGuardConfig } from '../../projections/guard-input/config.js';
import { foldGuardInput, foldWorkflowState } from '../../projections/guard-input/fold.js';
import { toGuardEvents } from '../../projections/guard-input/guard-events.js';
import { recordGuardInputShadow, runGuardInputShadow, type GuardInputShadowRun } from '../../projections/guard-input/shadow.js';
import { recordLiveTransition } from '../admission/live-shadow-observer.js';
import { buildCheckpointMeta, type CheckpointEnforcementConfig, incrementOperations, resetCounter, shouldEnforceCheckpoint } from '../checkpoint.js';
import { decide, validTargetsOf, type DecideOutcome } from '../decide/decide.js';
import { compileDecideDefinition, type DecideDefinition, type DecideEdge, type UniversalMove } from '../decide/edges.js';
import { denialEvents, frozenFloorOf, mergeFloors, phaseMoveEvents, statedCoordinate, type TransitionObligationFloor, type TransitionResult as MoveResult } from '../decide/emit.js';
import { phaseRowsOf, type PhaseRow } from '../decide/rows.js';
import { builtInDefinition, isBuiltInDefinitionType } from '../definitions/built-in.js';
import { hsmTransitionGuard, type TransitionResult as LegacyResult } from '../hsm-transition-guard.js';
import { allocatePhaseAttemptId, readPhaseAttemptId } from '../phase-attempt-id.js';
import { ErrorCode, WorkflowStateSchema } from '../schemas.js';
import { applyDotPath, projectStateDocument, levelPhaseInStateDocument, readStateFile, StateStoreError, validateStateForWrite, VersionConflictError, writeStateFile } from '../state-store.js';
import type { SetInput, WorkflowState } from '../types.js';
import { CURRENT_ES_VERSION, isEventSourced } from './shared.js';

/**
 * The CAS retry limit. A retry re-reads the state and gets a new `expectedVersion`.
 * A committed patch keeps its sequence across retries, so a document conflict appends no duplicate patch.
 * After the last retry, the handler appends `workflow.cas-failed` to an event store on a best-effort basis and rethrows.
 * The same limit bounds the passes whose reads change before the commit of a move.
 */
const MAX_CAS_RETRIES = 3;

/** The type of the row that starts a workflow stream. */
const START_ROW_TYPE = 'workflow.started';

/** The text that starts the warning of a transition that the state document decided. */
const DOCUMENT_FALLBACK_WARNING = 'GUARD_INPUT_DOCUMENT_FALLBACK';

/** The handler options of a phase transition. */
interface SetOptions {
  skipPhases?: readonly string[];
  /**
   * The review dimensions for the `allReviewsPassed` guard. An explicit value, even `[]`, wins.
   * Without it, the handler uses the REVIEW gate set for the workflow type and the risk tier of the updated state.
   */
  requiredReviews?: readonly string[];
  /**
   * When set, a phase transition above the checkpoint threshold returns `CHECKPOINT_REQUIRED`.
   * The handler appends `checkpoint.enforced` or `checkpoint.state_missing` to an event store on a best-effort basis.
   */
  checkpoint?: CheckpointEnforcementConfig;
  /**
   * The plan-revision cap for the pure `revisionsExhausted` guard.
   * The handler injects it as `_maxPlanRevisions` and deletes it before the write.
   * A config threshold is not a fact, so the handler does not persist it.
   */
  maxPlanRevisions?: number;
  /**
   * The mutation enforcement mode and threshold for the score check of `allReviewsPassed`.
   * The handler injects them at high risk tier only, and deletes them before the write.
   */
  mutationEnforcement?: 'block' | 'advisory';
  mutationThreshold?: number;
  /**
   * The NoCoverage budget for `allReviewsPassed`. The handler injects it at high risk tier only.
   * It injects only a non-negative integer, and deletes it before the write.
   */
  maxNoCoverage?: number;
}

/** The pass of a commit whose reads changed. The handler reads again and decides again. */
class TransitionReadsChanged extends Error {
  constructor(featureId: string, target: string) {
    super(`the reads of the transition of '${featureId}' to '${target}' changed before the commit`);
    this.name = 'TransitionReadsChanged';
  }
}

/** The fold of the rows inside a commit threw. The commit writes nothing. */
class TransitionFoldFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionFoldFailed';
  }
}

/** Validates the raw pending patch over the complete ledger and the document's operational roots. */
function validatePatchCandidate(state: WorkflowState, rows: readonly WorkflowEvent[], featureId: string, updates: Record<string, unknown> | undefined): void {
  const pending = pendingPatchRow(featureId, updates, rows);
  if (pending === undefined) return;
  try {
    projectStateDocument(state, [...rows, pending], featureId);
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT) throw err;
    throw new TransitionFoldFailed(messageOf(err));
  }
}

/** The move that this call committed. The claim of the operation stores it. */
interface CommittedMove {
  readonly newPhase: string;
  readonly phaseAttemptId: string;
  readonly historyUpdates: Readonly<Record<string, string>>;
  readonly eventSequence: number;
}

/** The ledger read of one pass: the rows, the fold before the updates of the call, and the guard input. */
interface FoldRead {
  readonly rows: readonly WorkflowEvent[];
  /** The fold of the rows, with no pending row and no config. The floor reads its coordinate. */
  readonly prior: Readonly<Record<string, unknown>>;
  /** The guard input: the fold of the rows and of the pending patch row, with the config and the attempt id. */
  readonly input: Record<string, unknown>;
  readonly from: string;
  /** The phase attempt id of the fold, the predecessor of a move. */
  readonly foldAttemptId: string | undefined;
  /** The phase attempt id of a move. A target equal to the fold phase gets none. */
  readonly attemptId: string | undefined;
  /** The highest sequence of the rows. */
  readonly version: number;
}

/** The route of one pass: the decide on the fold, or the legacy guard on the state document. */
type TransitionRoute =
  | { readonly kind: 'fold'; readonly workflowType: Parameters<typeof builtInDefinition>[0] }
  | { readonly kind: 'legacy'; readonly warnings: readonly string[] };

/**
 * Records the guard-input shadow run of a pass after the decision, and adds its warnings to the result.
 * The route warnings come first. A pass with no run and no route warning returns the result unchanged.
 */
async function withShadowRecord(
  result: ToolResult,
  run: GuardInputShadowRun | undefined,
  stateDir: string,
  routeWarnings: readonly string[] = [],
): Promise<ToolResult> {
  const warnings = [...routeWarnings, ...(await recordGuardInputShadow(run, { stateDir }))];
  if (warnings.length === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
}

/** Returns the message of a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns the highest sequence of the rows, or 0 when the rows are empty. */
function highestSequence(rows: readonly WorkflowEvent[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sequence), 0);
}

/**
 * Picks the route of a transition. A type that is not a built-in type keeps the legacy guard with no warning.
 * A built-in type decides on the fold when the store holds its rows: an event store, a document on the ledger and a start row.
 * Otherwise the legacy guard decides on the document, and the result carries one fallback warning.
 */
function routeOf(state: WorkflowState, eventStore: EventStore | null, rows: readonly WorkflowEvent[] | undefined): TransitionRoute {
  const workflowType = state.workflowType;
  if (!isBuiltInDefinitionType(workflowType)) return { kind: 'legacy', warnings: [] };
  let reason: string | undefined;
  if (eventStore === null) reason = 'no event store is open';
  else if (state._esVersion !== CURRENT_ES_VERSION) reason = 'the state document is not on the ledger';
  else if (rows !== undefined && !rows.some((row) => row.type === START_ROW_TYPE)) reason = 'the stream holds no start row';
  if (reason === undefined) return { kind: 'fold', workflowType };
  return {
    kind: 'legacy',
    warnings: [`${DOCUMENT_FALLBACK_WARNING}: the state document decided this transition, because ${reason}.`],
  };
}

/** Returns the in-memory `state.patched` row of the updates of a call, after the last row. No updates give no row. */
function pendingPatchRow(
  featureId: string,
  updates: Record<string, unknown> | undefined,
  rows: readonly WorkflowEvent[],
): WorkflowEvent | undefined {
  if (updates === undefined || Object.keys(updates).length === 0) return undefined;
  return buildEvent(featureId, highestSequence(rows) + 1, {
    type: 'state.patched',
    data: { featureId, fields: Object.keys(updates), patch: updates },
  });
}

/**
 * Folds the rows of one pass. The updates of the call fold as a pending `state.patched` row before the task overlay,
 * so a status inside the updates gives no status. The fold allocates the phase attempt id of a move over the fold phase,
 * the fold attempt id and the highest sequence. A fixed id, from the outer read, replaces the allocation.
 * @throws When the fold of the rows throws.
 */
function foldRead(
  featureId: string,
  target: string,
  rows: readonly WorkflowEvent[],
  updates: Record<string, unknown> | undefined,
  options: SetOptions | undefined,
  fixedAttemptId?: string,
): FoldRead {
  const prior: Readonly<Record<string, unknown>> = { ...foldWorkflowState(rows) };
  const from = typeof prior.phase === 'string' ? prior.phase : '';
  const foldAttemptId = readPhaseAttemptId(prior);
  const version = highestSequence(rows);
  const attemptId =
    from === target ? undefined : (fixedAttemptId ?? allocatePhaseAttemptId(featureId, from, target, foldAttemptId, version));
  const pending = pendingPatchRow(featureId, updates, rows);
  const input: Record<string, unknown> = {
    ...foldGuardInput(pending === undefined ? rows : [...rows, pending], {
      config: options ?? {},
      ...(attemptId === undefined ? {} : { ephemerals: { _pendingPhaseAttemptId: attemptId } }),
    }),
  };
  return { rows, prior, input, from, foldAttemptId, attemptId, version };
}

/** Returns the floor of a move: the coordinate of the fold before the updates, and the gates that the target froze. */
function floorOf(read: FoldRead, target: string): TransitionObligationFloor | undefined {
  const priorCoordinate = statedCoordinate(read.prior);
  return mergeFloors([
    priorCoordinate === null ? null : { coordinates: [priorCoordinate] },
    frozenFloorOf(read.rows, target),
  ]);
}

/** Returns a key that names one move, so the decide inside the commit can check that it chose the same move. */
function moveKeyOf(move: DecideEdge | UniversalMove): string {
  return move.edgeKind === 'explicit' ? `explicit:${move.transitionId}` : `${move.edgeKind}:${move.to}`;
}

/** Returns the guard of a move for its rows. Only an explicit edge names a guard. */
function guardIdOf(move: DecideEdge | UniversalMove): string | undefined {
  return move.edgeKind === 'explicit' ? move.guardId : undefined;
}

/** Returns a stored row of a commit snapshot as a workflow event. The fold reads only the identity, the type and the data. */
function workflowEventOf(stored: DecideOnceStoredEvent): WorkflowEvent {
  return {
    streamId: stored.streamId,
    sequence: stored.sequence,
    type: stored.type,
    timestamp: stored.timestamp,
    schemaVersion: typeof stored.schemaVersion === 'string' ? stored.schemaVersion : '1.0',
    ...(stored.data === undefined ? {} : { data: stored.data }),
  };
}

/** The request digest binds the source, target and combined patch, so a different patch cannot replay another claim. */
function requestDigestOf(featureId: string, from: string, target: string, updates?: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify({ featureId, from, to: target, updates })).digest('hex');
  return `sha256:${digest}`;
}

/** Appends the diagnostic rows of a refused move, one at a time, as the legacy guard does. */
async function appendDiagnosticRows(eventStore: EventStore, featureId: string, rows: readonly PhaseRow[]): Promise<void> {
  for (const row of rows) {
    await eventStore.appendValidated(featureId, buildValidatedEvent(featureId, 1, row));
  }
}

/** Returns the legacy outcome on the fold input. The attempt holds no store, so it appends nothing. A throw gives `undefined`. */
async function legacyOutcomeOf(
  featureId: string,
  read: FoldRead,
  target: string,
  workflowType: string,
  options: SetOptions | undefined,
  eventStore: EventStore,
): Promise<LegacyResult | undefined> {
  try {
    return await hsmTransitionGuard.attempt(featureId, read.from, target, {
      state: read.input,
      priorState: read.prior,
      workflowType,
      skipPhases: options?.skipPhases,
      eventStore: null,
      shadowObserver: (observation) => recordLiveTransition(observation, read.input, eventStore),
    });
  } catch {
    return undefined;
  }
}

/** Adds the valid targets of the fold phase to a failure. A phase with no valid target adds nothing. */
function withValidTargets(error: Record<string, unknown>, def: DecideDefinition, from: string): NonNullable<ToolResult['error']> {
  const validTargets = validTargetsOf(def, from);
  return {
    code: typeof error.code === 'string' ? error.code : ErrorCode.GUARD_FAILED,
    message: typeof error.message === 'string' ? error.message : '',
    ...error,
    ...(validTargets.length > 0 ? { validTargets } : {}),
  };
}

/**
 * Returns the error of a denied edge. When the legacy guard also denies with `GUARD_FAILED`, the error takes its message,
 * its `expectedShape` and its `suggestedFix`. Otherwise the error takes the decide shape, and the message names the false facts.
 */
function denialErrorOf(outcome: Extract<DecideOutcome, { kind: 'deny' }>, legacy: LegacyResult | undefined): Record<string, unknown> {
  if (legacy !== undefined && !legacy.ok && legacy.reason === 'guard-failed' && legacy.errorCode === 'GUARD_FAILED') {
    const failure = legacy.failures[0];
    return {
      code: ErrorCode.GUARD_FAILED,
      message: legacy.errorMessage,
      ...(failure?.expectedShape !== undefined ? { expectedShape: failure.expectedShape } : {}),
      ...(failure?.suggestedFix !== undefined ? { suggestedFix: failure.suggestedFix } : {}),
    };
  }
  const base = denialEvents(outcome.from, outcome.edge).errorMessage ?? `The edge '${outcome.edge.transitionId}' denied`;
  return {
    code: ErrorCode.GUARD_FAILED,
    message: `${base}. These facts are not true: ${outcome.verdict.falseFacts.join(', ')}.`,
    ...(Object.keys(outcome.expectedShape).length > 0 ? { expectedShape: outcome.expectedShape } : {}),
  };
}

/** The outcome of the decide section of one pass on the fold. */
type FoldPass =
  | { readonly kind: 'reply'; readonly result: ToolResult }
  | { readonly kind: 'reads-changed'; readonly patchSequence?: number }
  | { readonly kind: 'idempotent'; readonly read: FoldRead }
  | { readonly kind: 'moved'; readonly move: CommittedMove };

/** The inputs of the decide section of one pass on the fold. */
interface FoldPassInput {
  readonly featureId: string;
  readonly target: string;
  readonly updates: Record<string, unknown> | undefined;
  readonly workflowType: Parameters<typeof builtInDefinition>[0];
  readonly rows: readonly WorkflowEvent[];
  readonly options: SetOptions | undefined;
  readonly eventStore: EventStore;
  readonly state: WorkflowState;
}

/**
 * Decides one transition on the fold of the rows, and commits an admitted move through `decideOnce`.
 * The closure of the commit folds the snapshot rows and decides again. Another outcome makes the pass read again.
 * The rows of the move carry no idempotency key, because the operation claim keys the commit.
 *
 * A denial appends one `workflow.guard-failed` row. A refused move appends its diagnostic rows. A store fault writes no document.
 */
async function decideOnTheFold(pass: FoldPassInput): Promise<FoldPass> {
  const { featureId, target, updates, workflowType, rows, options, eventStore } = pass;
  let def: DecideDefinition;
  try {
    def = compileDecideDefinition(workflowType, builtInDefinition(workflowType), options?.skipPhases ?? []);
  } catch (err) {
    return reply({ code: ErrorCode.EVENT_APPEND_FAILED, message: `Event append failed: ${messageOf(err)}` });
  }
  let read: FoldRead;
  let outcome: DecideOutcome;
  try {
    read = foldRead(featureId, target, rows, updates, options);
    outcome = decide(def, read.input, { kind: 'transition', target });
  } catch (err) {
    return reply({
      code: ErrorCode.PROJECTION_REPLAY_FAILED,
      message: `The ledger fold of '${featureId}' failed, so no guard decided: ${messageOf(err)}`,
    });
  }
  try {
    if (read.attemptId !== undefined) {
      const replay = await replayClaim(pass, read);
      if (replay !== undefined) return replay;
    }
    if (outcome.kind !== 'idempotent') {
      try {
        validatePatchCandidate(pass.state, rows, featureId, updates);
      } catch (err) {
        if (err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT) {
          const replay = await replayClaim(pass, read);
          if (replay !== undefined) return replay;
          return reply({ code: ErrorCode.INVALID_INPUT, message: err.message });
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof OperationDigestMismatchError) throw err;
    return reply({ code: err instanceof TransitionFoldFailed ? ErrorCode.PROJECTION_REPLAY_FAILED : ErrorCode.EVENT_APPEND_FAILED,
      message: messageOf(err) });
  }
  const legacy = await legacyOutcomeOf(featureId, read, target, workflowType, options, eventStore);
  const { from } = read;
  switch (outcome.kind) {
    case 'idempotent':
      return { kind: 'idempotent', read };
    case 'no-edge':
      return reply(withValidTargets({ code: ErrorCode.INVALID_TRANSITION, message: `No transition from '${from}' to '${target}'` }, def, from));
    case 'stay':
      return reply(withValidTargets({ code: ErrorCode.INVALID_TRANSITION, message: `No transition from '${from}' to '${target}'` }, def, from));
    case 'deny': {
      try {
        const denial = denialEvents(from, outcome.edge);
        await appendDiagnosticRows(
          eventStore,
          featureId,
          phaseRowsOf(denial.events, featureId, { guardId: outcome.edge.guardId ?? outcome.edge.transitionId, rows }),
        );
      } catch (err) {
        return reply({ code: ErrorCode.EVENT_APPEND_FAILED, message: `Event append failed: ${messageOf(err)}` });
      }
      return reply(withValidTargets(denialErrorOf(outcome, legacy), def, from));
    }
    case 'admit':
      return commitMove(pass, def, read, outcome.move);
    default:
      return outcome satisfies never;
  }
}

/** Replays an actual held operation claim without validating its patch as a new write. */
async function replayClaim(pass: FoldPassInput, read: FoldRead): Promise<FoldPass | undefined> {
  if (read.attemptId === undefined) return undefined;
  const appender = pass.eventStore.getAppender();
  const operationId = `transition:${pass.featureId}:${read.attemptId}`;
  if (appender.ensureSqliteBackendSync().lookupOperationClaim(operationId) === undefined) return undefined;
  const committed = await appender.decideOnce<CommittedMove>(operationId,
    requestDigestOf(pass.featureId, read.from, pass.target, pass.updates), () => {
      throw new Error('A held operation claim disappeared');
    });
  return { kind: 'reads-changed', ...(pass.updates === undefined ? {} : { patchSequence: committed.eventSequence }) };
}

/** Returns a failure reply of the decide section. */
function reply(error: NonNullable<ToolResult['error']> | Record<string, unknown>): FoldPass {
  const code = typeof error.code === 'string' ? error.code : ErrorCode.GUARD_FAILED;
  const message = typeof error.message === 'string' ? error.message : '';
  return { kind: 'reply', result: { success: false, error: { ...error, code, message } } };
}

/**
 * Commits one admitted move. A refused move gives `CIRCUIT_OPEN` or `PHASE_BLOCKED` with its diagnostic rows, as the legacy guard does.
 * A changed read gives `reads-changed`. A fold that throws inside the commit gives `PROJECTION_REPLAY_FAILED`. Another store fault
 * gives `EVENT_APPEND_FAILED`. A digest mismatch of the operation keeps its own error.
 *
 * A stored claim of the same operation is the commit of another call, because the closure of this call did not run.
 * This call wrote no row, so it gives `reads-changed`. The next pass reads the rows of the other call and replies `idempotent: true`.
 */
async function commitMove(
  pass: FoldPassInput,
  def: DecideDefinition,
  read: FoldRead,
  move: DecideEdge | UniversalMove,
): Promise<FoldPass> {
  const { featureId, target, updates, options, eventStore } = pass;
  const attemptId = read.attemptId;
  const outer: MoveResult = phaseMoveEvents(def, read.input, move, floorOf(read, target));
  if (!outer.success || outer.newPhase === undefined || attemptId === undefined) {
    try {
      await appendDiagnosticRows(eventStore, featureId, phaseRowsOf(outer.events, featureId, { guardId: guardIdOf(move), rows: read.rows }));
    } catch (err) {
      return reply({ code: ErrorCode.EVENT_APPEND_FAILED, message: `Event append failed: ${messageOf(err)}` });
    }
    const code = outer.errorCode === 'CIRCUIT_OPEN' ? ErrorCode.CIRCUIT_OPEN : outer.errorCode === 'PHASE_BLOCKED' ? ErrorCode.PHASE_BLOCKED : ErrorCode.GUARD_FAILED;
    return reply(withValidTargets({ code, message: outer.errorMessage ?? `Transition failed to '${target}'` }, def, read.from));
  }
  const key = moveKeyOf(move);
  let closureRan = false;
  try {
    const committed = await eventStore
      .getAppender()
      .decideOnce<CommittedMove>(`transition:${featureId}:${attemptId}`, requestDigestOf(featureId, read.from, target, updates), (tx) => {
        closureRan = true;
        const snapshot = tx.readStream(featureId);
        const snapshotRows = migrateEvents(snapshot.events).map(workflowEventOf);
        validatePatchCandidate(pass.state, snapshotRows, featureId, updates);
        let inner: FoldRead;
        let innerOutcome: DecideOutcome;
        try {
          inner = foldRead(featureId, target, snapshotRows, updates, options, attemptId);
          innerOutcome = decide(def, inner.input, { kind: 'transition', target });
        } catch (err) {
          throw new TransitionFoldFailed(messageOf(err));
        }
        if (innerOutcome.kind !== 'admit' || inner.from !== read.from || moveKeyOf(innerOutcome.move) !== key) {
          throw new TransitionReadsChanged(featureId, target);
        }
        const result = phaseMoveEvents(def, inner.input, innerOutcome.move, floorOf(inner, target));
        if (!result.success || result.newPhase === undefined) throw new TransitionReadsChanged(featureId, target);
        const phaseEvents = phaseRowsOf(result.events, featureId, { guardId: guardIdOf(move), rows: snapshotRows }).map((row) =>
          stampFromAmbient({ ...row }),
        );
        const patch = pendingPatchRow(featureId, updates, snapshotRows);
        const events = patch === undefined ? phaseEvents : [stampFromAmbient({
          type: patch.type,
          source: 'workflow',
          correlationId: featureId,
          data: patch.data,
        }), ...phaseEvents];
        return {
          streamId: featureId,
          events,
          result: {
            newPhase: result.newPhase,
            phaseAttemptId: attemptId,
            historyUpdates: { ...(result.historyUpdates ?? {}) },
            eventSequence: snapshot.version + events.length,
          },
        };
      });
    if (!closureRan) return { kind: 'reads-changed', ...(updates === undefined ? {} : { patchSequence: committed.eventSequence }) };
    return { kind: 'moved', move: committed };
  } catch (err) {
    if (err instanceof TransitionReadsChanged) return { kind: 'reads-changed' };
    if (err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT) return reply({ code: err.code, message: err.message });
    if (err instanceof OperationDigestMismatchError) throw err;
    if (err instanceof TransitionFoldFailed) {
      return reply({
        code: ErrorCode.PROJECTION_REPLAY_FAILED,
        message: `The ledger fold of '${featureId}' failed inside the commit, so nothing was written: ${err.message}`,
      });
    }
    return reply({ code: ErrorCode.EVENT_APPEND_FAILED, message: `Event append failed: ${messageOf(err)}` });
  }
}

/**
 * Updates fields, transitions the phase, or both, on a workflow state file. A CAS retry re-reads the document.
 *
 * A built-in transition with an event store, a ledger document and a start row decides on the ledger fold.
 * The fold gives the source phase, the attempt id and the guard config. The updates fold as a pending row.
 * A move commits once through `decideOnce`. A document conflict after an own commit retries only the document write.
 * A target equal to the fold phase is idempotent, and it levels a lagging document.
 *
 * Another built-in transition uses the legacy guard on the document with one fallback warning. A custom type gets no warning.
 *
 * A field update of an event-sourced workflow appends `state.patched`, keyed on `expectedVersion` and the field names.
 * The guard-input shadow compares the document with the fold, and each exit of a pass records its run.
 */
export async function handleSet(
  input: SetInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: SetOptions,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);
  let transitionPhaseAttemptId: string | undefined;
  let committed: CommittedMove | undefined;
  let patchSequence: number | undefined;
  let shadowRun: GuardInputShadowRun | undefined;
  let routeWarnings: readonly string[] = [];

  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
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

    if (input.phase && options?.checkpoint && committed === undefined) {
      const gateResult = shouldEnforceCheckpoint(
        state._checkpoint,
        options.checkpoint,
        'phase-transition',
      );

      if (gateResult.warning === 'checkpoint-state-missing' && eventStore) {
        try {
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'checkpoint.state_missing',
            correlationId: input.featureId,
            source: 'workflow',
            data: { action: 'set' },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
        }
      }

      if (gateResult.gated) {
        if (eventStore) {
          try {
            const validatedEvent = buildValidatedEvent(input.featureId, 1, {
              type: 'checkpoint.enforced',
              correlationId: input.featureId,
              source: 'workflow',
              data: {
                operationsSince: gateResult.operationsSince,
                threshold: gateResult.threshold,
                blockedAction: 'phase-transition',
              },
            });
            await eventStore.appendValidated(input.featureId, validatedEvent);
          } catch {
          }
        }

        return {
          success: false,
          error: {
            code: 'CHECKPOINT_REQUIRED' as typeof ErrorCode[keyof typeof ErrorCode],
            message: `Checkpoint required before phase transition: ${gateResult.operationsSince} operations since last checkpoint (threshold: ${gateResult.threshold})`,
            ...(gateResult.gate !== undefined ? { gate: gateResult.gate } : {}),
            ...(gateResult.operationsSince !== undefined ? { operationsSince: gateResult.operationsSince } : {}),
            ...(gateResult.threshold !== undefined ? { threshold: gateResult.threshold } : {}),
          },
        };
      }
    }

    const expectedVersion = state._version ?? 1;

    let mutableState: Record<string, unknown> = structuredClone(state);

    if (input.updates) {
      try {
        for (const [dotPath, value] of Object.entries(input.updates)) {
          applyDotPath(mutableState, dotPath, value);
        }
      } catch (err) {
        if (err instanceof StateStoreError && err.code === ErrorCode.RESERVED_FIELD) {
          return {
            success: false,
            error: {
              code: err.code,
              message: err.message,
              ...(err.data !== undefined ? { data: err.data } : {}),
            },
          };
        }
        throw err;
      }
    }

    const validated = WorkflowStateSchema.safeParse(mutableState);
    if (!input.phase && routeOf(state, eventStore, undefined).kind === 'legacy' && !validated.success) {
      return { success: false, error: { code: ErrorCode.INVALID_INPUT, message: `Write-time validation failed: ${validated.error.message}` } };
    }

    let ledgerBacked = false;
    let transitionTopSequence: number | undefined;

    if (input.phase) {
      injectGuardConfig(mutableState, options);

      let rows: readonly WorkflowEvent[] | undefined;
      let rowsError: unknown;
      if (eventStore) {
        try {
          rows = await eventStore.query(input.featureId);
          mutableState._events = toGuardEvents(rows);
        } catch (err) {
          rows = undefined;
          rowsError = err;
          mutableState._events = mutableState._events ?? [];
        }
      } else {
        workflowLogger.warn(
          { featureId: input.featureId },
          'eventStore unavailable during phase transition — _events will not be hydrated, guards may fail',
        );
      }

      const route = routeOf(state, eventStore, rows);
      ledgerBacked = route.kind === 'fold';
      routeWarnings = route.kind === 'legacy' ? route.warnings : [];
      const fromPhase = state.phase;
      if (
        route.kind === 'legacy'
        && fromPhase !== input.phase
        && transitionPhaseAttemptId === undefined
      ) {
        transitionPhaseAttemptId = allocatePhaseAttemptId(
          input.featureId,
          fromPhase,
          input.phase,
          readPhaseAttemptId(state),
          expectedVersion,
        );
      }
      if (route.kind === 'legacy' && transitionPhaseAttemptId !== undefined) {
        mutableState._pendingPhaseAttemptId = transitionPhaseAttemptId;
      }
      shadowRun = runGuardInputShadow({
        call: 'transition',
        featureId: input.featureId,
        target: input.phase,
        hasUpdates: input.updates !== undefined,
        document: mutableState,
        rows,
        pass: attempt,
        fold: { config: options ?? {} },
        ...(options?.skipPhases !== undefined ? { skipPhases: options.skipPhases } : {}),
      });

      if (route.kind === 'legacy' && !validated.success) {
        return withShadowRecord({ success: false, error: {
          code: ErrorCode.INVALID_INPUT, message: `Write-time validation failed: ${validated.error.message}`,
        } }, shadowRun, stateDir, routeWarnings);
      }

      if (committed !== undefined) {
        workflowLogger.debug(
          { featureId: input.featureId, phase: committed.newPhase },
          'the move is committed, so this pass retries only the document write',
        );
      } else if (route.kind === 'fold' && eventStore) {
        if (rows === undefined) {
          return withShadowRecord({
            success: false,
            error: {
              code: ErrorCode.PROJECTION_REPLAY_FAILED,
              message: `The rows of '${input.featureId}' could not be read, so no guard decided: ${messageOf(rowsError)}`,
            },
          }, shadowRun, stateDir);
        }
        const pass = await decideOnTheFold({
          featureId: input.featureId,
          target: input.phase,
          updates: patchSequence === undefined ? input.updates : undefined,
          state,
          workflowType: route.workflowType,
          rows,
          options,
          eventStore,
        });
        if (pass.kind === 'reply') return withShadowRecord(pass.result, shadowRun, stateDir);
        if (pass.kind === 'reads-changed') {
          patchSequence = pass.patchSequence ?? patchSequence;
          continue;
        }
        if (pass.kind === 'moved') {
          committed = pass.move;
        } else {
          if (!input.updates || patchSequence !== undefined) {
            const level = await levelPhaseInStateDocument(stateFile, eventStore, input.featureId);
            if (level.kind === 'failed' || level.kind === 'skipped') {
              return withShadowRecord({ success: false, error: { code: ErrorCode.PROJECTION_REPLAY_FAILED,
                message: level.kind === 'failed' ? level.error : 'The state document is absent' } }, shadowRun, stateDir);
            }
            return withShadowRecord({
              success: true,
              data: { phase: level.state.phase, updatedAt: level.state.updatedAt, idempotent: true, phaseAttemptId: readPhaseAttemptId(level.state) },
              _meta: buildCheckpointMeta(level.state._checkpoint),
            }, shadowRun, stateDir);
          }
        }
      } else {
        let attemptResult;
        try {
          attemptResult = await hsmTransitionGuard.attempt(
            input.featureId,
            fromPhase,
            input.phase,
            {
              state: mutableState,
              priorState: state as unknown as Record<string, unknown>,
              workflowType: state.workflowType as string,
              skipPhases: options?.skipPhases,
              idempotencyKeySuffix: String(expectedVersion),
              eventStore,
              shadowObserver: (observation, observerEventStore) =>
                recordLiveTransition(observation, mutableState, observerEventStore),
            },
          );
        } catch (err) {
          return withShadowRecord({
            success: false,
            error: {
              code: ErrorCode.EVENT_APPEND_FAILED,
              message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          }, shadowRun, stateDir, routeWarnings);
        }

        if (!attemptResult.ok) {
          if (attemptResult.reason === 'no-transition-defined') {
            return withShadowRecord({
              success: false,
              error: {
                code: ErrorCode.INVALID_TRANSITION,
                message: attemptResult.errorMessage,
                ...(attemptResult.validTargets.length
                  ? { validTargets: attemptResult.validTargets }
                  : {}),
              },
            }, shadowRun, stateDir, routeWarnings);
          }
          const guardFailure = attemptResult.failures[0];
          const errorPayload: Record<string, unknown> = {
            code:
              attemptResult.errorCode === 'CIRCUIT_OPEN'
                ? ErrorCode.CIRCUIT_OPEN
                : attemptResult.errorCode === 'PHASE_BLOCKED'
                  ? ErrorCode.PHASE_BLOCKED
                  : ErrorCode.GUARD_FAILED,
            message: attemptResult.errorMessage,
          };
          if (guardFailure?.expectedShape) {
            errorPayload.expectedShape = guardFailure.expectedShape;
          }
          if (guardFailure?.suggestedFix) {
            errorPayload.suggestedFix = guardFailure.suggestedFix;
          }
          return withShadowRecord({
            success: false,
            error: errorPayload as NonNullable<ToolResult['error']>,
          }, shadowRun, stateDir, routeWarnings);
        }

        if (attemptResult.idempotent && !input.updates) {
          return withShadowRecord({
            success: true,
            data: {
              phase: state.phase,
              updatedAt: state.updatedAt,
              idempotent: true,
              phaseAttemptId: readPhaseAttemptId(state),
            },
            _meta: buildCheckpointMeta(state._checkpoint),
          }, shadowRun, stateDir, routeWarnings);
        }

        if (!attemptResult.idempotent) {
          mutableState.phase = attemptResult.newPhase;
          mutableState.phaseAttemptId = transitionPhaseAttemptId;

          if (Object.keys(attemptResult.historyUpdates).length > 0) {
            const history = {
              ...(mutableState._history as Record<string, string>),
            };
            for (const [key, value] of Object.entries(
              attemptResult.historyUpdates,
            )) {
              history[key] = value;
            }
            mutableState._history = history;
          }

          mutableState._checkpoint = resetCounter(
            mutableState._checkpoint as WorkflowState['_checkpoint'],
            attemptResult.newPhase,
          );

          if (attemptResult.transitionEvent.sequence > 0) {
            transitionTopSequence = attemptResult.transitionEvent.sequence;
          }
        }
      }

      delete mutableState._requiredReviews;
      delete mutableState._maxPlanRevisions;
      delete mutableState._mutationEnforcement;
      delete mutableState._mutationThreshold;
      delete mutableState._maxNoCoverage;
      delete mutableState._pendingPhaseAttemptId;
    }

    if (committed !== undefined) {
      transitionTopSequence = committed.eventSequence;
      if (input.updates && Object.keys(input.updates).length > 0) patchSequence = committed.eventSequence;
    }

    let highestEventSequence: number | undefined = transitionTopSequence;

    const updateKeys = input.updates ? Object.keys(input.updates) : [];
    if (
      isEventSourced(state)
      && eventStore
      && updateKeys.length > 0
      && patchSequence === undefined
    ) {
      try {
        const fieldsHash = [...updateKeys].sort().join(',');
        const idempotencyKey = `${input.featureId}:patch:${expectedVersion}:${fieldsHash}`;
        let expectedSequence: number | undefined;
        if (routeOf(state, eventStore, undefined).kind === 'fold') {
          const backend = eventStore.getAppender().ensureSqliteBackendSync();
          if (backend.lookupIdempotencyClaim(input.featureId, idempotencyKey) === undefined) {
            let rows: readonly WorkflowEvent[];
            try {
              rows = await eventStore.query(input.featureId);
            } catch (err) {
              throw new TransitionFoldFailed(messageOf(err));
            }
            ledgerBacked = routeOf(state, eventStore, rows).kind === 'fold';
            if (ledgerBacked) {
              try {
                validatePatchCandidate(state, rows, input.featureId, input.updates);
              } catch (err) {
                if (!(err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT)
                  || backend.lookupIdempotencyClaim(input.featureId, idempotencyKey) === undefined) throw err;
              }
              expectedSequence = highestSequence(rows);
            }
          } else {
            try {
              ledgerBacked = routeOf(state, eventStore, await eventStore.query(input.featureId)).kind === 'fold';
            } catch (err) {
              throw new TransitionFoldFailed(messageOf(err));
            }
          }
        }
        if (!ledgerBacked) {
          const invalid = validateStateForWrite(mutableState as WorkflowState);
          if (invalid !== undefined) throw new StateStoreError(ErrorCode.INVALID_INPUT, invalid);
        }
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'state.patched',
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            fields: updateKeys,
            patch: input.updates,
          },
        });
        const event = await eventStore.appendValidated(input.featureId, validatedEvent, { idempotencyKey, ...(expectedSequence === undefined ? {} : { expectedSequence }) });
        if (JSON.stringify(event.data?.patch) !== JSON.stringify(input.updates)) continue;

        highestEventSequence = Math.max(highestEventSequence ?? 0, event.sequence);
        patchSequence = event.sequence;
      } catch (err) {
        if (err instanceof SequenceConflictError) continue;
        return withShadowRecord({
          success: false,
          error: {
            code: err instanceof TransitionFoldFailed ? ErrorCode.PROJECTION_REPLAY_FAILED
              : err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT ? ErrorCode.INVALID_INPUT : ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        }, shadowRun, stateDir, routeWarnings);
      }
    } else if (patchSequence !== undefined) {
      highestEventSequence = Math.max(highestEventSequence ?? 0, patchSequence);
    }

    if (eventStore && isEventSourced(state)) {
      const rows = await eventStore.query(input.featureId);
      ledgerBacked = ledgerBacked || routeOf(state, eventStore, rows).kind === 'fold';
      if (ledgerBacked) mutableState = { ...projectStateDocument(state, rows, input.featureId) };
    }

    if (!ledgerBacked && highestEventSequence !== undefined) {
      mutableState._eventSequence = highestEventSequence;
    }

    mutableState._checkpoint = incrementOperations(WorkflowStateSchema.parse(mutableState)._checkpoint);

    const updatedAt = new Date().toISOString();
    mutableState.updatedAt = updatedAt;

    const checkpoint = mutableState._checkpoint as Record<string, unknown>;
    checkpoint.lastActivityTimestamp = new Date().toISOString();

    try {
      await writeStateFile(stateFile, mutableState as WorkflowState, { expectedVersion });
      (mutableState as Record<string, unknown>)._version = expectedVersion + 1;
    } catch (err) {
      if (err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT) {
        return withShadowRecord({
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: err.message,
          },
        }, shadowRun, stateDir, routeWarnings);
      }
      if (err instanceof VersionConflictError && attempt < MAX_CAS_RETRIES) {
        continue;
      }

      if (err instanceof VersionConflictError && eventStore) {
        try {
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'workflow.cas-failed',
            correlationId: input.featureId,
            source: 'workflow',
            data: {
              featureId: input.featureId,
              phase: input.phase ?? (mutableState.phase as string) ?? 'unknown',
              retries: MAX_CAS_RETRIES,
            },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
        }
      }

      await recordGuardInputShadow(shadowRun, { stateDir });
      throw err;
    }

    return withShadowRecord({
      success: true,
      data: {
        phase: committed?.newPhase ?? mutableState.phase as string,
        workflowType: mutableState.workflowType as string,
        updatedAt: mutableState.updatedAt as string,
        phaseAttemptId: committed?.phaseAttemptId ?? mutableState.phaseAttemptId as string,
      },
      _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
    }, shadowRun, stateDir, routeWarnings);
  }

  throw new StateStoreError(
    ErrorCode.VERSION_CONFLICT,
    `Concurrent write conflict: failed to acquire consistent version after ${MAX_CAS_RETRIES} retries for feature: ${input.featureId}, phase: ${input.phase ?? 'field-update'}`,
  );
}
