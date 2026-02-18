import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from '../../views/materializer.js';
import {
  pipelineProjection,
  PIPELINE_VIEW,
} from '../../views/pipeline-view.js';
import type { PipelineViewState } from '../../views/pipeline-view.js';
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

describe('PipelineView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(PIPELINE_VIEW, pipelineProjection);
  });

  describe('MultipleWorkflows_AggregatesAll', () => {
    it('should aggregate workflow events from multiple streams into the pipeline view', () => {
      // Stream 1
      const stream1Events = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-a', workflowType: 'feature' }, 'wf-001'),
        makeEvent(2, 'task.assigned', { taskId: 't1', title: 'Task 1' }, 'wf-001'),
      ];

      // Stream 2
      const stream2Events = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-b', workflowType: 'debug' }, 'wf-002'),
        makeEvent(2, 'task.assigned', { taskId: 't2', title: 'Task 2' }, 'wf-002'),
      ];

      // Materialize both streams
      materializer.materialize<PipelineViewState>('wf-001', PIPELINE_VIEW, stream1Events);
      const view = materializer.materialize<PipelineViewState>('wf-002', PIPELINE_VIEW, stream2Events);

      // The pipeline view for each stream tracks its own workflow
      // but we can get independent views per stream
      const view1 = materializer.materialize<PipelineViewState>('wf-001', PIPELINE_VIEW, stream1Events);
      const view2 = materializer.materialize<PipelineViewState>('wf-002', PIPELINE_VIEW, stream2Events);

      expect(view1.featureId).toBe('feat-a');
      expect(view1.workflowType).toBe('feature');
      expect(view1.taskCount).toBe(1);

      expect(view2.featureId).toBe('feat-b');
      expect(view2.workflowType).toBe('debug');
      expect(view2.taskCount).toBe(1);
    });
  });

  describe('StackStatus_TracksPositions', () => {
    it('should track stack positions from stack.position-filled events', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-a', workflowType: 'feature' }),
        makeEvent(2, 'stack.position-filled', { position: 1, taskId: 't1', branch: 'feat/t1', prUrl: 'https://github.com/pr/1' }),
        makeEvent(3, 'stack.position-filled', { position: 2, taskId: 't2', branch: 'feat/t2' }),
      ];

      const view = materializer.materialize<PipelineViewState>(
        'wf-001',
        PIPELINE_VIEW,
        events,
      );

      expect(view.stackPositions).toHaveLength(2);
      expect(view.stackPositions[0]).toEqual({
        position: 1,
        taskId: 't1',
        branch: 'feat/t1',
        prUrl: 'https://github.com/pr/1',
      });
      expect(view.stackPositions[1]).toEqual({
        position: 2,
        taskId: 't2',
        branch: 'feat/t2',
        prUrl: undefined,
      });
    });
  });

  describe('PhaseTracking', () => {
    it('should track the current phase of the pipeline', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-a', workflowType: 'feature' }),
        makeEvent(2, 'workflow.transition', { from: 'started', to: 'planning', trigger: 'auto', featureId: 'feat-a' }),
        makeEvent(3, 'workflow.transition', { from: 'planning', to: 'delegating', trigger: 'auto', featureId: 'feat-a' }),
      ];

      const view = materializer.materialize<PipelineViewState>(
        'wf-001',
        PIPELINE_VIEW,
        events,
      );

      expect(view.phase).toBe('delegating');
    });
  });

  describe('WorkflowTransition_ExtractsFeatureId', () => {
    it('should extract featureId from workflow.transition when no workflow.started exists', () => {
      const events = [
        makeEvent(1, 'workflow.transition', {
          from: 'ideate',
          to: 'plan',
          trigger: 'plan',
          featureId: 'feat-from-transition',
        }),
        makeEvent(2, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      ];

      const view = materializer.materialize<PipelineViewState>(
        'wf-003',
        PIPELINE_VIEW,
        events,
      );

      expect(view.featureId).toBe('feat-from-transition');
      expect(view.phase).toBe('plan');
      expect(view.taskCount).toBe(1);
    });

    it('should not overwrite featureId from workflow.started with workflow.transition', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'from-started', workflowType: 'feature' }),
        makeEvent(2, 'workflow.transition', {
          from: 'ideate',
          to: 'plan',
          trigger: 'plan',
          featureId: 'from-transition',
        }),
      ];

      const view = materializer.materialize<PipelineViewState>(
        'wf-004',
        PIPELINE_VIEW,
        events,
      );

      expect(view.featureId).toBe('from-started');
      expect(view.workflowType).toBe('feature');
      expect(view.phase).toBe('plan');
    });
  });

  // ─── T19: Cap pipeline stackPositions array ──────────────────────────

  describe('StackPositionBounds', () => {
    it('Apply_StackPositionFilled_ExceedsMax_EvictsOldest', () => {
      // Fill 110 stack positions (exceeds MAX_STACK_POSITIONS = 100)
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-a', workflowType: 'feature' }),
      ];
      for (let i = 0; i < 110; i++) {
        events.push(
          makeEvent(i + 2, 'stack.position-filled', {
            position: i + 1,
            taskId: `t${i}`,
            branch: `feat/t${i}`,
          }),
        );
      }

      const view = materializer.materialize<PipelineViewState>(
        'wf-001',
        PIPELINE_VIEW,
        events,
      );

      // Should be capped at 100
      expect(view.stackPositions).toHaveLength(100);
      // Oldest (t0 through t9) should be evicted
      expect(view.stackPositions[0].taskId).toBe('t10');
      expect(view.stackPositions[99].taskId).toBe('t109');
    });
  });

  // ─── T21: hasMore indicator for pipeline view ─────────────────────

  describe('PipelineHasMore', () => {
    it('ViewState_HasEvicted_HasMoreIsTrue', () => {
      // Under the limit
      const events100 = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-a', workflowType: 'feature' }),
      ];
      for (let i = 0; i < 100; i++) {
        events100.push(
          makeEvent(i + 2, 'stack.position-filled', {
            position: i + 1,
            taskId: `t${i}`,
            branch: `feat/t${i}`,
          }),
        );
      }

      const view100 = materializer.materialize<PipelineViewState>(
        'wf-no-evict',
        PIPELINE_VIEW,
        events100,
      );
      expect(view100.hasMore).toBe(false);

      // Over the limit
      const events101 = [
        makeEvent(1, 'workflow.started', { featureId: 'feat-a', workflowType: 'feature' }),
      ];
      for (let i = 0; i < 101; i++) {
        events101.push(
          makeEvent(i + 2, 'stack.position-filled', {
            position: i + 1,
            taskId: `t${i}`,
            branch: `feat/t${i}`,
          }),
        );
      }

      const view101 = materializer.materialize<PipelineViewState>(
        'wf-evict',
        PIPELINE_VIEW,
        events101,
      );
      expect(view101.hasMore).toBe(true);
      expect(view101.stackPositions).toHaveLength(100);
    });
  });

  describe('EmptyPipeline', () => {
    it('should return defaults for empty stream', () => {
      const view = materializer.materialize<PipelineViewState>(
        'empty',
        PIPELINE_VIEW,
        [],
      );

      expect(view.featureId).toBe('');
      expect(view.phase).toBe('');
      expect(view.taskCount).toBe(0);
      expect(view.stackPositions).toEqual([]);
      expect(view.hasMore).toBe(false);
    });
  });
});
