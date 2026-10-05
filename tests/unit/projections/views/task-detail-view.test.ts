/**
 * Shape parity between the task-detail view and the task-store reducer.
 *
 * The view `apply` calls `taskStoreReducer.apply`. The view materializer and a direct reducer fold
 * over the same stream must give the same task shape. Both sides fold one stream, because the
 * reducer scope is `stream`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { ViewMaterializer } from '../../../../src/projections/views/materializer.js';
import {
  taskDetailProjection,
  TASK_DETAIL_VIEW,
  type TaskDetailViewState,
} from '../../../../src/projections/views/task-detail-view.js';
import { rebuildProjection } from '../../../../src/projections/rebuild.js';
import { taskStoreReducer } from '../../../../src/projections/taskstore/reducer.js';
import type { TaskStoreState } from '../../../../src/projections/taskstore/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('TaskDetailView_ReflectsTaskStoreProjection (Wave 2A.7, #1284)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'exarchos-view-parity-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('TaskDetailView_PerStreamFold_MatchesReducerShapeParity', async () => {
    const streamId = 'wf-parity';
    await eventStore.append(streamId, {
      type: 'task.assigned',
      data: {
        taskId: 'task-id-1',
        title: 'Implement parity',
        branch: 'feat/parity',
        worktree: '/tmp/parity',
        assignee: 'agent-1',
      },
    });
    await eventStore.append(streamId, {
      type: 'task.completed',
      data: {
        taskId: 'task-id-1',
        artifacts: ['parity.ts'],
        duration: 99,
      },
    });

    const events = await eventStore.query(streamId);
    const materializer = new ViewMaterializer();
    materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
    const view = materializer.materialize<TaskDetailViewState>(
      streamId,
      TASK_DETAIL_VIEW,
      events,
    );
    const projection = await rebuildProjection<TaskStoreState, unknown>(
      taskStoreReducer,
      eventStore,
      streamId,
    );

    const viewTask = view.tasks['task-id-1'];
    const projectionTask = projection.tasks['task-id-1'];
    expect(projectionTask).toBeDefined();
    expect(viewTask).toBeDefined();

    expect(viewTask.status).toBe('completed');
    expect(projectionTask?.status).toBe('completed');

    expect(viewTask.title).toBe(projectionTask?.title);
    expect(viewTask.branch).toBe(projectionTask?.branch);
    expect(viewTask.worktree).toBe(projectionTask?.worktree);
    expect(viewTask.assignee).toBe(projectionTask?.assignee);
    expect(viewTask.artifacts).toEqual(projectionTask?.artifacts);
    expect(viewTask.duration).toBe(projectionTask?.duration);
  });

  /** The reducer is the authority for `status`, so both fold paths must agree on it. */
  it('TaskDetailView_ReflectsTaskStoreProjection_StatusAcrossLifecycle', async () => {
    const streamId = 'wf-lifecycle';
    await eventStore.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 'task-lc-1', title: 'Lifecycle' },
    });
    await eventStore.append(streamId, {
      type: 'task.claimed',
      data: { taskId: 'task-lc-1', agentId: 'agent-A', claimedAt: 'now' },
    });
    await eventStore.append(streamId, {
      type: 'task.progressed',
      data: { taskId: 'task-lc-1', tddPhase: 'green' },
    });
    await eventStore.append(streamId, {
      type: 'task.failed',
      data: { taskId: 'task-lc-1', error: 'boom' },
    });

    const events = await eventStore.query(streamId);
    const materializer = new ViewMaterializer();
    materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
    const view = materializer.materialize<TaskDetailViewState>(
      streamId,
      TASK_DETAIL_VIEW,
      events,
    );
    const projection = await rebuildProjection<TaskStoreState, unknown>(
      taskStoreReducer,
      eventStore,
      streamId,
    );

    expect(view.tasks['task-lc-1'].status).toBe('failed');
    expect(projection.tasks['task-lc-1']?.status).toBe('failed');
    expect(view.tasks['task-lc-1'].status).toBe(
      projection.tasks['task-lc-1']?.status,
    );
    expect(view.tasks['task-lc-1'].error).toBe(
      projection.tasks['task-lc-1']?.error,
    );
    expect(view.tasks['task-lc-1'].tddPhase).toBe(
      projection.tasks['task-lc-1']?.tddPhase,
    );
  });
});
