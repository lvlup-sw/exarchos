import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from './materializer.js';
import {
  synthesisReadinessProjection,
  SYNTHESIS_READINESS_VIEW,
} from './synthesis-readiness-view.js';
import type { SynthesisReadinessState } from './synthesis-readiness-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

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
  } as WorkflowEvent;
}

describe('SynthesisReadinessView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(SYNTHESIS_READINESS_VIEW, synthesisReadinessProjection);
  });

  it('Init_ReturnsNotReady_WithEmptyState', () => {
    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      [],
    );

    expect(view.ready).toBe(false);
    expect(view.blockers).toContain('no tasks tracked');
    expect(view.tasks).toEqual({ total: 0, completed: 0, failed: 0 });
    expect(view.review).toEqual({
      specPassed: false,
      qualityPassed: false,
      findingsBySeverity: {},
    });
    expect(view.tests).toEqual({
      lastRunPassed: null,
      typecheckPassed: null,
      coveragePercent: null,
    });
    expect(view.stack).toEqual({ restacked: false, conflicts: false });
  });

  it('Apply_TaskCompleted_UpdatesTaskCounts', () => {
    const events = [
      makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      makeEvent(2, 'task.completed', { taskId: 't1' }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.tasks.total).toBe(1);
    expect(view.tasks.completed).toBe(1);
    expect(view.tasks.failed).toBe(0);
  });

  it('Apply_TaskFailed_UpdatesFailedCount', () => {
    const events = [
      makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      makeEvent(2, 'task.failed', { taskId: 't1', error: 'Something broke' }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.tasks.total).toBe(1);
    expect(view.tasks.completed).toBe(0);
    expect(view.tasks.failed).toBe(1);
  });

  it('Apply_GateExecuted_SpecReview_Passed_SetsSpecPassed', () => {
    const events = [
      makeEvent(1, 'gate.executed', {
        gateName: 'spec-review',
        layer: 'review',
        passed: true,
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.review.specPassed).toBe(true);
    expect(view.review.qualityPassed).toBe(false);
  });

  it('Apply_GateExecuted_QualityReview_Passed_SetsQualityPassed', () => {
    const events = [
      makeEvent(1, 'gate.executed', {
        gateName: 'quality-review',
        layer: 'review',
        passed: true,
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.review.specPassed).toBe(false);
    expect(view.review.qualityPassed).toBe(true);
  });

  it('Apply_ReviewFinding_UpdatesFindingCounts', () => {
    const events = [
      makeEvent(1, 'review.finding', {
        pr: 42,
        source: 'self-hosted',
        severity: 'critical',
        filePath: 'src/foo.ts',
        message: 'issue found',
      }),
      makeEvent(2, 'review.finding', {
        pr: 42,
        source: 'self-hosted',
        severity: 'critical',
        filePath: 'src/bar.ts',
        message: 'another issue',
      }),
      makeEvent(3, 'review.finding', {
        pr: 42,
        source: 'self-hosted',
        severity: 'minor',
        filePath: 'src/baz.ts',
        message: 'minor issue',
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.review.findingsBySeverity).toEqual({
      critical: 2,
      minor: 1,
    });
  });

  it('Apply_TestResult_Passed_SetsTestStatus', () => {
    const events = [
      makeEvent(1, 'test.result', {
        passed: true,
        coveragePercent: 87.5,
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.tests.lastRunPassed).toBe(true);
    expect(view.tests.coveragePercent).toBe(87.5);
  });

  it('Apply_TypecheckResult_SetsTypecheckStatus', () => {
    const events = [
      makeEvent(1, 'typecheck.result', {
        passed: true,
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.tests.typecheckPassed).toBe(true);
  });

  it('Apply_StackRestacked_SetsStackHealth', () => {
    const events = [
      makeEvent(1, 'stack.restacked', {
        affectedPositions: [1, 2, 3],
        conflicts: false,
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.stack.restacked).toBe(true);
    expect(view.stack.conflicts).toBe(false);
  });

  it('Apply_StackRestacked_WithConflicts_SetsConflictsTrue', () => {
    const events = [
      makeEvent(1, 'stack.restacked', {
        affectedPositions: [1, 2],
        conflicts: true,
      }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.stack.restacked).toBe(true);
    expect(view.stack.conflicts).toBe(true);
  });

  it('Apply_AllTasksComplete_ReviewsPassed_TestsGreen_SetsReady', () => {
    const events = [
      makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      makeEvent(2, 'task.assigned', { taskId: 't2', title: 'Task 2' }),
      makeEvent(3, 'task.completed', { taskId: 't1' }),
      makeEvent(4, 'task.completed', { taskId: 't2' }),
      makeEvent(5, 'gate.executed', {
        gateName: 'spec-review',
        layer: 'review',
        passed: true,
      }),
      makeEvent(6, 'gate.executed', {
        gateName: 'quality-review',
        layer: 'review',
        passed: true,
      }),
      makeEvent(7, 'test.result', { passed: true, coveragePercent: 90 }),
      makeEvent(8, 'typecheck.result', { passed: true }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.ready).toBe(true);
    expect(view.blockers).toEqual([]);
  });

  it('Apply_TasksIncomplete_ReportsBlocker', () => {
    const events = [
      makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      makeEvent(2, 'task.assigned', { taskId: 't2', title: 'Task 2' }),
      makeEvent(3, 'task.completed', { taskId: 't1' }),
      // t2 not completed
      makeEvent(4, 'gate.executed', {
        gateName: 'spec-review',
        layer: 'review',
        passed: true,
      }),
      makeEvent(5, 'gate.executed', {
        gateName: 'quality-review',
        layer: 'review',
        passed: true,
      }),
      makeEvent(6, 'test.result', { passed: true, coveragePercent: 90 }),
      makeEvent(7, 'typecheck.result', { passed: true }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.ready).toBe(false);
    expect(view.blockers).toContain('tasks incomplete: 1/2 completed');
  });

  it('Apply_SpecReviewFailed_ReportsBlocker', () => {
    const events = [
      makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      makeEvent(2, 'task.completed', { taskId: 't1' }),
      makeEvent(3, 'gate.executed', {
        gateName: 'spec-review',
        layer: 'review',
        passed: false,
      }),
      makeEvent(4, 'gate.executed', {
        gateName: 'quality-review',
        layer: 'review',
        passed: true,
      }),
      makeEvent(5, 'test.result', { passed: true, coveragePercent: 90 }),
      makeEvent(6, 'typecheck.result', { passed: true }),
    ];

    const view = materializer.materialize<SynthesisReadinessState>(
      'wf-001',
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    expect(view.ready).toBe(false);
    expect(view.blockers).toContain('spec review not passed');
  });
});
