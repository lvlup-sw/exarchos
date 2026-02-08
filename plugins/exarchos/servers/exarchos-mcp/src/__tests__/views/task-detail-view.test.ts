import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from '../../views/materializer.js';
import {
  taskDetailProjection,
  TASK_DETAIL_VIEW,
} from '../../views/task-detail-view.js';
import type { TaskDetailViewState } from '../../views/task-detail-view.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

function makeEvent(
  seq: number,
  type: string,
  data?: Record<string, unknown>,
  streamId = 'wf-001',
): WorkflowEvent {
  return {
    streamId,
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    schemaVersion: '1.0',
    data,
  };
}

describe('TaskDetailView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
  });

  describe('FullLifecycle_TracksAllPhases', () => {
    it('should track a task through assign, claim, progress, and complete', () => {
      const events = [
        makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Build auth', branch: 'feat/auth', worktree: '/tmp/auth' }),
        makeEvent(2, 'task.claimed', { taskId: 't1', agentId: 'agent-1', claimedAt: '2025-06-15T10:00:00Z' }),
        makeEvent(3, 'task.progressed', { taskId: 't1', tddPhase: 'red', detail: 'writing tests' }),
        makeEvent(4, 'task.progressed', { taskId: 't1', tddPhase: 'green', detail: 'passing tests' }),
        makeEvent(5, 'task.completed', { taskId: 't1', artifacts: ['auth.ts'], duration: 120 }),
      ];

      const view = materializer.materialize<TaskDetailViewState>(
        'wf-001',
        TASK_DETAIL_VIEW,
        events,
      );

      const task = view.tasks['t1'];
      expect(task).toBeDefined();
      expect(task.taskId).toBe('t1');
      expect(task.title).toBe('Build auth');
      expect(task.branch).toBe('feat/auth');
      expect(task.worktree).toBe('/tmp/auth');
      expect(task.status).toBe('completed');
      expect(task.assignee).toBe('agent-1');
      expect(task.tddPhase).toBe('green');
      expect(task.artifacts).toEqual(['auth.ts']);
      expect(task.duration).toBe(120);
    });
  });

  describe('FilterByTaskId_ReturnsOnlyRelevant', () => {
    it('should track multiple tasks independently', () => {
      const events = [
        makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
        makeEvent(2, 'task.assigned', { taskId: 't2', title: 'Task 2' }),
        makeEvent(3, 'task.completed', { taskId: 't1' }),
        makeEvent(4, 'task.progressed', { taskId: 't2', tddPhase: 'red' }),
      ];

      const view = materializer.materialize<TaskDetailViewState>(
        'wf-001',
        TASK_DETAIL_VIEW,
        events,
      );

      expect(view.tasks['t1'].status).toBe('completed');
      expect(view.tasks['t2'].status).toBe('in-progress');
      expect(view.tasks['t2'].tddPhase).toBe('red');
    });
  });

  describe('TaskFailed_SetsErrorState', () => {
    it('should record failure details on task.failed event', () => {
      const events = [
        makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Failing task' }),
        makeEvent(2, 'task.failed', { taskId: 't1', error: 'build failure', diagnostics: { exitCode: 1 } }),
      ];

      const view = materializer.materialize<TaskDetailViewState>(
        'wf-001',
        TASK_DETAIL_VIEW,
        events,
      );

      expect(view.tasks['t1'].status).toBe('failed');
      expect(view.tasks['t1'].error).toBe('build failure');
    });
  });

  describe('EmptyStream_ReturnsEmptyTasks', () => {
    it('should return empty tasks map when no events exist', () => {
      const view = materializer.materialize<TaskDetailViewState>(
        'empty',
        TASK_DETAIL_VIEW,
        [],
      );

      expect(view.tasks).toEqual({});
    });
  });
});
