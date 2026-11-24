/**
 * These tests check the shepherd-status view and the replay of a stored log that holds the retired shepherd types.
 * The view cases compare the fold with literal states that this file writes by hand.
 * The replay case writes the stored rows by hand and folds them through the workflow-state projection.
 * It then compares that fold with a fold of the same log without the retired rows.
 *
 * @oracle-sources: ../../../../src/projections/views/workflow-state-projection.ts, the stored rows and expected states written in this file
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import { SqliteBackend } from '../../../../src/storage/sqlite-backend.js';
import { EVENT_ANNOTATIONS } from '../../../../src/events/event-annotations.js';
import { EVENT_DATA_SCHEMAS, type EventType } from '../../../../src/events/schemas.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
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

  /**
   * The view `iteration` is the count of `shepherd.iteration` events, not a payload value.
   * Two events carry a wrong payload `iteration` of 99, and the third carries none.
   */
  it('Apply_ShepherdIteration_IncrementsIteration', () => {
    const events = [
      makeEvent(1, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
        iteration: 99,
        action: 'push-fix',
        outcome: 'ci-passed',
      }),
      makeEvent(2, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
        iteration: 99,
        action: 'push-fix',
        outcome: 'ci-passed',
      }),
      makeEvent(3, 'shepherd.iteration', {
        prUrl: 'https://github.com/pr/42',
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

  /**
   * The view and `countShepherdIterations` both count `shepherd.iteration` events. Thus
   * `shepherd_status`, `ps` and the loop agree, whatever `iteration` value a payload holds.
   */
  it('ShepherdStatus_AndLoop_AgreeOnCount', () => {
    const N = 4;
    const garbagePayloads = [42, 42, 0, -7];
    const events: WorkflowEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push(
        makeEvent(i + 1, 'shepherd.iteration', {
          prUrl: 'https://github.com/pr/1',
          iteration: garbagePayloads[i],
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

    expect(view.iteration).toBe(N);
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

  /** Five `shepherd.iteration` events reach the `maxIterations` default of 5, which sets `escalate`. */
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

  /** A `shepherd.escalated` event fills `view.escalation` with the reason, the counts and the time. */
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

  /** A count of five iterations sets `escalate`, although a failing PR alone gives `needs-fixes`. */
  it('Apply_EscalateTakesPriorityOverNeedsFixes', () => {
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

/** The four shepherd types that are retired as emissions. Old logs hold their rows. */
const RETIRED_SHEPHERD_TYPES: readonly EventType[] = [
  'shepherd.started',
  'shepherd.approval_requested',
  'shepherd.escalated',
  'shepherd.completed',
];

/** The retired types as strings, for a membership test over replayed rows. */
const RETIRED_SHEPHERD_TYPE_SET: ReadonlySet<string> = new Set(RETIRED_SHEPHERD_TYPES);

describe('ShepherdStatusView_RetiredShepherdEvents_StoredLogReplay', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shepherd-retired-replay-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * A stored log of an earlier shepherd loop holds all four retired types. The test writes the rows
   * through the SQLite backend, as the earlier appender left them, and replays them through
   * `EventStore.query`. Each row still parses with the schema of its type. The shepherd-status view
   * gives the same read result as before the retirement, and the workflow-state projection folds
   * the four rows as no-ops.
   */
  it('a stored log with the four retired shepherd types replays with its original read results', async () => {
    const stream = 'feat-shepherd-legacy';
    const persisted = [
      { type: 'workflow.started', data: { featureId: stream, workflowType: 'feature' } },
      { type: 'shepherd.started', data: { featureId: stream } },
      { type: 'shepherd.iteration', data: { iteration: 1, prsAssessed: 2, fixesApplied: 1, status: 'resubmitted' } },
      { type: 'shepherd.approval_requested', data: { prUrl: 'https://github.com/o/r/pull/42' } },
      {
        type: 'shepherd.escalated',
        data: { featureId: stream, prNumbers: [42, 43], iterationCount: 1, maxIterations: 5, reason: 'review loop' },
      },
      { type: 'shepherd.completed', data: { prUrl: 'https://github.com/o/r/pull/42', outcome: 'merged' } },
    ];
    const timestamps = persisted.map((_, index) => `2026-03-07T1${String(index)}:00:00.000Z`);

    expect(RETIRED_SHEPHERD_TYPES.map((type) => EVENT_ANNOTATIONS[type]?.lifecycle)).toEqual([
      'retired',
      'retired',
      'retired',
      'retired',
    ]);
    expect(EVENT_ANNOTATIONS['shepherd.iteration']?.lifecycle).toBe('active');

    const backend = new SqliteBackend(path.join(tempDir, 'exarchos.db'));
    backend.initialize();
    try {
      persisted.forEach((event, index) => {
        backend.appendEvent(stream, {
          streamId: stream,
          sequence: index + 1,
          type: event.type,
          timestamp: timestamps[index] ?? '',
          data: event.data,
        });
      });

      const replayed = await new EventStore(tempDir, { backend }).query(stream);

      expect(replayed.map((event) => event.type)).toEqual(persisted.map((event) => event.type));
      expect(
        RETIRED_SHEPHERD_TYPES.map(
          (type) => EVENT_DATA_SCHEMAS[type].safeParse(replayed.find((event) => event.type === type)?.data).success,
        ),
      ).toEqual([true, true, true, true]);

      const view = replayed.reduce(
        (state, event) => shepherdStatusProjection.apply(state, event),
        shepherdStatusProjection.init(),
      );
      expect(view).toEqual({
        overallStatus: 'escalate',
        prs: [],
        iteration: 1,
        maxIterations: 5,
        startedAt: timestamps[1],
        approvalRequestedAt: timestamps[3],
        escalation: {
          reason: 'review loop',
          iterationCount: 1,
          maxIterations: 5,
          escalatedAt: timestamps[4],
        },
        completedAt: timestamps[5],
        outcome: 'merged',
      });

      const foldState = (events: readonly WorkflowEvent[]) =>
        events.reduce((state, event) => workflowStateProjection.apply(state, event), workflowStateProjection.init());
      const withoutRetired = replayed.filter((event) => !RETIRED_SHEPHERD_TYPE_SET.has(event.type));
      expect(withoutRetired).toHaveLength(2);
      expect(foldState(replayed)).toEqual(foldState(withoutRetired));
    } finally {
      backend.close();
    }
  });
});
