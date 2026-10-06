/**
 * Partitions a plan into one delegation batch: the ready frontier of the plan.
 * The frontier is each task that is not complete and whose `blockedBy` tasks are all complete.
 * A task that waits on pending work goes to a later preparation, after its blockers settle.
 * Thus a capsule never holds a task that must fork from the work of another task in it.
 *
 * A blocker that the plan does not contain is refused, because dropping it loses an ordering of the plan.
 * Pending tasks with no ready task among them are refused too, and the refusal names what each one waits on.
 *
 * Each task carries the verification terms that it settles under. A planner stamp wins over the file-and-layer heuristic.
 * The capsule freezes these terms, because they choose the gates that judge the task.
 */

import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import {
  deriveBoundaryTouching,
  deriveRiskTier,
  type TaskInput,
} from '../team/prepare-delegation.js';
import type { PrepareRefusal } from './types.js';

/** The kernel step every delegated task compiles from. */
export const DELEGATION_STEP_ID = 'delegate';

/** The join the batch's sinks rejoin at, when there is more than one. */
export const BATCH_JOIN_ID = 'batch-complete';

const COMPLETE_STATUSES: ReadonlySet<string> = new Set(['complete', 'completed']);

/** The capsule's own title bound. A longer plan title is shortened, not refused. */
const TITLE_LIMIT = 256;

/** The verification terms one task settles under, as the plan resolves them. */
export interface BatchTaskVerification {
  readonly riskTier: RiskTier;
  readonly boundaryTouching: boolean;
}

export interface BatchTask {
  readonly taskId: string;
  readonly title: string;
  readonly stepId: string;
  readonly verification: BatchTaskVerification;
}

export interface DelegationBatch {
  readonly tasks: readonly BatchTask[];
  /** Edges between tasks of the batch. A ready frontier has none, but the compiler maps any edge that it gets. */
  readonly dependencies: readonly { readonly from: string; readonly to: string }[];
  readonly joins: readonly { readonly joinId: string; readonly waitsFor: readonly string[] }[];
  /** Every task in the batch must report for the batch to settle. */
  readonly requiredResults: readonly string[];
}

export type PartitionOutcome =
  | { readonly ok: true; readonly batch: DelegationBatch }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/** One entry of the plan, as the plan reader resolves it. Settlement reads `complete` to learn how a task stands. */
export interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly blockedBy: readonly string[];
  readonly verification: BatchTaskVerification;
}

function isRiskTier(value: unknown): value is RiskTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isTestLayer(value: unknown): value is NonNullable<TaskInput['testLayer']> {
  return value === 'acceptance' || value === 'integration' || value === 'unit' || value === 'property';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the verification terms of a planned task. It refuses a planner stamp outside its
 * vocabulary and does not ignore it, because a derived tier can judge a high-risk task as medium.
 */
function readVerification(entry: Record<string, unknown>, id: string): BatchTaskVerification | PrepareRefusal {
  const riskTier = entry.riskTier;
  if (riskTier !== undefined && !isRiskTier(riskTier)) {
    return {
      code: 'INVALID_TASK_STAMP',
      message: `planned task ${JSON.stringify(id)} carries riskTier ${JSON.stringify(riskTier)}; a tier is low, medium or high`,
    };
  }
  const boundaryTouching = entry.boundaryTouching;
  if (boundaryTouching !== undefined && typeof boundaryTouching !== 'boolean') {
    return {
      code: 'INVALID_TASK_STAMP',
      message: `planned task ${JSON.stringify(id)} carries boundaryTouching ${JSON.stringify(boundaryTouching)}; the flag is a boolean`,
    };
  }
  const testLayer = entry.testLayer;
  const stamp: TaskInput = {
    id,
    title: id,
    blockedBy: Array.isArray(entry.blockedBy) ? entry.blockedBy.filter((ref): ref is string => typeof ref === 'string') : [],
    files: Array.isArray(entry.files) ? entry.files.filter((file): file is string => typeof file === 'string') : [],
    ...(isTestLayer(testLayer) ? { testLayer } : {}),
    ...(riskTier !== undefined ? { riskTier } : {}),
    ...(boundaryTouching !== undefined ? { boundaryTouching } : {}),
  };
  return { riskTier: deriveRiskTier(stamp), boundaryTouching: deriveBoundaryTouching(stamp) };
}

/**
 * Reads one entry of the plan. It refuses an entry with no stable id, and an entry with a stamp
 * outside its vocabulary. A caller that reads the plan entry by entry can skip a refused entry
 * and keep the others.
 */
export function readPlannedTask(entry: unknown, index: number): PlannedTask | PrepareRefusal {
  if (!isRecord(entry) || typeof entry.id !== 'string') {
    return { code: 'INVALID_TASK_ID', message: `planned task ${index} carries no id` };
  }
  const id = entry.id;
  if (!SharedStableIdSchema.safeParse(id).success) {
    return {
      code: 'INVALID_TASK_ID',
      message:
        `planned task id ${JSON.stringify(id)} is not a stable id — a capsule names tasks by ` +
        'letters, digits, dot, underscore, colon and hyphen',
    };
  }
  const rawTitle = typeof entry.title === 'string' && entry.title.trim().length > 0 ? entry.title : id;
  const title = rawTitle.length > TITLE_LIMIT ? `${rawTitle.slice(0, TITLE_LIMIT - 1)}…` : rawTitle;
  const blockedBy = Array.isArray(entry.blockedBy)
    ? entry.blockedBy.filter((ref): ref is string => typeof ref === 'string')
    : [];
  const complete = typeof entry.status === 'string' && COMPLETE_STATUSES.has(entry.status);
  const verification = readVerification(entry, id);
  if ('code' in verification) return verification;
  return { id, title, complete, blockedBy, verification };
}

/** What each pending task waits on that is not yet complete, as a refusal names it. */
function describeWaits(pending: readonly PlannedTask[], done: ReadonlySet<string>): string {
  return pending
    .map((task) => {
      const waits = task.blockedBy.filter((blocker) => !done.has(blocker));
      return `${JSON.stringify(task.id)} waits on ${waits.map((id) => JSON.stringify(id)).join(', ')}`;
    })
    .join('; ');
}

/**
 * The first task id that the plan names twice, if any. The check covers the whole plan before the
 * frontier is chosen. A frontier with one copy hides the other copy from the duplicate check of the
 * capsule, and then settlement cannot tell the two tasks apart.
 */
function firstDuplicateId(planned: readonly PlannedTask[]): string | undefined {
  const seen = new Set<string>();
  for (const task of planned) {
    if (seen.has(task.id)) return task.id;
    seen.add(task.id);
  }
  return undefined;
}

/** Partition the projected task list into the ready frontier still to be delegated. */
export function partitionDelegationBatch(tasks: readonly unknown[]): PartitionOutcome {
  const planned: PlannedTask[] = [];
  for (const [index, entry] of tasks.entries()) {
    const read = readPlannedTask(entry, index);
    if ('code' in read) return { ok: false, refusal: read };
    planned.push(read);
  }
  const duplicate = firstDuplicateId(planned);
  if (duplicate !== undefined) {
    return {
      ok: false,
      refusal: {
        code: 'INVALID_TASK_ID',
        message: `planned task id ${JSON.stringify(duplicate)} appears more than once; a capsule names each task once`,
      },
    };
  }

  const pending = planned.filter((task) => !task.complete);
  if (pending.length === 0) {
    return {
      ok: false,
      refusal: {
        code: 'NOTHING_TO_PREPARE',
        message:
          planned.length === 0
            ? 'the workflow has no planned tasks, so there is no batch to compile'
            : `all ${planned.length} planned task(s) are complete, so there is no batch to compile`,
      },
    };
  }

  const known = new Set(planned.map((task) => task.id));
  for (const task of pending) {
    const unknown = task.blockedBy.find((blocker) => !known.has(blocker));
    if (unknown === undefined) continue;
    return {
      ok: false,
      refusal: {
        code: 'UNKNOWN_DEPENDENCY',
        message: `task ${JSON.stringify(task.id)} waits on ${JSON.stringify(unknown)}, which the plan does not contain`,
      },
    };
  }

  const done = new Set(planned.filter((task) => task.complete).map((task) => task.id));
  const ready = pending.filter((task) => task.blockedBy.every((blocker) => done.has(blocker)));
  if (ready.length === 0) {
    const blocking = [...new Set(pending.flatMap((task) => task.blockedBy.filter((b) => !done.has(b))))];
    return {
      ok: false,
      refusal: {
        code: 'NO_READY_TASKS',
        message:
          `none of the ${pending.length} pending task(s) is ready to delegate: ${describeWaits(pending, done)}. ` +
          `A task is ready when every task it waits on is complete. Complete ${blocking
            .map((id) => JSON.stringify(id))
            .join(', ')} first; tasks that wait on each other form a cycle the plan must break.`,
      },
    };
  }

  const ids = ready.map((task) => task.id);
  return {
    ok: true,
    batch: {
      tasks: ready.map((task) => ({
        taskId: task.id,
        title: task.title,
        stepId: DELEGATION_STEP_ID,
        verification: task.verification,
      })),
      dependencies: [],
      joins: ids.length >= 2 ? [{ joinId: BATCH_JOIN_ID, waitsFor: ids }] : [],
      requiredResults: ids,
    },
  };
}
