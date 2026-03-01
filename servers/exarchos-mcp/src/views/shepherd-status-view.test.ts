import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from './materializer.js';
import {
  shepherdStatusProjection,
  SHEPHERD_STATUS_VIEW,
} from './shepherd-status-view.js';
import type { ShepherdStatusState } from './shepherd-status-view.js';
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
  };
}

describe('ShepherdStatusView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(SHEPHERD_STATUS_VIEW, shepherdStatusProjection);
  });

  it('Init_ReturnsEmptyStatus', () => {
    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      [],
    );

    expect(view.overallStatus).toBe('unknown');
    expect(view.prs).toEqual([]);
    expect(view.iteration).toBe(0);
    expect(view.maxIterations).toBe(5);
  });

  it('Apply_CiStatus_Passing_UpdatesPrCi', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 42, status: 'passing' }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs).toHaveLength(1);
    expect(view.prs[0].pr).toBe(42);
    expect(view.prs[0].ci).toBe('passing');
  });

  it('Apply_CiStatus_Failing_UpdatesPrCi', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 42, status: 'failing' }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs).toHaveLength(1);
    expect(view.prs[0].pr).toBe(42);
    expect(view.prs[0].ci).toBe('failing');
  });

  it('Apply_ReviewFinding_Minor_UpdatesCommentCounts', () => {
    const events = [
      makeEvent(1, 'review.finding', {
        pr: 42,
        source: 'coderabbit',
        severity: 'minor',
        filePath: 'src/foo.ts',
        message: 'Minor issue',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs).toHaveLength(1);
    expect(view.prs[0].comments.unresolved).toBe(1);
    expect(view.prs[0].unresolvedBySeverity['minor']).toBe(1);
  });

  it('Apply_ReviewFinding_Critical_UpdatesSeverityCounts', () => {
    const events = [
      makeEvent(1, 'review.finding', {
        pr: 10,
        source: 'self-hosted',
        severity: 'critical',
        filePath: 'src/bar.ts',
        message: 'Critical issue',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs).toHaveLength(1);
    expect(view.prs[0].comments.unresolved).toBe(1);
    expect(view.prs[0].unresolvedBySeverity['critical']).toBe(1);
  });

  it('Apply_CommentPosted_IncrementsTotal', () => {
    const events = [
      makeEvent(1, 'comment.posted', { pr: 42 }),
      makeEvent(2, 'comment.posted', { pr: 42 }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs).toHaveLength(1);
    expect(view.prs[0].comments.total).toBe(2);
  });

  it('Apply_CommentResolved_DecrementsUnresolved', () => {
    const events = [
      makeEvent(1, 'review.finding', {
        pr: 42,
        source: 'coderabbit',
        severity: 'minor',
        filePath: 'src/foo.ts',
        message: 'Issue 1',
      }),
      makeEvent(2, 'review.finding', {
        pr: 42,
        source: 'coderabbit',
        severity: 'major',
        filePath: 'src/bar.ts',
        message: 'Issue 2',
      }),
      makeEvent(3, 'comment.resolved', { pr: 42 }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs[0].comments.unresolved).toBe(1);
  });

  it('Apply_CommentResolved_DoesNotGoBelowZero', () => {
    const events = [
      makeEvent(1, 'comment.resolved', { pr: 42 }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs[0].comments.unresolved).toBe(0);
  });

  it('Apply_ShepherdIteration_IncrementsIteration', () => {
    const events = [
      makeEvent(1, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
        iteration: 3,
        action: 'push-fix',
        outcome: 'ci-passed',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.iteration).toBe(3);
  });

  it('Apply_AllPrsPassing_NoUnresolved_SetsHealthy', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'passing' }),
      makeEvent(2, 'ci.status', { pr: 2, status: 'passing' }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('healthy');
  });

  it('Apply_AnyPrFailing_SetsNeedsFixes', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'passing' }),
      makeEvent(2, 'ci.status', { pr: 2, status: 'failing' }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('needs-fixes');
  });

  it('Apply_CriticalUnresolved_SetsBlocked', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'passing' }),
      makeEvent(2, 'review.finding', {
        pr: 1,
        source: 'coderabbit',
        severity: 'critical',
        filePath: 'src/danger.ts',
        message: 'Security vulnerability',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('blocked');
  });

  it('Apply_MaxIterationsReached_SetsEscalate', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'passing' }),
      makeEvent(2, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/1',
        iteration: 5,
        action: 'push-fix',
        outcome: 'ci-passed',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('escalate');
  });

  it('Apply_MultiplePrs_TracksIndependently', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'passing' }),
      makeEvent(2, 'ci.status', { pr: 2, status: 'failing' }),
      makeEvent(3, 'review.finding', {
        pr: 1,
        source: 'coderabbit',
        severity: 'minor',
        filePath: 'src/a.ts',
        message: 'Lint issue',
      }),
      makeEvent(4, 'comment.posted', { pr: 2 }),
      makeEvent(5, 'comment.posted', { pr: 2 }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.prs).toHaveLength(2);

    const pr1 = view.prs.find((p) => p.pr === 1);
    const pr2 = view.prs.find((p) => p.pr === 2);

    expect(pr1).toBeDefined();
    expect(pr1!.ci).toBe('passing');
    expect(pr1!.comments.unresolved).toBe(1);
    expect(pr1!.unresolvedBySeverity['minor']).toBe(1);

    expect(pr2).toBeDefined();
    expect(pr2!.ci).toBe('failing');
    expect(pr2!.comments.total).toBe(2);
    expect(pr2!.comments.unresolved).toBe(0);
  });

  it('Apply_ReviewEscalated_SetsPrBlocked', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 5, status: 'passing' }),
      makeEvent(2, 'review.escalated', {
        pr: 5,
        reason: 'Too many findings',
        originalScore: 8.5,
        triggeringFinding: 'f-001',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('blocked');
  });

  it('Apply_EscalateTakesPriorityOverNeedsFixes', () => {
    // escalate (iteration >= maxIterations) should override needs-fixes
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'failing' }),
      makeEvent(2, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/1',
        iteration: 5,
        action: 'push-fix',
        outcome: 'ci-failed',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('escalate');
  });
});
