/** Handlers for the task verbs: claim, complete, and fail. */

import { foldToTail } from '../../projections/fold-at-tail.js';
import * as path from 'node:path';
import { EventStore, SequenceConflictError } from '../../events/store.js';
import { GateExecutedData, validateAgentEvent, type GateExecuted } from '../../events/schemas.js';
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
import { gateRunnerObservationSource } from '../gates/gate-runner.js';

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

/**
 * Whether the gate runner recorded a passing static-analysis verdict for the task.
 * The function reads the latest `gate.executed` row with the runner source and the task at `details.taskId`.
 * That row must pass. Its evidence id must resolve to a passing gate record of the ladder requirement for the same task.
 * A row with no task id satisfies no task, and the function does not read a top-level `data.taskId`.
 * A later failing run thus wins over an earlier pass.
 */
async function hasRunnerStaticAnalysisPass(
  store: EventStore,
  streamId: string,
  taskId: string,
): Promise<boolean> {
  const runnerSource = gateRunnerObservationSource(STATIC_ANALYSIS_GATE);
  const rows = await store.query(streamId, { type: 'gate.executed' });
  let latest: { readonly sequence: number; readonly signal: GateExecuted } | undefined;
  for (const row of rows) {
    if (row.source !== runnerSource) continue;
    const parsed = GateExecutedData.safeParse(row.data);
    if (!parsed.success || parsed.data.gateName !== STATIC_ANALYSIS_GATE) continue;
    if (parsed.data.details?.taskId !== taskId) continue;
    if (latest === undefined || row.sequence > latest.sequence) {
      latest = { sequence: row.sequence, signal: parsed.data };
    }
  }
  if (latest === undefined || latest.signal.passed !== true) return false;

  const evidenceId = latest.signal.details?.evidenceId;
  if (typeof evidenceId !== 'string') return false;
  const record = (await readGateEvidenceRecords(store, streamId)).get(evidenceId);
  if (record === undefined) return false;
  const { evidence } = record;
  return (
    evidence.requirementId === ladderRequirementId(STATIC_ANALYSIS_GATE) &&
    evidence.subject.kind === 'task' &&
    evidence.subject.taskId === taskId &&
    evidence.verdict === 'pass'
  );
}

/**
 * Records `task.completed` when the gate runner recorded a passing static-analysis verdict for the task.
 * Caller evidence never satisfies a blocking gate. For an advisory gate, it needs passing output and an operator capability.
 * The transport puts that capability in the dispatch context, so the caller cannot assert it.
 *
 * The gate check reads the runner row for this task and the evidence record that the row cites.
 * The generic append refuses `gate.executed`, so only a gate handler writes the row.
 * The task-completion runbook runs the tier-scaled kill probe before this step.
 *
 * The handler forwards `worktree` and `worktreePath` for the `mergePendingEntry` guard.
 * After the append, it syncs the state document that the transition guards read. A failed sync returns `STATE_SYNC_FAILED`.
 * A retry repairs it, because the task-keyed idempotency key returns the stored event.
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

  const unmetGates: string[] = [];
  if (
    !evidenceMaySatisfy(STATIC_ANALYSIS_GATE) &&
    !(await hasRunnerStaticAnalysisPass(store, streamId, args.taskId))
  ) {
    unmetGates.push(STATIC_ANALYSIS_GATE);
  }
  if (unmetGates.length > 0) {
    return {
      success: false,
      error: {
        code: 'GATE_NOT_PASSED',
        message:
          `Required gates not passed: ${unmetGates.join(', ')}. Run exarchos_orchestrate ` +
          `check_static_analysis with taskId '${args.taskId}' for this task, then call task_complete again.`,
        unmetGates,
      },
    };
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
    }, { idempotencyKey: `${streamId}:task.completed:${args.taskId}` });

    const stateFile = path.join(stateDir, `${streamId}.state.json`);
    const sync = await markTasksCompleteInStateDocument(stateFile, [args.taskId]);
    if (sync.kind === 'skipped') {
      const detail = { streamId: streamId, taskId: args.taskId, reason: sync.reason };
      const message = `task_complete state sync skipped: ${SYNC_SKIP_REASONS[sync.reason]}`;
      if (sync.reason === 'no-document') logger.debug(detail, message);
      else logger.warn(detail, message);
    } else if (sync.kind === 'failed') {
      logger.warn(
        { streamId: streamId, taskId: args.taskId, attempt: sync.attempts, err: sync.error },
        'task_complete state sync failed',
      );
      return {
        success: false,
        data: toEventAck(event),
        error: {
          code: 'STATE_SYNC_FAILED',
          message:
            `task ${args.taskId} is recorded complete (task.completed at sequence ${event.sequence}), but ` +
            'the state document the transition guards read could not be updated after ' +
            `${sync.attempts} attempt(s): ${sync.error}. Run \`exarchos_workflow reconcile\`, then retry ` +
            'task_complete. The fact is not recorded twice. If the refusal comes back, stop and report it ' +
            'to a person.',
        },
      };
    }

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'COMPLETE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
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

