/**
 * Wave 2A.7 — TaskStore projection ↔ TaskDetailView shape parity (#1284).
 *
 * The view's `apply` now delegates to `taskStoreReducer.apply` so both
 * fold paths (per-stream view materialization AND global readProjection)
 * produce identical per-task shapes. This integration test seeds a real
 * event store with `task.assigned` + `task.completed` events, then
 * compares the view's task entry to the canonical projection's entry.
 *
 * Co-located with the view module per repository convention; an
 * older test file lives at `__tests__/views/task-detail-view.test.ts`
 * and is preserved unchanged for the view's existing single-fold behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { ViewMaterializer } from './materializer.js';
import {
  taskDetailProjection,
  TASK_DETAIL_VIEW,
  type TaskDetailViewState,
} from './task-detail-view.js';
import { readProjection } from '../projections/store.js';
// Side-effect import: registers task-store@v1 with defaultRegistry.
import '../projections/taskstore/index.js';
import type { TaskStoreState } from '../projections/taskstore/types.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

  it('TaskDetailView_ReflectsTaskStoreProjection_AfterAssignedAndCompleted', async () => {
    // GIVEN: a real event store with task.assigned + task.completed events
    //   on one workflow stream.
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

    // WHEN: we materialize the per-stream task-detail view AND read the
    //   global task-store projection.
    const events = await eventStore.query(streamId);
    const materializer = new ViewMaterializer();
    materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
    const view = materializer.materialize<TaskDetailViewState>(
      streamId,
      TASK_DETAIL_VIEW,
      events,
    );
    const projection = await readProjection<TaskStoreState>(
      'task-store@v1',
      eventStore,
    );

    // THEN: both surface the same task with identical fields. The view's
    //   `tasks[taskId]` shape MUST be the canonical projection record's
    //   shape — anything that diverges signals an out-of-fold drift.
    const viewTask = view.tasks['task-id-1'];
    const projectionTask = projection.tasks['task-id-1'];
    expect(projectionTask).toBeDefined();
    expect(viewTask).toBeDefined();

    // Status is the canonical reducer's authority for both surfaces.
    expect(viewTask.status).toBe('completed');
    expect(projectionTask?.status).toBe('completed');

    // Passthrough fields preserved across the fold path.
    expect(viewTask.title).toBe(projectionTask?.title);
    expect(viewTask.branch).toBe(projectionTask?.branch);
    expect(viewTask.worktree).toBe(projectionTask?.worktree);
    expect(viewTask.assignee).toBe(projectionTask?.assignee);
    expect(viewTask.artifacts).toEqual(projectionTask?.artifacts);
    expect(viewTask.duration).toBe(projectionTask?.duration);
  });

  it('TaskDetailView_ReflectsTaskStoreProjection_StatusAcrossLifecycle', async () => {
    // Both fold paths MUST agree on the canonical status surface — that is
    // the load-bearing semantic shared across CLI / MCP / per-stream view
    // / global projection consumers. The view's empty-string title default
    // is a stable BC contract preserved by the view layer; the canonical
    // reducer's title remains undefined-when-absent. Status, however, is
    // single-truth across both — the reducer is the authority.
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
    const projection = await readProjection<TaskStoreState>(
      'task-store@v1',
      eventStore,
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
