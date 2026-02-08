import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from '../../views/materializer.js';
import {
  unifiedTaskProjection,
  UNIFIED_TASK_VIEW,
} from '../../views/unified-task-view.js';
import type { UnifiedTaskViewState } from '../../views/unified-task-view.js';
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

describe('UnifiedTaskView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(UNIFIED_TASK_VIEW, unifiedTaskProjection);
  });

  describe('LocalTask_IncludesWorktree', () => {
    it('should include worktree path and branch in task entries', () => {
      const events = [
        makeEvent(1, 'task.assigned', {
          taskId: 't1',
          title: 'Implement auth',
          branch: 'feat/auth',
          worktree: '/home/user/worktrees/auth',
          assignee: 'agent-1',
        }),
      ];

      const view = materializer.materialize<UnifiedTaskViewState>(
        'wf-001',
        UNIFIED_TASK_VIEW,
        events,
      );

      expect(view.tasks).toHaveLength(1);
      expect(view.tasks[0].taskId).toBe('t1');
      expect(view.tasks[0].title).toBe('Implement auth');
      expect(view.tasks[0].branch).toBe('feat/auth');
      expect(view.tasks[0].worktree).toBe('/home/user/worktrees/auth');
      expect(view.tasks[0].assignee).toBe('agent-1');
      expect(view.tasks[0].streamId).toBe('wf-001');
      expect(view.tasks[0].status).toBe('assigned');
    });
  });

  describe('TaskLifecycle_StatusTransitions', () => {
    it('should update task status through lifecycle events', () => {
      const events = [
        makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
        makeEvent(2, 'task.claimed', { taskId: 't1', agentId: 'agent-1', claimedAt: '2025-01-01T00:00:00Z' }),
        makeEvent(3, 'task.progressed', { taskId: 't1', tddPhase: 'red' }),
        makeEvent(4, 'task.completed', { taskId: 't1' }),
      ];

      const view = materializer.materialize<UnifiedTaskViewState>(
        'wf-001',
        UNIFIED_TASK_VIEW,
        events,
      );

      expect(view.tasks[0].status).toBe('completed');
      expect(view.tasks[0].tddPhase).toBe('red');
    });
  });

  describe('MultipleTasks_AllTracked', () => {
    it('should track all tasks across assignments', () => {
      const events = [
        makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
        makeEvent(2, 'task.assigned', { taskId: 't2', title: 'Task 2' }),
        makeEvent(3, 'task.assigned', { taskId: 't3', title: 'Task 3' }),
      ];

      const view = materializer.materialize<UnifiedTaskViewState>(
        'wf-001',
        UNIFIED_TASK_VIEW,
        events,
      );

      expect(view.tasks).toHaveLength(3);
      expect(view.tasks.map((t) => t.taskId)).toEqual(['t1', 't2', 't3']);
    });
  });

  describe('FailedTask_TracksError', () => {
    it('should mark failed tasks and record error', () => {
      const events = [
        makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Failing task' }),
        makeEvent(2, 'task.failed', { taskId: 't1', error: 'compilation error' }),
      ];

      const view = materializer.materialize<UnifiedTaskViewState>(
        'wf-001',
        UNIFIED_TASK_VIEW,
        events,
      );

      expect(view.tasks[0].status).toBe('failed');
      expect(view.tasks[0].error).toBe('compilation error');
    });
  });

  describe('EmptyStream_ReturnsEmptyTasks', () => {
    it('should return empty tasks array when no events exist', () => {
      const view = materializer.materialize<UnifiedTaskViewState>(
        'empty',
        UNIFIED_TASK_VIEW,
        [],
      );

      expect(view.tasks).toEqual([]);
    });
  });
});
