/** Handlers for the task verbs: claim, complete, and fail. */

import { foldToTail } from '../../projections/fold-at-tail.js';
import * as path from 'node:path';
import { EventStore, SequenceConflictError } from '../../events/store.js';
import {
  GateExecutedData,
  validateAgentEvent,
  type AdmissionEvidenceRecorded,
  type WorkflowEvent,
} from '../../events/schemas.js';
import { toEventAck, type ToolResult } from '../../format.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../../projections/views/tools.js';
import { TASK_DETAIL_VIEW } from '../../projections/views/task-detail-view.js';
import type { TaskDetailViewState } from '../../projections/views/task-detail-view.js';
import { markTasksCompleteInStateDocument, type TaskStatusSyncOutcome } from '../../workflow/state-store.js';
import type { WorkflowState } from '../../workflow/types.js';
import { logger } from '../../logger.js';
import { getFullRegistry } from '../../registry.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import { ladderRequirementId, readGateEvidenceRecords } from '../gates/durable-gate-producer.js';
import { gateRunnerObservationSource, gateSignalIdempotencyKey } from '../gates/gate-runner.js';
import type { StaticAnalysisSkipReason } from '../pure/static-analysis.js';
import { STATIC_ANALYSIS_STEP_PARAMS } from '../../runbooks/definitions.js';
import { assertNever } from '../../contract/error-families.js';

const CLAIM_BASE_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function alreadyClaimedResult(taskId: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'ALREADY_CLAIMED',
      message: `Task '${taskId}' is already claimed`,
    },
  };
}

/**
 * The task verbs accept `streamId` or `featureId`, because the workflow stream id is the bare feature id.
 * One of them is required. `streamId` wins when both are present.
 * One resolver serves each verb, so the two spellings cannot drift apart.
 */
export interface StreamIdentityArgs {
  readonly streamId?: string;
  readonly featureId?: string;
}

export type StreamIdentity =
  | { readonly ok: true; readonly streamId: string }
  | { readonly ok: false; readonly error: ToolResult };

/** Resolves the stream id. The error message names both spellings and the relation between them. */
export function resolveStreamIdentity(args: StreamIdentityArgs): StreamIdentity {
  const streamId = args.streamId ?? args.featureId;
  if (!streamId) {
    return {
      ok: false,
      error: {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'streamId is required (featureId is accepted as an alias — the ' +
            'workflow stream id is the bare featureId)',
        },
      },
    };
  }
  return { ok: true, streamId };
}

/**
 * Whether `gateName` is a blocking gate, from the `action.gate` metadata of the registry, keyed by `gate.gateClass`.
 * The function fails closed: a gate class with no registration is blocking.
 */
export function isBlockingGate(gateName: string): boolean {
  for (const tool of getFullRegistry()) {
    for (const action of tool.actions) {
      if (action.gate?.gateClass === gateName) return action.gate.blocking;
    }
  }
  return true;
}

/**
 * Resets the materializer cache in `projections/views/tools.ts`.
 * Tests in one process share that cache, so they call this function between cases.
 */
export function resetModuleEventStore(): void {
  resetMaterializerCache();
}

const MAX_CLAIM_RETRIES = 3;

/** Claims a task. It makes up to `MAX_CLAIM_RETRIES` attempts in total, with exponential backoff and jitter after each sequence conflict. */
export async function handleTaskClaim(
  args: {
    taskId: string;
    agentId: string;
    streamId?: string;
    featureId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.agentId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'agentId is required' },
    };
  }

  const identity = resolveStreamIdentity(args);
  if (!identity.ok) return identity.error;
  const streamId = identity.streamId;

  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      return await attemptTaskClaim({ ...args, streamId }, stateDir, eventStore);
    } catch (err) {
      if (err instanceof SequenceConflictError) {
        const delay = CLAIM_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * CLAIM_BASE_DELAY_MS;
        await sleep(delay);
        continue;
      }
      return {
        success: false,
        error: {
          code: 'CLAIM_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    success: false,
    error: {
      code: 'CLAIM_FAILED',
      message: `Task claim failed after ${MAX_CLAIM_RETRIES} retries due to concurrent modifications`,
    },
  };
}

/**
 * Attempts one claim, with `expectedSequence` as the optimistic-concurrency pin.
 * The pin is the tail sequence of the fold, not an event count, because the two differ on a stream with gaps.
 * With no view entry for the task, the function also reads the raw events. The view ignores a claim for an unassigned task.
 */
async function attemptTaskClaim(
  args: { taskId: string; agentId: string; streamId: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const { streamId } = args;
  const materializer = getOrCreateMaterializer(stateDir);
  const store = eventStore;

  const { view, sequence: currentSequence } = await foldToTail<TaskDetailViewState>(
    store,
    materializer,
    streamId,
    TASK_DETAIL_VIEW,
  );

  const task = view.tasks[args.taskId];
  if (task && (task.status === 'claimed' || task.status === 'completed' || task.status === 'failed')) {
    return alreadyClaimedResult(args.taskId);
  }

  if (!task) {
    const events = await store.query(streamId);
    const isTerminal = events.some(
      (e) =>
        (e.type === 'task.claimed' || e.type === 'task.completed' || e.type === 'task.failed') &&
        (e.data as Record<string, unknown>)?.taskId === args.taskId,
    );
    if (isTerminal) {
      return alreadyClaimedResult(args.taskId);
    }
  }

  const claimEvent = {
    type: 'task.claimed' as const,
    data: {
      taskId: args.taskId,
      agentId: args.agentId,
      claimedAt: new Date().toISOString(),
    },
    agentId: args.agentId,
    source: 'exarchos-mcp',
  };

  validateAgentEvent(claimEvent);

  const event = await store.append(
    streamId,
    claimEvent,
    { expectedSequence: currentSequence },
  );

  return { success: true, data: toEventAck(event) };
}

/** The log text for each reason that the sync skips the state document. A missing document logs at debug level, because a tracked workflow can have none. */
const SYNC_SKIP_REASONS: Record<Extract<TaskStatusSyncOutcome, { kind: 'skipped' }>['reason'], string> = {
  'no-document': 'the workflow has no state document',
  'tasks-not-an-array': 'state.tasks is not an array',
  'tasks-not-found': 'task not found in state.tasks',
};

/** The gate class that `task_complete` requires for each task. */
const STATIC_ANALYSIS_GATE = 'static-analysis';

/** The ladder requirement under which a static-analysis run records its evidence. */
const STATIC_ANALYSIS_REQUIREMENT = ladderRequirementId(STATIC_ANALYSIS_GATE);

/** The skip descriptor that the gate runner copied from the carrier into a signal row. */
interface SignalSkip {
  readonly discriminant: string | undefined;
  readonly reason: string | undefined;
}

/** The facts of one runner signal of the static-analysis gate that the completion check reads. */
interface RunnerSignal {
  readonly sequence: number;
  readonly passed: boolean;
  readonly evidenceId: string;
  readonly skip: SignalSkip | undefined;
}

/** A string value of a row field, or undefined for any other value. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The last item that matches, or undefined when no item matches. */
function lastMatch<Item>(items: readonly Item[], matches: (item: Item) => boolean): Item | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && matches(item)) return item;
  }
  return undefined;
}

/**
 * The runner signals of the static-analysis gate for the task, in stream order.
 * A row counts only with the runner source, the task at `details.taskId`, and the runner key of the evidence id that it cites.
 * A copy of a runner row without that key thus counts for nothing. The function does not read a top-level `data.taskId`.
 */
async function runnerSignals(store: EventStore, streamId: string, taskId: string): Promise<readonly RunnerSignal[]> {
  const runnerSource = gateRunnerObservationSource(STATIC_ANALYSIS_GATE);
  const rows = await store.query(streamId, { type: 'gate.executed' });
  const signals: RunnerSignal[] = [];
  for (const row of rows) {
    if (row.source !== runnerSource) continue;
    const parsed = GateExecutedData.safeParse(row.data);
    if (!parsed.success || parsed.data.gateName !== STATIC_ANALYSIS_GATE) continue;
    const details = parsed.data.details;
    if (details?.taskId !== taskId) continue;
    const evidenceId = details.evidenceId;
    if (typeof evidenceId !== 'string' || row.idempotencyKey !== gateSignalIdempotencyKey(evidenceId)) continue;
    signals.push({
      sequence: row.sequence,
      passed: parsed.data.passed,
      evidenceId,
      skip:
        details.skipped === true
          ? { discriminant: stringField(details.discriminant), reason: stringField(details.reason) }
          : undefined,
    });
  }
  return signals.sort((a, b) => a.sequence - b.sequence);
}

/**
 * The static-analysis evidence records of one task in stream order, and the active records among them, keyed by evidence id.
 * The scope is the task, the static-analysis ladder requirement and the phase attempt of the latest record of the task.
 * Inside that phase attempt, the scope spans branches and bases.
 * A record that another record of the scope names in `supersedesEvidenceId` is not active.
 */
interface TaskRecords {
  readonly all: readonly AdmissionEvidenceRecorded[];
  readonly active: ReadonlyMap<string, AdmissionEvidenceRecorded>;
}

/**
 * Selects the records of the task from the gate records of the stream. The shared reader keeps the stream order.
 * Only the records of the phase attempt of the latest record of the task count.
 * The gate runner supersedes a record only inside its own phase attempt, and a caller cannot choose the phase attempt of a run.
 * Phase attempts follow one another, so the latest attempt holds the current evidence.
 * A failing record of an earlier attempt thus does not refuse the task for ever.
 */
function taskRecords(records: ReadonlyMap<string, AdmissionEvidenceRecorded>, taskId: string): TaskRecords {
  const ofTask = [...records.values()].filter(
    ({ evidence }) =>
      evidence.requirementId === STATIC_ANALYSIS_REQUIREMENT &&
      evidence.subject.kind === 'task' &&
      evidence.subject.taskId === taskId,
  );
  const latestAttempt = ofTask.at(-1)?.evidence.phaseAttemptId;
  const all = ofTask.filter(({ evidence }) => evidence.phaseAttemptId === latestAttempt);
  const superseded = new Set(
    all.flatMap((record) => (record.supersedesEvidenceId === undefined ? [] : [record.supersedesEvidenceId])),
  );
  return {
    all,
    active: new Map(
      all
        .filter(({ evidence }) => !superseded.has(evidence.evidenceId))
        .map((record): [string, AdmissionEvidenceRecorded] => [record.evidence.evidenceId, record]),
    ),
  };
}

/**
 * Whether two records are in one chain of runs: the same subject, phase attempt, provider and policy.
 * The subject holds the task, the branch and the base. The gate runner supersedes a record only inside its chain.
 * The records that the completion reads share one phase attempt, so two chains of a task differ in branch or base.
 */
function sameChain(left: AdmissionEvidenceRecorded, right: AdmissionEvidenceRecorded): boolean {
  return (
    JSON.stringify(left.evidence.subject) === JSON.stringify(right.evidence.subject) &&
    left.evidence.phaseAttemptId === right.evidence.phaseAttemptId &&
    left.evidence.producer.providerRef === right.evidence.producer.providerRef &&
    JSON.stringify(left.evidence.policyDigest) === JSON.stringify(right.evidence.policyDigest)
  );
}

/**
 * The evidence record that gives the cause of a refusal.
 * `inLatestChain` is true when the record is in the chain of the latest static-analysis record of the task.
 */
interface CauseRecord {
  readonly evidenceId: string;
  readonly inLatestChain: boolean;
}

/**
 * Why the static-analysis prerequisite of a task holds or does not hold.
 * `no-runner-verdict` says whether the task has a runner row. `skipped-check` carries the skipped checks that the runner row names.
 * `no-toolchain` is a no-toolchain skip that is the latest record of the task. `earlier-no-toolchain` is one that is not.
 * `no-recorded-cause` is a record whose runner row is absent or names no known skip cause, as a row of an earlier build does.
 */
type StaticAnalysisPrerequisite =
  | { readonly kind: 'pass' }
  | { readonly kind: 'no-runner-verdict'; readonly latestRow: boolean }
  | { readonly kind: 'failed'; readonly record: CauseRecord }
  | { readonly kind: 'skipped-check'; readonly record: CauseRecord; readonly skippedChecks: string | undefined }
  | { readonly kind: 'no-toolchain' }
  | { readonly kind: 'earlier-no-toolchain'; readonly record: CauseRecord }
  | { readonly kind: 'no-recorded-cause'; readonly record: CauseRecord; readonly skipped: boolean };

/** The causes of a refusal. */
type StaticAnalysisRefusalCause = Exclude<StaticAnalysisPrerequisite, { readonly kind: 'pass' }>;

/** The skip discriminant of a static-analysis run with no supported toolchain. */
const NO_TOOLCHAIN: StaticAnalysisSkipReason = 'no-toolchain';

/** The skip discriminant of a static-analysis run in which a check did not run. */
const CONSTITUENT_SKIPPED: StaticAnalysisSkipReason = 'constituent-skipped';

/**
 * The active record that gives the cause of a refusal, or undefined when each active record passes.
 * A failing record wins over a record with no verdict. Inside that group, a record in the chain of the latest record wins.
 * Then the later record wins.
 */
function causeRecordOf(
  active: ReadonlyMap<string, AdmissionEvidenceRecorded>,
  latest: AdmissionEvidenceRecorded | undefined,
): AdmissionEvidenceRecorded | undefined {
  const notPassing = [...active.values()].filter(({ evidence }) => evidence.verdict !== 'pass');
  const failing = notPassing.filter(({ evidence }) => evidence.verdict === 'fail');
  const pool = failing.length > 0 ? failing : notPassing;
  return lastMatch(pool, (record) => latest !== undefined && sameChain(record, latest)) ?? pool.at(-1);
}

/**
 * The cause of a refusal from an active record that does not pass. The verdict of the record tells a fail from a run with no verdict.
 * For a run with no verdict, the latest runner row of the record gives the skip cause by its closed `discriminant` code.
 * A no-toolchain skip says that no rerun helps only when it is the latest record of the task.
 */
function recordCause(
  record: AdmissionEvidenceRecorded,
  latest: AdmissionEvidenceRecorded,
  signals: readonly RunnerSignal[],
): StaticAnalysisRefusalCause {
  const { evidenceId } = record.evidence;
  const cause: CauseRecord = { evidenceId, inLatestChain: sameChain(record, latest) };
  if (record.evidence.verdict === 'fail') return { kind: 'failed', record: cause };
  const skip = lastMatch(signals, (signal) => signal.evidenceId === evidenceId)?.skip;
  if (skip?.discriminant === CONSTITUENT_SKIPPED) {
    return { kind: 'skipped-check', record: cause, skippedChecks: skip.reason };
  }
  if (skip?.discriminant === NO_TOOLCHAIN) {
    return evidenceId === latest.evidence.evidenceId
      ? { kind: 'no-toolchain' }
      : { kind: 'earlier-no-toolchain', record: cause };
  }
  return { kind: 'no-recorded-cause', record: cause, skipped: skip !== undefined };
}

/**
 * Whether the gate runner recorded a passing static-analysis verdict for the task, and the cause when it did not.
 * The active records are the records of the phase attempt of the latest record of the task.
 * The latest runner signal for the task must pass and cite an active passing record of the task.
 * Any other active record of the task that does not pass refuses, so two active records that disagree refuse.
 * A later failing run thus wins over an earlier pass, also when the signal of the later run is lost.
 * The shared reader stays a total parse, so this selection does not change the evidence resolution of settlement.
 *
 * The cause of a refusal comes from the active records. A runner row gives only the skip cause of its own record.
 */
async function staticAnalysisPrerequisite(
  store: EventStore,
  streamId: string,
  taskId: string,
): Promise<StaticAnalysisPrerequisite> {
  const signals = await runnerSignals(store, streamId, taskId);
  const { all, active } = taskRecords(await readGateEvidenceRecords(store, streamId), taskId);
  const latestSignal = signals.at(-1);
  const latestRecord = all.at(-1);
  const cited = causeRecordOf(active, latestRecord);
  if (cited === undefined && latestSignal?.passed === true && active.has(latestSignal.evidenceId)) {
    return { kind: 'pass' };
  }
  if (cited === undefined || latestRecord === undefined) {
    return { kind: 'no-runner-verdict', latestRow: latestSignal !== undefined };
  }
  return recordCause(cited, latestRecord, signals);
}

/** The template variable of the static-analysis step that the refusal fills with the task id. */
const TASK_ID_VARIABLE = '<taskId>';

/** A step param value that is a template variable, for example `<worktreePath>`. */
const TEMPLATE_VARIABLE = /^<[A-Za-z]+>$/;

/**
 * The rerun of the static-analysis step for one task, built from the params of the runbook step.
 * The task id fills its variable. The text tells the caller to fill each other variable.
 * For a record outside the chain of the latest run, the rerun also names the branch and the base of that record.
 */
function staticAnalysisRerun(taskId: string, otherChain: CauseRecord | undefined): string {
  const entries = Object.entries(STATIC_ANALYSIS_STEP_PARAMS);
  const params = entries.map(([name, value]) => `${name} '${value.replaceAll(TASK_ID_VARIABLE, taskId)}'`);
  const chain = otherChain === undefined ? '' : ' and the branch and baseBranch of that run';
  const unfilled = entries
    .map(([, value]) => value)
    .filter((value) => TEMPLATE_VARIABLE.test(value) && value !== TASK_ID_VARIABLE);
  const fill = unfilled.length === 0 ? '' : ` (replace ${unfilled.join(' and ')} with the value for this task)`;
  return (
    `run exarchos_orchestrate check_static_analysis with ${params.join(', ')}${chain}${fill}, ` +
    'then call task_complete again. ' +
    'Under settle, correct the cause and settle the claim under a new batch id instead.'
  );
}

/** The record of a refusal cause when that record is outside the chain of the latest run, else undefined. */
function otherChainRecord(cause: StaticAnalysisRefusalCause): CauseRecord | undefined {
  return 'record' in cause && !cause.record.inLatestChain ? cause.record : undefined;
}

/**
 * The recovery that the refusal names for each cause. The record is total over the causes, so a new cause without a recovery does not compile.
 * Each function gets the rerun of the static-analysis step, which comes from the params of the step of the completion runbooks.
 */
const REFUSAL_RECOVERIES: Readonly<Record<StaticAnalysisRefusalCause['kind'], (rerun: string) => string>> = {
  'no-runner-verdict': (rerun) => `To record a verdict, ${rerun}`,
  failed: (rerun) => `Fix the failing checks that the check_static_analysis report names. Then ${rerun}`,
  'skipped-check': (rerun) => `Add the missing scripts, or do not set the skip flags. Then ${rerun}`,
  'no-toolchain': () =>
    'A task cannot complete in this repository until static analysis can run configured commands (#1540). ' +
    'A rerun gives the same skip.',
  'earlier-no-toolchain': (rerun) => `Make sure that the run scans the worktree of the task. Then ${rerun}`,
  'no-recorded-cause': (rerun) => `To find the cause, ${rerun}`,
};

/** The subject of a cause sentence: the latest run of the task, or the named record outside the chain of the latest run. */
function causeSubject(record: CauseRecord, taskId: string, noun: 'run' | 'verdict'): string {
  return record.inLatestChain
    ? `The latest static-analysis ${noun} for task '${taskId}'`
    : namedRecordSubject(record, taskId, noun);
}

/** The subject of a cause sentence that names the record by its evidence id. */
function namedRecordSubject(record: CauseRecord, taskId: string, noun: 'run' | 'verdict'): string {
  return `The static-analysis ${noun} of evidence '${record.evidenceId}' for task '${taskId}'`;
}

/** The sentence that says why a record outside the chain of the latest run still counts, or an empty text. */
function chainSentence(record: CauseRecord): string {
  return record.inLatestChain
    ? ''
    : ' That run is on another branch or base than the latest run of the task, ' +
        'and no later run on its branch and base superseded it.';
}

/** The sentence that names the cause of a refusal for the task. */
function refusalCauseText(cause: StaticAnalysisRefusalCause, taskId: string): string {
  switch (cause.kind) {
    case 'no-runner-verdict':
      return cause.latestRow
        ? `The latest runner row for task '${taskId}' is not a pass of an active static-analysis record, so it does not count.`
        : `The gate runner recorded no static-analysis verdict for task '${taskId}'.`;
    case 'failed':
      return `${causeSubject(cause.record, taskId, 'verdict')} is a fail.${chainSentence(cause.record)}`;
    case 'skipped-check':
      return cause.skippedChecks === undefined
        ? `${causeSubject(cause.record, taskId, 'run')} skipped a check, so it is not a pass. ` +
            `The check_static_analysis report names the check.${chainSentence(cause.record)}`
        : `${causeSubject(cause.record, taskId, 'run')} skipped a check, so it is not a pass: ` +
            `${cause.skippedChecks}.${chainSentence(cause.record)}`;
    case 'no-toolchain':
      return (
        `The latest static-analysis run for task '${taskId}' is a skip, ` +
        'because the repository has no supported static-analysis toolchain.'
      );
    case 'earlier-no-toolchain':
      return (
        `${namedRecordSubject(cause.record, taskId, 'run')} is a skip, because it found no supported static-analysis ` +
        `toolchain in the scanned directory. A later run of the task is not this skip.${chainSentence(cause.record)}`
      );
    case 'no-recorded-cause':
      return cause.skipped
        ? `${causeSubject(cause.record, taskId, 'run')} is a skip with no recorded cause.${chainSentence(cause.record)}`
        : `${causeSubject(cause.record, taskId, 'run')} is not a pass, and no runner row records its cause.` +
            chainSentence(cause.record);
    default:
      return assertNever(cause, 'static-analysis refusal cause');
  }
}

/** The `GATE_NOT_PASSED` refusal for one cause. It names the gate, the cause and the recovery of that cause. */
function gateNotPassed(cause: StaticAnalysisRefusalCause, taskId: string): ToolResult {
  const rerun = staticAnalysisRerun(taskId, otherChainRecord(cause));
  return {
    success: false,
    error: {
      code: 'GATE_NOT_PASSED',
      message:
        `Required gates not passed: ${STATIC_ANALYSIS_GATE}. ${refusalCauseText(cause, taskId)} ` +
        REFUSAL_RECOVERIES[cause.kind](rerun),
      unmetGates: [STATIC_ANALYSIS_GATE],
    },
  };
}

/** The idempotency key of the `task.completed` row of one task. */
function completionKey(streamId: string, taskId: string): string {
  return `${streamId}:task.completed:${taskId}`;
}

/** The `task.completed` row stored under the completion key of the task, or undefined when none exists. */
async function storedCompletion(
  store: EventStore,
  streamId: string,
  taskId: string,
): Promise<WorkflowEvent | undefined> {
  const key = completionKey(streamId, taskId);
  const rows = await store.query(streamId, { type: 'task.completed' });
  return rows.find((row) => row.idempotencyKey === key);
}

/** Marks the task complete on the state document that the transition guards read, and returns the outcome of the sync. */
function syncTaskDocument(stateDir: string, streamId: string, taskId: string): Promise<TaskStatusSyncOutcome> {
  return markTasksCompleteInStateDocument(path.join(stateDir, `${streamId}.state.json`), [taskId]);
}

/**
 * The result of a completion for one outcome of the document sync, beside the ack of the `task.completed` row.
 * A skipped sync is logged. A failed sync returns `STATE_SYNC_FAILED`.
 */
function completionResult(
  streamId: string,
  taskId: string,
  event: WorkflowEvent,
  sync: TaskStatusSyncOutcome,
): ToolResult {
  if (sync.kind === 'skipped') {
    const detail = { streamId, taskId, reason: sync.reason };
    const message = `task_complete state sync skipped: ${SYNC_SKIP_REASONS[sync.reason]}`;
    if (sync.reason === 'no-document') logger.debug(detail, message);
    else logger.warn(detail, message);
  } else if (sync.kind === 'failed') {
    logger.warn(
      { streamId, taskId, attempt: sync.attempts, err: sync.error },
      'task_complete state sync failed',
    );
    return {
      success: false,
      data: toEventAck(event),
      error: {
        code: 'STATE_SYNC_FAILED',
        message:
          `task ${taskId} is recorded complete (task.completed at sequence ${event.sequence}), but ` +
          'the state document the transition guards read could not be updated after ' +
          `${sync.attempts} attempt(s): ${sync.error}. Run \`exarchos_workflow reconcile\`, then retry ` +
          'task_complete. The fact is not recorded twice. If the refusal comes back, stop and report it ' +
          'to a person.',
      },
    };
  }

  return { success: true, data: toEventAck(event) };
}

/**
 * The result for a stored `task.completed` row of the task while the state document lists the task with another status.
 * The sync brings the document level with the row, and the result returns the row with no gate check and no new row.
 * A failed sync returns `STATE_SYNC_FAILED`.
 * When the document already lists the task complete, or does not list the task, the function returns undefined.
 * The gate check then runs, so a fix of a completed task needs a passing run.
 */
async function repairStoredCompletion(
  stateDir: string,
  streamId: string,
  taskId: string,
  stored: WorkflowEvent,
): Promise<ToolResult | undefined> {
  const sync = await syncTaskDocument(stateDir, streamId, taskId);
  if (sync.kind === 'synced' || sync.kind === 'failed') return completionResult(streamId, taskId, stored, sync);
  return undefined;
}

/** The `COMPLETE_FAILED` result for an error that the completion read, append or sync threw. */
function completeFailed(err: unknown): ToolResult {
  return {
    success: false,
    error: {
      code: 'COMPLETE_FAILED',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/**
 * Records `task.completed` when the gate runner recorded a passing static-analysis verdict for the task.
 * Caller evidence never satisfies a blocking gate. For an advisory gate, it needs passing output and an operator capability.
 * The transport puts that capability in the dispatch context, so the caller cannot assert it.
 *
 * The gate check reads the latest runner row for this task and the active evidence records of the task.
 * A refusal names its cause and the recovery of that cause.
 * The generic append refuses `gate.executed`, so only a gate handler writes the row.
 * The task-completion runbook runs the tier-scaled kill probe before this step.
 *
 * The handler forwards `worktree` and `worktreePath` for the `mergePendingEntry` guard.
 * After the append, it syncs the state document that the transition guards read. A failed sync returns `STATE_SYNC_FAILED`.
 * Before the gate check, a retry syncs the document and returns the stored row when the document shows the task with another status.
 */
export async function handleTaskComplete(
  args: {
    taskId: string;
    result?: Record<string, unknown>;
    evidence?: {
      type: 'test' | 'build' | 'typecheck' | 'manual';
      output: string;
      passed: boolean;
    };
    streamId?: string;
    featureId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  const identity = resolveStreamIdentity(args);
  if (!identity.ok) return identity.error;
  const streamId = identity.streamId;

  const store = eventStore;

  try {
    const stored = await storedCompletion(store, streamId, args.taskId);
    const repaired =
      stored === undefined ? undefined : await repairStoredCompletion(stateDir, streamId, args.taskId, stored);
    if (repaired !== undefined) return repaired;
  } catch (err) {
    return completeFailed(err);
  }

  const evidenceIsSubstantive =
    args.evidence?.passed === true && (args.evidence.output ?? '').trim().length > 0;

  const authorization = getDispatchContext()?.authorization;
  const hasOperatorCapability =
    authorization !== undefined &&
    authorization.identity.role === 'operator' &&
    authorization.posture !== 'read-only';

  const evidenceMaySatisfy = (gateName: string): boolean => {
    if (!evidenceIsSubstantive) return false;
    if (isBlockingGate(gateName)) return false;
    return hasOperatorCapability;
  };

  const prerequisite = evidenceMaySatisfy(STATIC_ANALYSIS_GATE)
    ? undefined
    : await staticAnalysisPrerequisite(store, streamId, args.taskId);
  if (prerequisite !== undefined && prerequisite.kind !== 'pass') {
    return gateNotPassed(prerequisite, args.taskId);
  }

  const data: Record<string, unknown> = { taskId: args.taskId };
  if (args.result) {
    if (args.result.artifacts) {
      data.artifacts = args.result.artifacts;
    }
    if (args.result.duration !== undefined) {
      data.duration = args.result.duration;
    }
    if (args.result.implements) {
      data.implements = args.result.implements;
    }
    if (args.result.tests) {
      data.tests = args.result.tests;
    }
    if (args.result.files) {
      data.files = args.result.files;
    }
    if (typeof args.result.worktree === 'string' && args.result.worktree.length > 0) {
      data.worktree = args.result.worktree;
    }
    if (
      typeof args.result.worktreePath === 'string' &&
      args.result.worktreePath.length > 0
    ) {
      data.worktreePath = args.result.worktreePath;
    }
  }

  if (args.evidence) {
    data.evidence = args.evidence;
    data.verified = true;
  } else {
    data.verified = false;
  }

  try {
    const event = await store.append(streamId, {
      type: 'task.completed',
      data,
    }, { idempotencyKey: completionKey(streamId, args.taskId) });
    return completionResult(streamId, args.taskId, event, await syncTaskDocument(stateDir, streamId, args.taskId));
  } catch (err) {
    return completeFailed(err);
  }
}

export async function handleTaskFail(
  args: {
    taskId: string;
    error: string;
    diagnostics?: Record<string, unknown>;
    streamId?: string;
    featureId?: string;
  },
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.error) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'error is required' },
    };
  }

  const identity = resolveStreamIdentity(args);
  if (!identity.ok) return identity.error;
  const streamId = identity.streamId;

  const store = eventStore;

  const data: Record<string, unknown> = {
    taskId: args.taskId,
    error: args.error,
  };

  if (args.diagnostics) {
    data.diagnostics = args.diagnostics;
  }

  try {
    const event = await store.append(streamId, {
      type: 'task.failed',
      data,
    }, { idempotencyKey: `${streamId}:task.failed:${args.taskId}` });

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'FAIL_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

