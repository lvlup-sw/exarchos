import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from '../../../../src/projections/views/materializer.js';
import {
  shepherdStatusProjection,
  SHEPHERD_STATUS_VIEW,
} from '../../../../src/projections/views/shepherd-status-view.js';
import type { ShepherdStatusState } from '../../../../src/projections/views/shepherd-status-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { countShepherdIterations } from '../../../../src/verbs/review/escalation-policy.js';

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

  // DR-3 (#1595): the view's `iteration` is the COUNT of `shepherd.iteration`
  // events, not the `iteration` value stamped in any payload. Three events with
  // garbage/duplicate payload values still fold to `iteration === 3`. (Was a
  // single event with `iteration: 3` expecting `3` — the OLD payload-value
  // semantics this task removes.)
  it('Apply_ShepherdIteration_IncrementsIteration', () => {
    const events = [
      makeEvent(1, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
        iteration: 99, // payload value is no longer the authority
        action: 'push-fix',
        outcome: 'ci-passed',
      }),
      makeEvent(2, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
        iteration: 99, // duplicate payload value
        action: 'push-fix',
        outcome: 'ci-passed',
      }),
      makeEvent(3, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
        // payload `iteration` omitted entirely — count still increments
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

  // DR-3 (#1595): the view's `iteration` and the loop's `countShepherdIterations`
  // are the SAME single event-sourced authority — both are the COUNT of
  // `shepherd.iteration` events. Folding N events through the view (with garbage,
  // duplicate, omitted payload `iteration` values) yields `view.iteration === N`,
  // which equals `countShepherdIterations` of the same events. So
  // `shepherd_status`/`ps` and the loop can never disagree (INV-1).
  it('ShepherdStatus_AndLoop_AgreeOnCount', () => {
    const N = 4;
    const garbagePayloads = [42, 42, 0, -7]; // non-monotonic, duplicate, garbage
    const events: WorkflowEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push(
        makeEvent(i + 1, 'shepherd.iteration', {
          prUrl: 'https://github.com/pr/1',
          iteration: garbagePayloads[i], // payload value is NOT the authority
          action: 'push-fix',
          outcome: 'ci-passed',
        }),
      );
    }

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    // The view's iteration === the count, independent of payload values.
    expect(view.iteration).toBe(N);
    // …and that count IS the loop's single authority over the same events.
    expect(view.iteration).toBe(countShepherdIterations(events));
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

  // DR-3 (#1595): escalation is driven by the COUNT of `shepherd.iteration`
  // events reaching maxIterations (5), not by a single payload `iteration: 5`.
  // Five events fold to `iteration === 5 >= maxIterations`. (Was a single event
  // with `iteration: 5` — the OLD payload-value semantics.)
  it('Apply_MaxIterationsReached_SetsEscalate', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'passing' }),
      makeEvent(2, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-passed' }),
      makeEvent(3, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-passed' }),
      makeEvent(4, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-passed' }),
      makeEvent(5, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-passed' }),
      makeEvent(6, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-passed' }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.iteration).toBe(5);
    expect(view.overallStatus).toBe('escalate');
  });

  // DR-3 (#1595): the structured `shepherd.escalated` event surfaces the WHY of
  // an escalation (reason + counts + when) via shepherd_status/ps — not just the
  // derived 'escalate' status. Folding the event populates `view.escalation`.
  it('Escalation_SurfacedViaShepherdStatus', () => {
    const events = [
      makeEvent(1, 'ci.status', { pr: 42, status: 'failing' }),
      makeEvent(2, 'shepherd.escalated', {
        featureId: 'feat-x',
        prNumbers: [42, 43],
        iterationCount: 5,
        maxIterations: 5,
        reason: 'auto-fix bound (5) reached after 5 iterations',
      }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.escalation).toBeDefined();
    expect(view.escalation!.reason).toBe('auto-fix bound (5) reached after 5 iterations');
    expect(view.escalation!.iterationCount).toBe(5);
    expect(view.escalation!.maxIterations).toBe(5);
    expect(view.escalation!.escalatedAt).toBe(events[1].timestamp);
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
    // escalate (iteration >= maxIterations) should override needs-fixes.
    // DR-3 (#1595): the count of five `shepherd.iteration` events drives
    // escalation, not a payload `iteration: 5` (the OLD payload-value semantics).
    const events = [
      makeEvent(1, 'ci.status', { pr: 1, status: 'failing' }),
      makeEvent(2, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-failed' }),
      makeEvent(3, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-failed' }),
      makeEvent(4, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-failed' }),
      makeEvent(5, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-failed' }),
      makeEvent(6, 'shepherd.iteration', { prUrl: 'https://github.com/pr/1', action: 'push-fix', outcome: 'ci-failed' }),
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.overallStatus).toBe('escalate');
  });

  // ─── Shepherd Lifecycle Event Handlers ──────────────────────────────────

  it('ShepherdStatusView_ShepherdStarted_RecordsStartTime', () => {
    const timestamp = '2026-03-07T10:00:00.000Z';
    const events = [
      {
        streamId: 'wf-001',
        sequence: 1,
        timestamp,
        type: 'shepherd.started',
        schemaVersion: '1.0',
        data: { featureId: 'feat-001' },
      } as WorkflowEvent,
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.startedAt).toBe(timestamp);
  });

  it('ShepherdStatusView_ApprovalRequested_RecordsRequestTime', () => {
    const timestamp = '2026-03-07T11:00:00.000Z';
    const events = [
      {
        streamId: 'wf-001',
        sequence: 1,
        timestamp,
        type: 'shepherd.approval_requested',
        schemaVersion: '1.0',
        data: { prUrl: 'https://github.com/pr/42' },
      } as WorkflowEvent,
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.approvalRequestedAt).toBe(timestamp);
  });

  it('ShepherdStatusView_Completed_RecordsOutcome', () => {
    const timestamp = '2026-03-07T12:00:00.000Z';
    const events = [
      {
        streamId: 'wf-001',
        sequence: 1,
        timestamp,
        type: 'shepherd.completed',
        schemaVersion: '1.0',
        data: { prUrl: 'https://github.com/pr/42', outcome: 'merged' },
      } as WorkflowEvent,
    ];

    const view = materializer.materialize<ShepherdStatusState>(
      'wf-001',
      SHEPHERD_STATUS_VIEW,
      events,
    );

    expect(view.completedAt).toBe(timestamp);
    expect(view.outcome).toBe('merged');
  });
});
