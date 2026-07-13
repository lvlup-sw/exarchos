// DR-8 (Task 013) — the INVENTORY / list-shaped view-contract batch.
//
// These tests pin the generalized view contract on the inventory views migrated
// in this task (`delegation_timeline`, `team_performance`, `workflow_status`,
// `tasks`): compact-by-default with `detail: true` restoring full rows, `page`
// metadata when list-shaped, P5 scope perceivability (`scope` + `unscopedTotal`),
// and a DR-2-style token-budget guard. Analytic/correlation views are Task 024.
//
// Kill-probe note: each assertion below fails if the migrated source hunks are
// reverted (compact/paging/scope disappear, or the payload blows past budget).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resetMaterializerCache,
  handleViewDelegationTimeline,
  handleViewTeamPerformance,
  handleViewWorkflowStatus,
  handleViewTasks,
} from './tools.js';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY, resolveEconomyBudget } from '../registry.js';
import { estimateOutputTokens, DEFAULT_VIEW_ITEM_CAP } from '../core/economy.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/** Effective per-action response budget the dispatch-core backstop enforces (Task 003). */
function effectiveBudget(action: string): number {
  const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view')!;
  const descriptor = viewTool.actions.find((a) => a.name === action)!;
  return resolveEconomyBudget(descriptor);
}

async function seedAssignedTask(
  store: EventStore,
  streamId: string,
  taskId: string,
  teammateName: string,
  correlationId?: string,
): Promise<void> {
  await store.append(streamId, {
    type: 'team.task.assigned',
    ...(correlationId ? { correlationId, operationId: `op-${correlationId}` } : {}),
    data: {
      taskId,
      teammateName,
      worktreePath: `/tmp/wt-${taskId}`,
      modules: ['auth'],
    },
  });
}

describe('DR-8 inventory view contract (Task 013)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-views-contract-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  // ─── Required: list-shaped views return page metadata and honor detail ──────

  it('viewsContract_ListShaped_ReturnPageMetadataAndHonorDetail', async () => {
    const streamId = 'contract-list';
    await seedAssignedTask(store, streamId, 'task-1', 'w1');
    await seedAssignedTask(store, streamId, 'task-2', 'w2');
    await seedAssignedTask(store, streamId, 'task-3', 'w3');

    // Compact-by-default: `page` metadata is present and rows omit the verbose
    // ISO timestamps.
    const compact = await handleViewDelegationTimeline({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactData = compact.data as {
      page: { total: number; offset: number; limit: number; hasMore: boolean };
      tasks: Array<Record<string, unknown>>;
    };
    expect(compactData.page).toEqual({
      total: 3,
      offset: 0,
      limit: DEFAULT_VIEW_ITEM_CAP,
      hasMore: false,
    });
    expect(compactData.tasks).toHaveLength(3);
    for (const row of compactData.tasks) {
      expect(row).toHaveProperty('taskId');
      // Compaction dropped the timestamps — the observable compact/detail split.
      expect(row).not.toHaveProperty('assignedAt');
      expect(row).not.toHaveProperty('completedAt');
    }

    // `detail: true` restores the full TimelineTask rows.
    const detailed = await handleViewDelegationTimeline(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    const detailedData = detailed.data as { tasks: Array<Record<string, unknown>> };
    for (const row of detailedData.tasks) {
      expect(row).toHaveProperty('assignedAt');
      expect(row).toHaveProperty('completedAt');
    }

    // An explicit `limit` narrows the window and flips `page.hasMore`.
    const paged = await handleViewDelegationTimeline(
      { workflowId: streamId, limit: 1, offset: 0 },
      tmpDir,
      store,
    );
    const pagedData = paged.data as {
      page: { total: number; limit: number; hasMore: boolean };
      tasks: unknown[];
    };
    expect(pagedData.tasks).toHaveLength(1);
    expect(pagedData.page).toMatchObject({ total: 3, limit: 1, hasMore: true });
  });

  // ─── Required: a migrated view stays under its effective token budget ───────

  it('viewsContract_MigratedView_StaysUnderEffectiveBudget', async () => {
    const streamId = 'contract-budget';
    // Populate a store whose FULL, un-capped, un-compacted timeline would blow
    // past the effective budget; the compact + default-cap contract must keep
    // the response under budget.
    for (let i = 0; i < 120; i++) {
      await seedAssignedTask(store, streamId, `t${i}`, 'w');
    }

    const result = await handleViewDelegationTimeline({ workflowId: streamId }, tmpDir, store);
    expect(result.success).toBe(true);

    const budget = effectiveBudget('delegation_timeline');
    const data = result.data as { tasks: unknown[] };
    // The default window caps the row count regardless of how many were seeded.
    expect(data.tasks.length).toBe(DEFAULT_VIEW_ITEM_CAP);
    expect(estimateOutputTokens(result.data)).toBeLessThanOrEqual(budget);
  });

  // ─── Required: a scoped view reports scope + unscopedTotal (P5) ─────────────

  it('viewsContract_ScopedView_ReportsUnscopedTotal', async () => {
    const streamId = 'contract-scope';
    // Two tasks tagged with different correlation IDs — the correlation filter
    // is this view's scope.
    await seedAssignedTask(store, streamId, 'task-X', 'wx', 'cor-X');
    await seedAssignedTask(store, streamId, 'task-Y', 'wy', 'cor-Y');

    const result = await handleViewDelegationTimeline(
      { workflowId: streamId, correlationId: 'cor-X' },
      tmpDir,
      store,
    );
    expect(result.success).toBe(true);
    const data = result.data as {
      scope: string;
      unscopedTotal: number;
      page: { total: number };
      tasks: Array<{ taskId: string }>;
    };

    // Only the cor-X task is in scope, but the pre-scope total is still perceivable.
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].taskId).toBe('task-X');
    expect(data.scope).toBe('correlation');
    expect(data.page.total).toBe(1);
    expect(data.unscopedTotal).toBe(2);

    // The hidden-rows escape hatch is surfaced so the elided cor-Y task is perceivable.
    expect(result.next_actions?.some((a) => a.verb === 'delegation_timeline')).toBe(true);

    // An unscoped call reports scope 'all' and unscopedTotal === total.
    const unscoped = await handleViewDelegationTimeline({ workflowId: streamId }, tmpDir, store);
    const unscopedData = unscoped.data as { scope: string; unscopedTotal: number };
    expect(unscopedData.scope).toBe('all');
    expect(unscopedData.unscopedTotal).toBe(2);
  });

  // ─── Peer: team_performance honors detail (compact drops modules roll-ups) ──

  it('viewsContract_TeamPerformance_CompactByDefault_DetailRestoresModules', async () => {
    const streamId = 'contract-team';
    await store.append(streamId, {
      type: 'team.task.completed',
      data: {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 5000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      },
    });

    // Compact default: teammates present, but the heavy `modules` roll-up and
    // per-teammate `moduleExpertise` are stripped.
    const compact = await handleViewTeamPerformance({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactData = compact.data as {
      teammates: Record<string, Record<string, unknown>>;
      modules?: unknown;
    };
    expect(compactData.teammates).toHaveProperty('worker-1');
    expect(compactData.modules).toBeUndefined();
    expect(compactData.teammates['worker-1']).not.toHaveProperty('moduleExpertise');

    // detail:true restores the full projection.
    const detailed = await handleViewTeamPerformance(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    const detailedData = detailed.data as {
      modules: Record<string, unknown>;
      teammates: Record<string, Record<string, unknown>>;
    };
    expect(detailedData).toHaveProperty('modules');
    expect(detailedData.teammates['worker-1']).toHaveProperty('moduleExpertise');
  });

  // ─── Peer: workflow_status honors detail (compact strips internal task store) ─

  it('viewsContract_WorkflowStatus_CompactStripsInternalTaskStore', async () => {
    const streamId = 'contract-status';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: 'status-feature', workflowType: 'feature' },
    });
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build' },
    });

    const compact = await handleViewWorkflowStatus({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactData = compact.data as Record<string, unknown>;
    // Public fields still present; the internal mirror is not leaked by default.
    expect(compactData.featureId).toBe('status-feature');
    expect(compactData).not.toHaveProperty('_taskStore');

    const detailed = await handleViewWorkflowStatus(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    expect((detailed.data as Record<string, unknown>)).toHaveProperty('_taskStore');
  });

  // ─── Peer: tasks — bare-array data, page/scope/unscopedTotal on `_meta` ─────

  it('viewsContract_Tasks_FilterScope_ReportsUnscopedTotalOnMeta', async () => {
    const streamId = 'contract-tasks';
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append(streamId, {
      type: 'task.completed',
      data: { taskId: 't1', artifacts: ['a.ts'], duration: 30 },
    });

    // Unfiltered: bare array preserved, page metadata + scope 'all' on `_meta`.
    const all = await handleViewTasks({ workflowId: streamId }, tmpDir, store);
    expect(all.success).toBe(true);
    expect(Array.isArray(all.data)).toBe(true);
    const allMeta = all._meta as {
      page: { total: number; offset: number; limit: number; hasMore: boolean };
      scope: string;
      unscopedTotal: number;
    };
    expect(allMeta.page).toEqual({
      total: 2,
      offset: 0,
      limit: DEFAULT_VIEW_ITEM_CAP,
      hasMore: false,
    });
    expect(allMeta.scope).toBe('all');
    expect(allMeta.unscopedTotal).toBe(2);
    // Compact-by-default drops the verbose `artifacts`/`duration` fields.
    const completed = (all.data as Array<Record<string, unknown>>).find((t) => t.taskId === 't1')!;
    expect(completed).not.toHaveProperty('artifacts');
    expect(completed).not.toHaveProperty('duration');

    // Filtered (scope): unscopedTotal stays perceivable above the scoped total.
    const filtered = await handleViewTasks(
      { workflowId: streamId, filter: { status: 'completed' } },
      tmpDir,
      store,
    );
    const filteredMeta = filtered._meta as {
      page: { total: number };
      scope: string;
      unscopedTotal: number;
    };
    expect((filtered.data as unknown[]).length).toBe(1);
    expect(filteredMeta.scope).toBe('filtered');
    expect(filteredMeta.page.total).toBe(1);
    expect(filteredMeta.unscopedTotal).toBe(2);

    // detail:true restores the verbose fields on the completed task.
    const detailed = await handleViewTasks(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    const detailedCompleted = (detailed.data as Array<Record<string, unknown>>).find(
      (t) => t.taskId === 't1',
    )!;
    expect(detailedCompleted).toHaveProperty('artifacts');
  });
});
