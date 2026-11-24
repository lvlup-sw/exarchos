/**
 * The compensation of a cancel. It starts no process and changes no branch, worktree or pull request.
 *
 * Each action lists the resources of the workflow from the state: the pull request, the integration
 * branch, the worktrees and the feature branches. It records each resource as outstanding in a
 * `workflow.compensation` record and returns that status. The harness removes the resources.
 * A missing branch or worktree stays outstanding, and a prior failed removal stays a failure.
 */
import { createHash } from 'node:crypto';
import { appendEvent } from './events.js';
import { ErrorCode } from './schemas.js';
import type { Event } from './types.js';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import {
  CancelCompensationCompletedData,
  CancelCompensationFailedData,
} from '../events/schemas.js';
import {
  appendFencedCancelEvent,
  decideCompensationAction,
  foldCancelSaga,
  type CancelRetryPolicy,
} from './cancel-process-manager.js';

/** The kind of a workflow resource that a cancel records. */
export type CompensationResourceKind =
  | 'pull-request'
  | 'integration-branch'
  | 'worktree'
  | 'feature-branch';

/**
 * The ledger status of one resource after a cancel. `outstanding` means that the resource can still
 * exist and the harness owns its removal. `failed` means that an earlier removal of it failed.
 */
export type CompensationResourceStatus = 'outstanding' | 'failed';

/** One workflow resource that a cancel records, with its ledger status. */
export interface CompensationResource {
  readonly kind: CompensationResourceKind;
  readonly ref: string;
  readonly status: CompensationResourceStatus;
}

/** A resource reference before the action gives it a status. */
interface ResourceRef {
  readonly kind: CompensationResourceKind;
  readonly ref: string;
}

/**
 * One compensation action. It reads the resources of one kind from the workflow state and
 * reads nothing else. The action id stays the same, because the saga history keys on it.
 */
export interface CompensationAction {
  readonly id: string;
  readonly phase: string;
  readonly description: string;
  readonly resourcesOf: (state: Record<string, unknown>) => readonly ResourceRef[];
  /** The message when the state holds no resource of this kind. */
  readonly noneMessage: string;
  readonly dryRunMessage: (refs: readonly string[]) => string;
  readonly recordedMessage: (refs: readonly string[]) => string;
}

export interface CompensationCheckpoint {
  readonly completedActions: readonly string[];
}

export interface CompensationOptions {
  readonly dryRun: boolean;
  readonly checkpoint?: CompensationCheckpoint | undefined;
  /** The event store of the cancellation process manager. */
  readonly eventStore?: EventStore;
  /** Feature ID (stream ID) for event store appends. Required when eventStore is set. */
  readonly featureId?: string;
  /**
   * Turns on the event-sourced cancellation process manager. Without it, compensation uses checkpoints.
   * `writerEpoch` and `instanceId` are the fencing token. Each process event append checks the epoch, so a stale instance cannot write.
   * `maxAttempts` limits the attempts of each action before manual intervention.
   */
  readonly cancelProcess?: {
    readonly cancelId: string;
    readonly phaseAttemptId: string;
    readonly writerEpoch: number;
    readonly instanceId: string;
    readonly maxAttempts?: number;
  };
}

/**
 * {@link CompensationOptions} with `eventStore`, `featureId` and `cancelProcess` all present.
 * `executeCompensation` checks the three together once, so the helpers read them without a null check.
 */
export interface ProcessManagedCompensationOptions extends CompensationOptions {
  readonly eventStore: EventStore;
  readonly featureId: string;
  readonly cancelProcess: {
    readonly cancelId: string;
    readonly phaseAttemptId: string;
    readonly writerEpoch: number;
    readonly instanceId: string;
    readonly maxAttempts?: number;
  };
}

/**
 * The result of one action. A live action returns `outstanding`, `skipped`, `failed` or `dry-run`.
 * `executed` stays in the type, because saga rows from before the ledger-only cancel carry it.
 */
export interface CompensationActionResult {
  readonly actionId: string;
  readonly status: 'executed' | 'skipped' | 'outstanding' | 'failed' | 'dry-run';
  readonly message: string;
  /** The resources that the action recorded. Absent when the action has no resource. */
  readonly resources?: readonly CompensationResource[];
}

export interface CompensationResult {
  readonly actions: readonly CompensationActionResult[];
  readonly events: readonly Event[];
  readonly success: boolean;
  readonly errorCode?: string;
  readonly checkpoint: CompensationCheckpoint | null;
  readonly durableOutcomes?: {
    readonly completedActionIds: readonly string[];
    readonly outcomeSequences: readonly number[];
  };
}

/**
 * The default attempt budget of the cancellation process manager.
 * After this many attempts, the saga escalates the action to `manual-intervention-required`.
 */
export const CANCEL_MAX_ATTEMPTS = 3;

/** The phase order. Compensation runs the phases in reverse. */
const PHASE_ORDER: readonly string[] = [
  'plan',
  'delegate',
  'review',
  'synthesize',
];

/** True when the value is a plain object and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as a record, or `undefined` when it is not an object. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Returns the value when it is a string that is not empty. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Returns the string values of one field of each record in a list, in order. */
function stringsOf(values: readonly unknown[], field: string): string[] {
  const out: string[] = [];
  for (const value of values) {
    const ref = nonEmptyString(recordOf(value)?.[field]);
    if (ref !== undefined) out.push(ref);
  }
  return out;
}

/** The pull request of `state.synthesis.prUrl`. */
const CLOSE_PR: CompensationAction = {
  id: 'synthesize:close-pr',
  phase: 'synthesize',
  description: 'Record the pull request as outstanding',
  resourcesOf: (state) => {
    const ref = nonEmptyString(recordOf(state.synthesis)?.prUrl);
    return ref === undefined ? [] : [{ kind: 'pull-request', ref }];
  },
  noneMessage: 'No PR to close',
  dryRunMessage: (refs) => `Would record PR as outstanding: ${refs.join(', ')}`,
  recordedMessage: (refs) => `Recorded PR as outstanding: ${refs.join(', ')}`,
};

/** The integration branch of `state.synthesis.integrationBranch`. */
const DELETE_INTEGRATION_BRANCH: CompensationAction = {
  id: 'delegate:delete-integration-branch',
  phase: 'delegate',
  description: 'Record the integration branch as outstanding',
  resourcesOf: (state) => {
    const ref = nonEmptyString(recordOf(state.synthesis)?.integrationBranch);
    return ref === undefined ? [] : [{ kind: 'integration-branch', ref }];
  },
  noneMessage: 'No integration branch to delete',
  dryRunMessage: (refs) => `Would record integration branch as outstanding: ${refs.join(', ')}`,
  recordedMessage: (refs) => `Recorded integration branch as outstanding: ${refs.join(', ')}`,
};

/** The worktree paths of `state.worktrees`. An entry with no path names no resource. */
const CLEANUP_WORKTREES: CompensationAction = {
  id: 'delegate:cleanup-worktrees',
  phase: 'delegate',
  description: 'Record the delegation worktrees as outstanding',
  resourcesOf: (state) =>
    stringsOf(Object.values(recordOf(state.worktrees) ?? {}), 'path').map((ref) => ({
      kind: 'worktree',
      ref,
    })),
  noneMessage: 'No worktrees to clean up',
  dryRunMessage: (refs) => `Would record ${refs.length} worktree(s) as outstanding: ${refs.join(', ')}`,
  recordedMessage: (refs) => `Recorded ${refs.length} worktree(s) as outstanding: ${refs.join(', ')}`,
};

/** The task branches of `state.tasks`. A task with no branch names no resource. */
const DELETE_FEATURE_BRANCHES: CompensationAction = {
  id: 'delegate:delete-feature-branches',
  phase: 'delegate',
  description: 'Record the feature branches as outstanding',
  resourcesOf: (state) =>
    stringsOf(Array.isArray(state.tasks) ? state.tasks : [], 'branch').map((ref) => ({
      kind: 'feature-branch',
      ref,
    })),
  noneMessage: 'No feature branches to delete',
  dryRunMessage: (refs) => `Would record ${refs.length} feature branch(es) as outstanding: ${refs.join(', ')}`,
  recordedMessage: (refs) => `Recorded ${refs.length} feature branch(es) as outstanding: ${refs.join(', ')}`,
};

function getCompensationActions(): readonly CompensationAction[] {
  return [CLOSE_PR, DELETE_INTEGRATION_BRANCH, CLEANUP_WORKTREES, DELETE_FEATURE_BRANCHES];
}

/**
 * Records the resources of one action. It reads the state only, so it starts no process and
 * does not ask whether a resource exists. A resource that is already absent stays outstanding.
 * A prior failed removal of the action makes each resource `failed`, and the action fails.
 */
function recordAction(
  action: CompensationAction,
  state: Record<string, unknown>,
  dryRun: boolean,
  priorFailure: string | undefined,
): CompensationActionResult {
  const refs = action.resourcesOf(state);
  if (refs.length === 0) {
    return { actionId: action.id, status: 'skipped', message: action.noneMessage };
  }
  const names = refs.map((resource) => resource.ref);
  if (dryRun) {
    return {
      actionId: action.id,
      status: 'dry-run',
      message: action.dryRunMessage(names),
      resources: refs.map((resource) => ({ ...resource, status: 'outstanding' })),
    };
  }
  if (priorFailure !== undefined) {
    return {
      actionId: action.id,
      status: 'failed',
      message: `A prior removal failed, and the cancel keeps the failure: ${priorFailure}`,
      resources: refs.map((resource) => ({ ...resource, status: 'failed' })),
    };
  }
  return {
    actionId: action.id,
    status: 'outstanding',
    message: action.recordedMessage(names),
    resources: refs.map((resource) => ({ ...resource, status: 'outstanding' })),
  };
}

/** Returns the current phase and the phases before it, in reverse. An unknown phase gives all phases in reverse. */
function getPhasesInReverseOrder(currentPhase: string): string[] {
  const idx = PHASE_ORDER.indexOf(currentPhase);
  if (idx === -1) {
    return [...PHASE_ORDER].reverse();
  }
  return PHASE_ORDER.slice(0, idx + 1).reverse();
}

function orderedCompensationActions(currentPhase: string): CompensationAction[] {
  const phasesInOrder = getPhasesInReverseOrder(currentPhase);
  const allActions = getCompensationActions();
  const orderedActions: CompensationAction[] = [];
  for (const phase of phasesInOrder) {
    for (const action of allActions) {
      if (action.phase === phase) orderedActions.push(action);
    }
  }
  return orderedActions;
}

/** Returns the `workflow.compensation` record of one action result as a local event. */
function compensationRecord(
  events: readonly Event[],
  eventSequence: number,
  result: CompensationActionResult,
): Event {
  return appendEvent(events, eventSequence, 'compensation', `compensation:${result.actionId}`, {
    metadata: {
      actionId: result.actionId,
      status: result.status,
      message: result.message,
      ...(result.resources !== undefined ? { resources: result.resources } : {}),
    },
  }).event;
}

/** Returns one `workflow.compensation` record for each result, in order. */
function compensationRecords(results: readonly CompensationActionResult[]): Event[] {
  const records: Event[] = [];
  for (const result of results) {
    records.push(compensationRecord(records, records.length, result));
  }
  return records;
}

function processEventData(
  options: ProcessManagedCompensationOptions,
  actionId: string,
): {
  cancelId: string;
  featureId: string;
  phaseAttemptId: string;
  actionId: string;
} {
  return {
    cancelId: options.cancelProcess.cancelId,
    featureId: options.featureId,
    phaseAttemptId: options.cancelProcess.phaseAttemptId,
    actionId,
  };
}

/**
 * Appends one cancellation event through the fenced append.
 * The idempotency key keeps the `cancel:` plus 64-hex shape, and the `operationId` makes a crash-resume idempotent.
 * The append checks `writerEpoch` in its transaction, so a stale instance cannot write.
 */
async function appendCancellationProcessEvent(
  options: ProcessManagedCompensationOptions,
  type:
    | 'cancel.compensation-requested'
    | 'cancel.compensation-completed'
    | 'cancel.compensation-failed'
    | 'cancel.compensation-retry-scheduled'
    | 'cancel.manual-intervention-required',
  data: Record<string, unknown>,
  suffix: string,
): Promise<void> {
  const featureId = options.featureId;
  const key = `cancel:${createHash('sha256')
    .update(`${featureId}\0${options.cancelProcess.cancelId}\0${suffix}`, 'utf8')
    .digest('hex')}`;
  await appendFencedCancelEvent(options.eventStore, {
    featureId,
    cancelId: options.cancelProcess.cancelId,
    writerEpoch: options.cancelProcess.writerEpoch,
    type,
    data,
    idempotencyKey: key,
    operationId: `cancel-op:${options.cancelProcess.cancelId}:${suffix}`,
  });
}

/**
 * Returns the message of the first effect failure of an action in this cancel, or `undefined`.
 * A malformed result is not a failed removal, so it does not count.
 */
function priorRemovalFailure(
  history: readonly WorkflowEvent[],
  cancelId: string,
  actionId: string,
): string | undefined {
  for (const event of history) {
    if (event.type !== 'cancel.compensation-failed') continue;
    const parsed = CancelCompensationFailedData.safeParse(event.data);
    if (
      parsed.success
      && parsed.data.cancelId === cancelId
      && parsed.data.actionId === actionId
      && parsed.data.reason === 'effect-failed'
    ) {
      return parsed.data.message;
    }
  }
  return undefined;
}

/**
 * Runs the compensation actions under the cancellation process manager.
 * Each attempt appends the request, records the action once, and appends the outcome. Attempt-scoped keys make a resumed attempt append nothing new.
 * A malformed durable outcome gives a `malformed-result` failure, and the action does not run.
 *
 * The folded saga decides each step, so a durably completed action does not run again after a restart or takeover.
 * An action that this call completes returns its own result. An action that an earlier call completed returns the replay result.
 * An iteration cap above the attempt budget guards against a decision bug.
 * Success also needs a durable completion event for each action.
 */
async function executeProcessManagedCompensation(
  state: Record<string, unknown>,
  currentPhase: string,
  options: ProcessManagedCompensationOptions,
): Promise<CompensationResult> {
  const eventStore = options.eventStore;
  const featureId = options.featureId;
  const cancelId = options.cancelProcess.cancelId;
  const actions = orderedCompensationActions(currentPhase);
  const results: CompensationActionResult[] = [];
  const policy: CancelRetryPolicy = {
    maxAttempts: options.cancelProcess.maxAttempts ?? CANCEL_MAX_ATTEMPTS,
  };

  const runOneAttempt = async (
    action: CompensationAction,
    attempt: number,
    history: readonly WorkflowEvent[],
  ): Promise<CompensationActionResult> => {
    await appendCancellationProcessEvent(
      options,
      'cancel.compensation-requested',
      {
        eventVersion: '1.0',
        ...processEventData(options, action.id),
        requestedAt: new Date().toISOString(),
      },
      `compensation:${action.id}:attempt${attempt}:requested`,
    );

    const result = recordAction(
      action,
      state,
      false,
      priorRemovalFailure(history, cancelId, action.id),
    );

    if (result.status === 'failed') {
      await appendCancellationProcessEvent(
        options,
        'cancel.compensation-failed',
        {
          eventVersion: '1.0',
          ...processEventData(options, action.id),
          reason: 'effect-failed',
          message: result.message,
          failedAt: new Date().toISOString(),
        },
        `compensation:${action.id}:attempt${attempt}:failed`,
      );
    } else {
      await appendCancellationProcessEvent(
        options,
        'cancel.compensation-completed',
        {
          eventVersion: '1.0',
          ...processEventData(options, action.id),
          status: result.status,
          message: result.message,
          completedAt: new Date().toISOString(),
        },
        `compensation:${action.id}:attempt${attempt}:completed`,
      );
    }
    return result;
  };

  for (const action of actions) {
    const priorHistory = await eventStore.query(featureId);
    const malformedOutcome = priorHistory.find((event) => {
      const data = recordOf(event.data);
      if (data?.cancelId !== cancelId || data?.actionId !== action.id) return false;
      return (
        (event.type === 'cancel.compensation-completed'
          && !CancelCompensationCompletedData.safeParse(event.data).success)
        || (event.type === 'cancel.compensation-failed'
          && !CancelCompensationFailedData.safeParse(event.data).success)
      );
    });
    if (malformedOutcome !== undefined) {
      const message = `Malformed durable compensation result for ${action.id}`;
      await appendCancellationProcessEvent(
        options,
        'cancel.compensation-failed',
        {
          eventVersion: '1.0',
          ...processEventData(options, action.id),
          reason: 'malformed-result',
          message,
          failedAt: new Date().toISOString(),
        },
        `compensation:${action.id}:malformed:failed`,
      );
      results.push({ actionId: action.id, status: 'failed', message });
      continue;
    }

    const cap = policy.maxAttempts * 2 + 4;
    let terminal: CompensationActionResult | undefined;
    let completedHere: CompensationActionResult | undefined;
    for (let guard = 0; guard < cap && terminal === undefined; guard++) {
      const history = await eventStore.query(featureId);
      const saga = foldCancelSaga(history, cancelId);
      const plan = decideCompensationAction(saga, action.id, policy);
      switch (plan.kind) {
        case 'satisfied':
          terminal = completedHere ?? {
            actionId: action.id,
            status: 'skipped',
            message: 'Already completed (event replay)',
          };
          break;
        case 'blocked-manual':
          terminal = {
            actionId: action.id,
            status: 'failed',
            message: `Manual intervention required for ${action.id}`,
          };
          break;
        case 'escalate-manual':
          await appendCancellationProcessEvent(
            options,
            'cancel.manual-intervention-required',
            {
              eventVersion: '1.0',
              ...processEventData(options, action.id),
              epoch: options.cancelProcess.writerEpoch,
              attempts: plan.attempts,
              reason: plan.reason,
              message: `Compensation ${action.id} exhausted ${plan.attempts} attempt(s)`,
              requiredAt: new Date().toISOString(),
            },
            `compensation:${action.id}:manual`,
          );
          break;
        case 'retry': {
          await appendCancellationProcessEvent(
            options,
            'cancel.compensation-retry-scheduled',
            {
              eventVersion: '1.0',
              ...processEventData(options, action.id),
              epoch: options.cancelProcess.writerEpoch,
              attempt: plan.failedAttempt,
              maxAttempts: policy.maxAttempts,
              reason: plan.reason,
              message: plan.message,
              scheduledAt: new Date().toISOString(),
            },
            `compensation:${action.id}:attempt${plan.failedAttempt}:retry`,
          );
          const retried = await runOneAttempt(action, plan.nextAttempt, history);
          if (retried.status !== 'failed') completedHere = retried;
          break;
        }
        case 'execute': {
          const ran = await runOneAttempt(action, plan.attempt, history);
          if (ran.status !== 'failed') completedHere = ran;
          break;
        }
      }
    }
    results.push(
      terminal ?? {
        actionId: action.id,
        status: 'failed',
        message: `Compensation did not converge for ${action.id}`,
      },
    );
  }

  const replay = await eventStore.query(featureId);
  const completedActionIds: string[] = [];
  const outcomeSequences: number[] = [];
  let incomplete = false;
  for (const action of actions) {
    const completed = replay.find((event) => {
      if (event.type !== 'cancel.compensation-completed') return false;
      const parsed = CancelCompensationCompletedData.safeParse(event.data);
      return parsed.success
        && parsed.data.cancelId === cancelId
        && parsed.data.actionId === action.id;
    });
    if (completed !== undefined) {
      completedActionIds.push(action.id);
      outcomeSequences.push(completed.sequence);
    } else {
      incomplete = true;
    }
  }

  const hasFailure =
    incomplete || results.some((result) => result.status === 'failed');
  return {
    actions: results,
    events: compensationRecords(
      actions.map((action) => recordAction(action, state, false, undefined)),
    ),
    success: !hasFailure,
    ...(hasFailure ? { errorCode: ErrorCode.COMPENSATION_PARTIAL } : {}),
    checkpoint: null,
    durableOutcomes: { completedActionIds, outcomeSequences },
  };
}

/**
 * Runs the compensation actions for `currentPhase` and the phases before it, in reverse phase order.
 * With `cancelProcess`, it runs the process-managed path. That path needs `eventStore` and `featureId` and cannot be a dry run.
 * Without it, it skips the actions in the checkpoint and returns one `compensation` event for each action.
 * @throws {Error} When `eventStore` is set without `featureId`.
 * It also throws when `cancelProcess` comes without `eventStore` and `featureId`, or with `dryRun`.
 */
export async function executeCompensation(
  state: Record<string, unknown>,
  currentPhase: string,
  events: readonly Event[],
  eventSequence: number,
  options: CompensationOptions,
): Promise<CompensationResult> {
  if (options.eventStore !== undefined && options.featureId === undefined) {
    throw new Error(
      'executeCompensation: options.eventStore was provided without ' +
        'options.featureId, so the cancellation ledger has no stream ID. ' +
        'Either pass both, or omit both to use the checkpoint path.',
    );
  }
  if (options.cancelProcess !== undefined) {
    const { eventStore, featureId, cancelProcess } = options;
    if (eventStore === undefined || featureId === undefined) {
      throw new Error(
        'executeCompensation: cancelProcess requires eventStore and featureId',
      );
    }
    if (options.dryRun) {
      throw new Error('executeCompensation: cancelProcess cannot run in dry-run mode');
    }
    return executeProcessManagedCompensation(state, currentPhase, {
      ...options,
      eventStore,
      featureId,
      cancelProcess,
    });
  }

  const orderedActions = orderedCompensationActions(currentPhase);

  const results: CompensationActionResult[] = [];
  const compensationEvents: Event[] = [];
  let currentSequence = eventSequence;
  let hasFailure = false;
  const completedSet = new Set(options.checkpoint?.completedActions ?? []);

  for (const action of orderedActions) {
    let result: CompensationActionResult;

    if (completedSet.has(action.id)) {
      result = { actionId: action.id, status: 'skipped', message: 'Already completed (checkpoint)' };
    } else {
      result = recordAction(action, state, options.dryRun, undefined);

      if (result.status === 'failed') {
        hasFailure = true;
      }

      if (result.status === 'outstanding' || result.status === 'skipped') {
        completedSet.add(action.id);
      }
    }

    results.push(result);

    const event = compensationRecord([...events, ...compensationEvents], currentSequence, result);
    compensationEvents.push(event);
    currentSequence = event.sequence;
  }

  return {
    actions: results,
    events: compensationEvents,
    success: !hasFailure,
    ...(hasFailure && { errorCode: ErrorCode.COMPENSATION_PARTIAL }),
    checkpoint: hasFailure ? { completedActions: [...completedSet] } : null,
  };
}
