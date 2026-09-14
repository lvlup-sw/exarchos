// ─── Partitioning a plan into one delegation batch ───────────────────────────
//
// The batch is every planned task not yet complete. Its dependency edges come
// from each task's `blockedBy`, and only the edges that still bind survive:
//
//   • a blocker inside the batch becomes an edge — the harness must finish it
//     first;
//   • a blocker already complete is satisfied, and an edge to it would make the
//     capsule wait on work that is done;
//   • a blocker the plan does not contain at all is refused. Dropping it would
//     compile a capsule that silently lost an ordering the plan asked for.
//
// Tasks nothing waits on are the batch's sinks. When there are two or more, one
// join waits for all of them, so the capsule states where the batch rejoins
// rather than leaving the harness to infer it.
//
// Cycles are NOT detected here. The capsule's reference pass already refuses a
// cyclic graph, and a second cycle check in this module would be a second
// answer to a question that pass owns.

import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';
import type { PrepareRefusal } from './types.js';

/** The kernel step every delegated task compiles from. */
export const DELEGATION_STEP_ID = 'delegate';

/** The join the batch's sinks rejoin at, when there is more than one. */
export const BATCH_JOIN_ID = 'batch-complete';

const COMPLETE_STATUSES: ReadonlySet<string> = new Set(['complete', 'completed']);

/** The capsule's own title bound. A longer plan title is shortened, not refused. */
const TITLE_LIMIT = 256;

export interface BatchTask {
  readonly taskId: string;
  readonly title: string;
  readonly stepId: string;
}

export interface DelegationBatch {
  readonly tasks: readonly BatchTask[];
  readonly dependencies: readonly { readonly from: string; readonly to: string }[];
  readonly joins: readonly { readonly joinId: string; readonly waitsFor: readonly string[] }[];
  /** Every task in the batch must report for the batch to settle. */
  readonly requiredResults: readonly string[];
}

export type PartitionOutcome =
  | { readonly ok: true; readonly batch: DelegationBatch }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly blockedBy: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPlannedTask(entry: unknown, index: number): PlannedTask | PrepareRefusal {
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
  return { id, title, complete, blockedBy };
}

/** Partition the projected task list into the batch still to be delegated. */
export function partitionDelegationBatch(tasks: readonly unknown[]): PartitionOutcome {
  const planned: PlannedTask[] = [];
  for (const [index, entry] of tasks.entries()) {
    const read = readPlannedTask(entry, index);
    if ('code' in read) return { ok: false, refusal: read };
    planned.push(read);
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

  const inBatch = new Set(pending.map((task) => task.id));
  const done = new Set(planned.filter((task) => task.complete).map((task) => task.id));
  const dependencies: { from: string; to: string }[] = [];
  for (const task of pending) {
    for (const blocker of task.blockedBy) {
      if (inBatch.has(blocker)) {
        dependencies.push({ from: blocker, to: task.id });
        continue;
      }
      if (done.has(blocker)) continue;
      return {
        ok: false,
        refusal: {
          code: 'UNKNOWN_DEPENDENCY',
          message: `task ${JSON.stringify(task.id)} waits on ${JSON.stringify(blocker)}, which the plan does not contain`,
        },
      };
    }
  }

  const waitedOn = new Set(dependencies.map((edge) => edge.from));
  const sinks = pending.filter((task) => !waitedOn.has(task.id)).map((task) => task.id);

  return {
    ok: true,
    batch: {
      tasks: pending.map((task) => ({ taskId: task.id, title: task.title, stepId: DELEGATION_STEP_ID })),
      dependencies,
      joins: sinks.length >= 2 ? [{ joinId: BATCH_JOIN_ID, waitsFor: sinks }] : [],
      requiredResults: pending.map((task) => task.id),
    },
  };
}
