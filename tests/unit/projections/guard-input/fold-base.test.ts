/**
 * These tests check the base fold of the guard input and the one map of the guard events.
 * `foldWorkflowState` folds the rows of one stream through the workflow-state projection, from its initial view.
 * `toGuardEvents` maps each row to the `_events` entry that the transition guards read.
 * A test compares the code with a fold loop of this file, or with literal entries of this file.
 * The store cases use a real event store in a temporary directory.
 *
 * @oracle-sources: ../../../../src/projections/views/workflow-state-projection.ts, the rows and expected entries written in this file
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import { foldWorkflowState } from '../../../../src/projections/guard-input/fold.js';
import { toGuardEvents } from '../../../../src/projections/guard-input/guard-events.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import { resolveWorkflowState } from '../../../../src/verbs/resolve-state.js';
import { hydrateEventsFromStore } from '../../../../src/workflow/state-store.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The source of the resolver, which the module case reads. */
const RESOLVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/verbs/resolve-state.ts',
);

/** The relative import of the base fold in the resolver. */
const FOLD_IMPORT = '../projections/guard-input/fold.js';

/** The relative import of the projection, which the resolver no longer holds. */
const PROJECTION_IMPORT = '../projections/views/workflow-state-projection.js';

/** The stream id of the rows of this file. */
const FEATURE_ID = 'fold-base';

/** The timestamp of the last row. That row completes the second task. */
const LAST_TIMESTAMP = '2026-11-10T10:06:00.000Z';

/** Returns one row with the envelope fields that the store gives a row. */
function row(sequence: number, type: string, data: Record<string, unknown>): WorkflowEvent {
  return {
    streamId: FEATURE_ID,
    sequence,
    timestamp: `2026-11-10T10:0${String(sequence - 1)}:00.000Z`,
    type,
    schemaVersion: '1.0',
    data,
  };
}

/** Returns the rows of a feature stream at `delegate`. The last row completes a task that the rows before it hold at `pending`. */
function streamRows(): WorkflowEvent[] {
  return [
    row(1, 'workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' }),
    row(2, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan', to: 'plan-review', trigger: 'execute-transition' }),
    row(3, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan-review', to: 'delegate', trigger: 'execute-transition' }),
    row(4, 'task.assigned', { taskId: 't1', title: 'the first task' }),
    row(5, 'task.assigned', { taskId: 't2', title: 'the second task' }),
    row(6, 'task.completed', { taskId: 't1' }),
    row(7, 'task.completed', { taskId: 't2', worktree: 'worktrees/t2' }),
  ];
}

/** Returns the import specifiers of a module source. */
function importSpecifiers(source: string): readonly string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/**
 * Appends the rows of this file to a real event store in a temporary directory, and then runs `run` on the store.
 * The store closes and the directory goes, also on a throw.
 */
async function withStream<T>(run: (eventStore: EventStore) => Promise<T>): Promise<T> {
  const stateDir = makeTempDir('fold-base-');
  const eventStore = new EventStore(stateDir);
  try {
    await eventStore.initialize();
    for (const source of streamRows()) {
      await eventStore.append(FEATURE_ID, {
        type: source.type,
        timestamp: source.timestamp,
        ...(source.data !== undefined ? { data: source.data } : {}),
      });
    }
    return await run(eventStore);
  } finally {
    eventStore.close();
    await rmrfAsync(stateDir);
  }
}

describe('the base fold and the map of the guard events', () => {
  /**
   * The fold equals a loop of this file over the projection, from its initial view.
   * The phase and the tasks equal literals. The last row moves the second task from `pending` to `complete`.
   */
  it('FoldWorkflowState_TheRowsOfAStream_EqualTheProjectionFoldedRowByRow', () => {
    const rows = streamRows();
    let expected = workflowStateProjection.init();
    for (const source of rows) {
      expected = workflowStateProjection.apply(expected, source);
    }

    const folded = foldWorkflowState(rows);

    expect(folded).toStrictEqual(expected);
    expect(folded.featureId).toBe(FEATURE_ID);
    expect(folded.phase).toBe('delegate');
    expect(folded.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status }))).toEqual([
      { id: 't1', title: 'the first task', status: 'complete' },
      { id: 't2', title: 'the second task', status: 'complete' },
    ]);
    expect(folded.tasks[1]?.completedAt).toBe(LAST_TIMESTAMP);
  });

  /** Two folds of the same rows give equal views, and neither fold changes a row. */
  it('FoldWorkflowState_TheSameRows_GiveEqualStatesAndLeaveTheRowsUnchanged', () => {
    const rows = streamRows();
    const before = structuredClone(rows);

    const first = foldWorkflowState(rows);
    const second = foldWorkflowState(rows);

    expect(second).toStrictEqual(first);
    expect(rows).toStrictEqual(before);
  });

  /** The resolver imports the base fold, and it no longer imports the projection to fold with its own loop. */
  it('ResolveWorkflowState_TheModule_FoldsThroughFoldWorkflowState', () => {
    const source = fs.readFileSync(RESOLVER_PATH, 'utf8');
    const relative = new Set(importSpecifiers(source).filter((spec) => spec.startsWith('.')));

    expect(relative.size).toBeGreaterThan(0);
    expect(relative.has(FOLD_IMPORT)).toBe(true);
    expect(relative.has(PROJECTION_IMPORT)).toBe(false);
    expect(source).toContain('foldWorkflowState(events)');
  });

  /** The resolver gives the base fold of the rows that the store returns for the stream. */
  it('ResolveWorkflowState_AStream_EqualsFoldWorkflowState', async () => {
    await withStream(async (eventStore) => {
      const rows = await eventStore.query(FEATURE_ID);

      const resolved = await resolveWorkflowState({ featureId: FEATURE_ID, eventStore });

      expect(rows).toHaveLength(7);
      expect(resolved).toStrictEqual({ state: foldWorkflowState(rows) });
    });
  });

  /**
   * Each entry holds the internal type, the timestamp, each data field at the top level and the data as `metadata`.
   * A row with no data gives an empty `metadata`.
   */
  it('ToGuardEvents_EachRow_MapsToTheInternalTypeTheDataAndTheMetadata', () => {
    const rows: WorkflowEvent[] = [
      row(2, 'workflow.transition', { from: 'plan', to: 'plan-review', trigger: 'execute-transition' }),
      row(6, 'task.completed', { taskId: 't1', worktree: 'worktrees/t1' }),
      { streamId: FEATURE_ID, sequence: 8, timestamp: '2026-11-10T10:07:00.000Z', type: 'workflow.checkpoint', schemaVersion: '1.0' },
    ];

    expect(toGuardEvents(rows)).toStrictEqual([
      {
        type: 'transition',
        timestamp: '2026-11-10T10:01:00.000Z',
        from: 'plan',
        to: 'plan-review',
        trigger: 'execute-transition',
        metadata: { from: 'plan', to: 'plan-review', trigger: 'execute-transition' },
      },
      {
        type: 'task.completed',
        timestamp: '2026-11-10T10:05:00.000Z',
        taskId: 't1',
        worktree: 'worktrees/t1',
        metadata: { taskId: 't1', worktree: 'worktrees/t1' },
      },
      {
        type: 'checkpoint',
        timestamp: '2026-11-10T10:07:00.000Z',
        metadata: {},
      },
    ]);
  });

  /** The hydration of the state store gives the map of the rows that the store returns for the stream. */
  it('ToGuardEvents_TheRowsOfAStream_EqualHydrateEventsFromStore', async () => {
    await withStream(async (eventStore) => {
      const rows = await eventStore.query(FEATURE_ID);

      const hydrated = await hydrateEventsFromStore(FEATURE_ID, eventStore);

      expect(hydrated).toHaveLength(7);
      expect(hydrated).toStrictEqual(toGuardEvents(rows));
    });
  });

  /**
   * An entry holds no `data` key. So a guard that reads `data` of the latest completion with a worktree finds nothing.
   * The map keeps that behavior, and the worktree stays at the top level and in `metadata`.
   */
  it('ToGuardEvents_AnEntry_HoldsNoDataKey', () => {
    const entries = toGuardEvents(streamRows());
    const latestCompletion = entries[6];

    expect(entries).toHaveLength(7);
    for (const entry of entries) expect(Object.hasOwn(entry, 'data')).toBe(false);
    expect(latestCompletion?.type).toBe('task.completed');
    expect(latestCompletion?.data).toBeUndefined();
    expect(latestCompletion?.worktree).toBe('worktrees/t2');
    expect(latestCompletion?.metadata).toEqual({ taskId: 't2', worktree: 'worktrees/t2' });
  });
});
