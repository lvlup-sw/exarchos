// Tests for wave-scoped delegation readiness.
// Readiness for a wave counts only the tasks of that wave, not each `task.assigned` event on the stream.
// Without that scope, a 4-task wave waits for the worktree of each historical task.
// The tests call `computeScopedWorktrees` directly and through the `delegation_readiness` view action.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { computeScopedWorktrees } from '../../../../src/verbs/team/prepare-delegation.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import {
  delegationReadinessProjection,
  type DelegationReadinessState,
} from '../../../../src/projections/views/delegation-readiness-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const HISTORICAL_TASK_COUNT = 17;
const WAVE = [{ id: 'T-015' }, { id: 'T-016' }, { id: 'T-017' }, { id: 'T-018' }];

function taskId(index: number): string {
  return `T-${String(index).padStart(3, '0')}`;
}

function event(sequence: number, type: string, data: Record<string, unknown>): WorkflowEvent {
  return {
    streamId: 'wfq-002',
    sequence,
    timestamp: new Date(Date.parse('2026-07-21T00:00:00.000Z') + sequence * 1000).toISOString(),
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent;
}

/**
 * Fold a workflow that approved its plan and then assigned 18 tasks — the wave
 * under test is the last four.
 */
function foldHistoricalWorkflow(readyTaskIds: readonly string[]): DelegationReadinessState {
  let state = delegationReadinessProjection.init();
  let sequence = 1;

  state = delegationReadinessProjection.apply(
    state,
    event(sequence++, 'state.patched', {
      patch: { 'planReview.approved': true, 'artifacts.plan': 'docs/specs/wfq-002.md' },
    }),
  );

  for (let i = 1; i <= HISTORICAL_TASK_COUNT + 1; i++) {
    state = delegationReadinessProjection.apply(
      state,
      event(sequence++, 'task.assigned', { taskId: taskId(i) }),
    );
  }

  for (const id of readyTaskIds) {
    state = delegationReadinessProjection.apply(
      state,
      event(sequence++, 'worktree.created', { taskId: id, worktreePath: `/wt/${id}` }),
    );
  }

  return state;
}

describe('wave-scoped delegation readiness (WFQ-002)', () => {
  /** The projection counts the whole stream, but the scoped result counts only the four tasks of the wave. */
  it('Readiness_EighteenHistoricalAssignments_ScopesExpectedToWaveSize', () => {
    const state = foldHistoricalWorkflow([]);
    expect(state.worktrees.expected).toBe(HISTORICAL_TASK_COUNT + 1);

    const scoped = computeScopedWorktrees(state, WAVE);
    expect(scoped.expected).toBe(WAVE.length);
    expect(scoped.ready).toBe(0);
    expect(scoped.pending).toBe(WAVE.length);
    expect(scoped.blockers).toContain('4 worktrees pending');
  });

  /** The worktrees of the wave tasks make the wave ready, although 14 other tasks have no worktree. */
  it('Readiness_WaveWorktreesCreated_ReadyAfterExactlyNEvents', () => {
    const state = foldHistoricalWorkflow(WAVE.map((t) => t.id));
    expect(state.worktrees.expected).toBe(HISTORICAL_TASK_COUNT + 1);
    expect(state.worktrees.ready).toBe(WAVE.length);

    const scoped = computeScopedWorktrees(state, WAVE);
    expect(scoped.expected).toBe(WAVE.length);
    expect(scoped.ready).toBe(WAVE.length);
    expect(scoped.pending).toBe(0);
    expect(
      scoped.blockers.filter((b) => /worktrees pending$/.test(b)),
      'a fully provisioned wave has no pending-worktree blocker',
    ).toEqual([]);
  });

  /** A worktree for a task outside the wave does not count toward the wave. */
  it('Readiness_OtherWaveWorktreesCreated_DoesNotSatisfyThisWave', () => {
    const state = foldHistoricalWorkflow([taskId(1), taskId(2), taskId(3), taskId(4)]);
    const scoped = computeScopedWorktrees(state, WAVE);
    expect(scoped.ready).toBe(0);
    expect(scoped.pending).toBe(WAVE.length);
  });
});

describe('delegation_readiness view wave scoping (WFQ-002)', () => {
  let stateDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(nodePath.join(tmpdir(), 'wfq-002-'));
    ctx = { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function seed(readyTaskIds: readonly string[]): Promise<void> {
    await ctx.eventStore.append('wfq-002', {
      type: 'state.patched',
      data: { patch: { 'planReview.approved': true, 'artifacts.plan': 'docs/specs/wfq-002.md' } },
    });
    for (let i = 1; i <= HISTORICAL_TASK_COUNT + 1; i++) {
      await ctx.eventStore.append('wfq-002', {
        type: 'task.assigned',
        data: { taskId: taskId(i) },
      });
    }
    for (const id of readyTaskIds) {
      await ctx.eventStore.append('wfq-002', {
        type: 'worktree.created',
        data: { taskId: id, worktreePath: `/wt/${id}` },
      });
    }
  }

  function worktreesOf(result: { data?: unknown }): { expected: number; ready: number } {
    const envelope = result.data as { data?: unknown };
    const view = (envelope?.data ?? result.data) as {
      worktrees: { expected: number; ready: number };
    };
    return view.worktrees;
  }

  it('DelegationReadinessView_NoTasksArg_ReportsWholeStream', async () => {
    await seed([]);
    const result = await handleView(
      { action: 'delegation_readiness', workflowId: 'wfq-002' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(worktreesOf(result).expected).toBe(HISTORICAL_TASK_COUNT + 1);
  });

  it('DelegationReadinessView_TasksArg_ScopesToWave', async () => {
    await seed([]);
    const result = await handleView(
      { action: 'delegation_readiness', workflowId: 'wfq-002', tasks: WAVE.map((t) => t.id) },
      ctx,
    );
    expect(result.success).toBe(true);
    const worktrees = worktreesOf(result);
    expect(worktrees.expected).toBe(WAVE.length);
    expect(worktrees.ready).toBe(0);
  });

  it('DelegationReadinessView_TasksArgFullyProvisioned_ReportsReady', async () => {
    await seed(WAVE.map((t) => t.id));
    const result = await handleView(
      { action: 'delegation_readiness', workflowId: 'wfq-002', tasks: WAVE.map((t) => t.id) },
      ctx,
    );
    expect(result.success).toBe(true);
    const envelope = result.data as { data?: unknown };
    const view = (envelope?.data ?? result.data) as DelegationReadinessState;
    expect(view.worktrees.expected).toBe(WAVE.length);
    expect(view.worktrees.ready).toBe(WAVE.length);
    expect(view.blockers.filter((b) => /worktrees pending$/.test(b))).toEqual([]);
    expect(view.ready).toBe(true);
  });
});
