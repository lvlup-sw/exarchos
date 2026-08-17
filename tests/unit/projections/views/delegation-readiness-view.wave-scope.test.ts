// ─── WFQ-002: wave-scoped delegation readiness ───────────────────────────────
//
// CB-2 (phase-gate v2.12 dogfood): a 4-task wave inside a 17-task workflow was
// blocked because readiness derived `expected` from EVERY historical
// `task.assigned` event, then waited for all 17 worktrees. Readiness for a wave
// must be computed over exactly the wave's task set.
//
// The scoping core is `computeScopedWorktrees`. These tests pin BOTH consumers
// to it — `prepare_delegation` (which threads `args.tasks`) and the
// `delegation_readiness` view action (which threads `tasks`) — so the two
// surfaces cannot report different readiness for the same wave (DIM-1).
// ─────────────────────────────────────────────────────────────────────────────

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
  it('Readiness_EighteenHistoricalAssignments_ScopesExpectedToWaveSize', () => {
    const state = foldHistoricalWorkflow([]);
    // The projection still tracks the whole stream…
    expect(state.worktrees.expected).toBe(HISTORICAL_TASK_COUNT + 1);

    // …but the wave is judged on exactly its own four tasks.
    const scoped = computeScopedWorktrees(state, WAVE);
    expect(scoped.expected).toBe(WAVE.length);
    expect(scoped.ready).toBe(0);
    expect(scoped.pending).toBe(WAVE.length);
    expect(scoped.blockers).toContain('4 worktrees pending');
  });

  it('Readiness_WaveWorktreesCreated_ReadyAfterExactlyNEvents', () => {
    // N worktree.created events for the WAVE's tasks must clear the wave, even
    // though 14 other historical tasks have no worktree at all.
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

  it('Readiness_OtherWaveWorktreesCreated_DoesNotSatisfyThisWave', () => {
    // Worktrees for tasks OUTSIDE the wave must not count toward it.
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
