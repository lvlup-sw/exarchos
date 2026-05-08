import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../event-store/atomic-appender.js';
import { SubagentStreamRouter } from './subagent-stream-router.js';

/**
 * SubagentStreamRouter — primitive for v2.9 bug cluster (#1224).
 *
 * Subagents in isolated worktrees emit `task.completed` events to their child
 * stream. The team coordinator runs in the main worktree and emits
 * `team.disbanded`. Without explicit propagation the parent stream never sees
 * the supporting `task.completed` events; the all-tasks-complete guard sees
 * `team.disbanded` with no backing events. The router fixes that by emitting
 * the parent-stream `task.completed` events and computing
 * `team.disbanded.tasksCompleted` from the parent stream's actual event count
 * — never from an in-memory accumulator.
 */
describe('SubagentStreamRouter', () => {
  let stateDir: string;
  let appender: AtomicAppender;
  let router: SubagentStreamRouter;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'subagent-stream-router-test-'));
    appender = new AtomicAppender({ stateDir });
    router = new SubagentStreamRouter({ appender, stateDir });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /**
   * RED test 1: parent-stream `task.completed` events land BEFORE
   * `team.disbanded` in the parent stream sequence. AtomicAppender's
   * per-stream serialization gives this property by construction; the router
   * just has to route both writes through the same appender.
   */
  it('SubagentStreamRouter_onTaskCompleted_emittedBeforeDisbanded', async () => {
    const parentStreamId = 'workflow-parent-1';
    const childStreamId = 'workflow-child-1';
    const teamId = 'team-alpha';

    await router.onTaskCompleted(parentStreamId, childStreamId, 'task-1', {
      taskId: 'task-1',
      teamId,
    });
    await router.onTaskCompleted(parentStreamId, childStreamId, 'task-2', {
      taskId: 'task-2',
      teamId,
    });
    await router.emitDisbanded(parentStreamId, {
      teamId,
      totalDurationMs: 1234,
      tasksFailed: 0,
    });

    const jsonlPath = path.join(stateDir, `${parentStreamId}.events.jsonl`);
    const contents = await readFile(jsonlPath, 'utf-8');
    const events = contents
      .trim()
      .split('\n')
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l));

    const taskCompletedEvents = events.filter(e => e.type === 'task.completed');
    const disbandedEvents = events.filter(e => e.type === 'team.disbanded');

    expect(taskCompletedEvents).toHaveLength(2);
    expect(disbandedEvents).toHaveLength(1);

    const maxTaskCompletedSeq = Math.max(...taskCompletedEvents.map(e => e.sequence));
    const disbandedSeq = disbandedEvents[0].sequence;
    expect(maxTaskCompletedSeq).toBeLessThan(disbandedSeq);
  });

  /**
   * RED test 2: this is the #1224 regression. `team.disbanded.tasksCompleted`
   * MUST be derived from querying the parent stream's actual `task.completed`
   * count for the team — NEVER from an in-memory accumulator. We don't pass
   * a count into `emitDisbanded`; the router queries.
   */
  it('SubagentStreamRouter_disbandedTasksCount_reflectsParentStreamNotInMemoryTally', async () => {
    const parentStreamId = 'workflow-parent-2';
    const childStreamId = 'workflow-child-2';
    const teamId = 'team-beta';

    // Emit three child task.completed events for this team.
    await router.onTaskCompleted(parentStreamId, childStreamId, 'task-1', {
      taskId: 'task-1',
      teamId,
    });
    await router.onTaskCompleted(parentStreamId, childStreamId, 'task-2', {
      taskId: 'task-2',
      teamId,
    });
    await router.onTaskCompleted(parentStreamId, childStreamId, 'task-3', {
      taskId: 'task-3',
      teamId,
    });

    // Emit a task.completed for an UNRELATED team — the router must scope its
    // count to teamId, not all task.completed events on the stream.
    await router.onTaskCompleted(parentStreamId, 'workflow-child-other', 'task-x', {
      taskId: 'task-x',
      teamId: 'team-other',
    });

    // emitDisbanded does NOT take a tasksCompleted argument — it queries.
    await router.emitDisbanded(parentStreamId, {
      teamId,
      totalDurationMs: 5000,
      tasksFailed: 0,
    });

    const jsonlPath = path.join(stateDir, `${parentStreamId}.events.jsonl`);
    const contents = await readFile(jsonlPath, 'utf-8');
    const events = contents
      .trim()
      .split('\n')
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l));

    const disbanded = events.find(
      e => e.type === 'team.disbanded' && (e.data?.teamId === teamId),
    );
    expect(disbanded).toBeDefined();
    expect(disbanded.data.tasksCompleted).toBe(3);
  });

  /**
   * RED test 3: idempotency. Replaying the same `<childStreamId>:<taskId>`
   * produces a single parent-stream event. Backed by AtomicAppender's
   * commit-on-success idempotencyKey cache.
   */
  it('SubagentStreamRouter_replayedTaskCompleted_singleParentEvent', async () => {
    const parentStreamId = 'workflow-parent-3';
    const childStreamId = 'workflow-child-3';
    const teamId = 'team-gamma';
    const taskId = 'task-replay';

    await router.onTaskCompleted(parentStreamId, childStreamId, taskId, {
      taskId,
      teamId,
    });
    // Same child stream + task id — must NOT produce a duplicate parent event.
    await router.onTaskCompleted(parentStreamId, childStreamId, taskId, {
      taskId,
      teamId,
    });
    await router.onTaskCompleted(parentStreamId, childStreamId, taskId, {
      taskId,
      teamId,
    });

    const jsonlPath = path.join(stateDir, `${parentStreamId}.events.jsonl`);
    const contents = await readFile(jsonlPath, 'utf-8');
    const events = contents
      .trim()
      .split('\n')
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l));

    const taskCompleted = events.filter(
      e => e.type === 'task.completed' && e.data?.taskId === taskId,
    );
    expect(taskCompleted).toHaveLength(1);
  });
});
