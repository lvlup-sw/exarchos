/**
 * The recompiled slice of a plan. A design revision names the unfinished tasks that an accepted
 * change affects. The first prepare after the revision is a continuation, and it records which
 * unfinished tasks the change invalidated.
 *
 * This module holds the two pure functions of that record. One reads the pending revision from
 * the rows of a stream. The other walks the plan from the tasks that the revision names.
 * Neither function reads a store, a clock or a file.
 */

import { DesignRevisedData, WorkflowPreparedData, type EventType } from '../../events/schemas.js';
import { DESIGN_REVISED_TYPE } from './design-version.js';
import { readPlannedTask, type PlannedTask } from './partition-tasks.js';

/** The event that records one compilation. A revision row after the latest one is pending. */
const WORKFLOW_PREPARED_TYPE = 'workflow.prepared' satisfies EventType;

/** The design revisions of a stream that no capsule was compiled under. */
export interface PendingRevision {
  /** The capsule version of the latest prepared record. */
  readonly priorCapsuleVersion: number;
  /** The prior design version of the first pending revision row. */
  readonly priorDesignVersion: number;
  /** The next design version of the last pending revision row. */
  readonly nextDesignVersion: number;
  /** The tasks that the pending rows name, each one once, sorted. */
  readonly affectedTasks: readonly string[];
}

/**
 * The pending revision of a stream: the revision rows that come after its latest prepared record.
 * `events` is the stream in commit order. One result spans all the pending rows.
 *
 * It returns undefined for a stream with no revision row after its latest prepared record.
 * A stream with no prepared record has no capsule to recompile, so it has no pending revision.
 *
 * The function throws on a pending row, or on the latest prepared record, that its schema refuses.
 * A skipped row gives a recompile record that names the wrong versions or misses a task.
 */
export function pendingRevisionOf(
  events: readonly { readonly type: string; readonly data?: unknown }[],
): PendingRevision | undefined {
  let prepared: { readonly data?: unknown } | undefined;
  let rows: { readonly data?: unknown }[] = [];
  for (const event of events) {
    if (event.type === WORKFLOW_PREPARED_TYPE) {
      prepared = event;
      rows = [];
    } else if (event.type === DESIGN_REVISED_TYPE) {
      rows.push(event);
    }
  }
  if (prepared === undefined) return undefined;
  const revisions = rows.map((row) => DesignRevisedData.parse(row.data));
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return {
    priorCapsuleVersion: WorkflowPreparedData.parse(prepared.data).capsuleVersion,
    priorDesignVersion: first.priorDesignVersion,
    nextDesignVersion: last.nextDesignVersion,
    affectedTasks: [...new Set(revisions.flatMap((revision) => revision.affectedTasks))].sort(),
  };
}

/** The tasks of one recompile. */
export interface RecompiledSlice {
  /** Each seed, once, sorted. A seed that the plan lacks, or that is finished, is only here. */
  readonly declared: readonly string[];
  /** Each unfinished task that the change reaches, in plan order. */
  readonly invalidated: readonly string[];
}

/**
 * The recompiled slice of a plan. `seeds` are the tasks that the pending revision names, and
 * `plan` is the task list of the workflow state.
 *
 * The slice starts from the unfinished seeds. A task that waits on a task in the slice joins it,
 * breadth first. The visited set ends a walk through tasks that wait on each other.
 * The walk enters only unfinished tasks. Thus finished work stands, and so does each task that is
 * built on it alone.
 *
 * The plan reader of the partition gives the standing of each task, so the slice and the capsule
 * of one prepare agree. An entry that the reader refuses is not a task of the plan. For an id
 * that the plan holds twice, the first entry counts.
 */
export function recompiledSliceOf(seeds: readonly string[], plan: readonly unknown[]): RecompiledSlice {
  const tasks = new Map<string, PlannedTask>();
  for (const [index, entry] of plan.entries()) {
    const read = readPlannedTask(entry, index);
    if ('code' in read || tasks.has(read.id)) continue;
    tasks.set(read.id, read);
  }
  const waiting = new Map<string, string[]>();
  for (const task of tasks.values()) {
    for (const blocker of task.blockedBy) {
      waiting.set(blocker, [...(waiting.get(blocker) ?? []), task.id]);
    }
  }
  const unfinished = (id: string): boolean => tasks.get(id)?.complete === false;

  const declared = [...new Set(seeds)].sort();
  const queue = declared.filter(unfinished);
  const visited = new Set(queue);
  for (const current of queue) {
    for (const dependent of waiting.get(current) ?? []) {
      if (visited.has(dependent) || !unfinished(dependent)) continue;
      visited.add(dependent);
      queue.push(dependent);
    }
  }
  return { declared, invalidated: [...tasks.keys()].filter((id) => visited.has(id)) };
}
