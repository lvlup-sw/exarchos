/**
 * The cost of the guard fold over one stream of 700 rows.
 *
 * The stream holds a start row, patch rows, task rows, gate rows and admission rows, in a fixed cycle.
 * `vitest bench` collects this file, and `vitest run` does not. No test bounds the duration of the fold.
 * The pull request body records the mean of the bench.
 */
import { bench, describe } from 'vitest';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { foldGuardInput } from '../../../../src/projections/guard-input/fold.js';

/** The stream id of the bench rows. */
const FEATURE_ID = 'guard-fold-bench';

/** The number of rows in the stream. */
const ROW_COUNT = 700;

/** The number of tasks in the task list of the first patch. */
const TASK_COUNT = 40;

/** The time of the first row. Each later row is one second later. */
const EPOCH_MS = Date.parse('2026-11-11T00:00:00.000Z');

/** The id of the task at an index. */
function taskId(index: number): string {
  return `task-${String(index % TASK_COUNT).padStart(3, '0')}`;
}

/** Returns the type and the data of the row at a position after the start row and the task list. The kinds repeat in a cycle of five. */
function cycleRow(position: number): { readonly type: string; readonly data: Record<string, unknown> } {
  switch (position % 5) {
    case 0:
      return { type: 'state.patched', data: { patch: { [`notes.n${position % 17}`]: `note ${position}` } } };
    case 1:
      return { type: 'task.completed', data: { taskId: taskId(position), worktree: `.worktrees/${taskId(position)}` } };
    case 2:
      return { type: 'task.failed', data: { taskId: taskId(position + 7) } };
    case 3:
      return {
        type: 'gate.executed',
        data: { gateName: 'mutation-adequacy', layer: 'review', passed: true, details: { mutationScore: 85, noCoverage: 1 } },
      };
    default:
      return { type: 'admission.shadow-attempt', data: { featureId: FEATURE_ID, ordinal: position } };
  }
}

/** Builds the 700 rows of the bench stream: a start row, one patch with the task list, and a cycle of the other kinds. */
function benchRows(): readonly WorkflowEvent[] {
  const rows: WorkflowEvent[] = [];
  const add = (type: string, data: Record<string, unknown>): void => {
    const sequence = rows.length + 1;
    rows.push({
      streamId: FEATURE_ID,
      sequence,
      timestamp: new Date(EPOCH_MS + sequence * 1000).toISOString(),
      type,
      schemaVersion: '1.0',
      data,
    });
  };
  add('workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' });
  add('state.patched', {
    patch: {
      'artifacts.plan': 'plans/plan.md',
      tasks: Array.from({ length: TASK_COUNT }, (_, index) => ({ id: taskId(index), title: `task ${index}`, status: 'pending' })),
    },
  });
  while (rows.length < ROW_COUNT) {
    const row = cycleRow(rows.length);
    add(row.type, row.data);
  }
  return rows;
}

describe('the guard fold of one stream', () => {
  const rows = benchRows();

  bench(
    'foldGuardInput-700-rows',
    () => {
      foldGuardInput(rows, { config: {} });
    },
    { warmupIterations: 5, iterations: 100 },
  );
});
