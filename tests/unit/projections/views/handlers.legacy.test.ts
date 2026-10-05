import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import {
  handleViewWorkflowStatus,
  handleViewTasks,
  handleViewPipeline,
  resetMaterializerCache,
  getOrCreateMaterializer,
} from '../../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'view-tools-test-'));
  store = new EventStore(tempDir);
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await rmrfAsync(tempDir);
});

async function populateWorkflow(streamId: string) {
  await store.append(streamId, {
    type: 'workflow.started',
    data: { featureId: 'auth-feature', workflowType: 'feature' },
  });
  await store.append(streamId, {
    type: 'workflow.transition',
    data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'test-workflow' },
  });
  await store.append(streamId, {
    type: 'task.assigned',
    data: { taskId: 't1', title: 'Build login', branch: 'feat/login', worktree: '/tmp/login' },
  });
  await store.append(streamId, {
    type: 'task.assigned',
    data: { taskId: 't2', title: 'Build signup', branch: 'feat/signup' },
  });
  await store.append(streamId, {
    type: 'task.claimed',
    data: { taskId: 't1', agentId: 'agent-1', claimedAt: '2025-06-15T10:00:00Z' },
  });
  await store.append(streamId, {
    type: 'task.completed',
    data: { taskId: 't1', artifacts: ['login.ts'], duration: 60 },
  });
  await store.append(streamId, {
    type: 'stack.position-filled',
    data: { position: 1, taskId: 't1', branch: 'feat/login' },
  });
}

describe('handleViewWorkflowStatus', () => {
  it('should return workflow status view data', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewWorkflowStatus({ workflowId: 'wf-001' }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('auth-feature');
    expect(data.workflowType).toBe('feature');
    expect(data.phase).toBe('delegating');
    expect(data.tasksTotal).toBe(2);
    expect(data.tasksCompleted).toBe(1);
  });

  it('should return empty view for nonexistent workflow', async () => {
    const result = await handleViewWorkflowStatus({ workflowId: 'nonexistent' }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('');
    expect(data.tasksTotal).toBe(0);
  });

  it('should use default streamId when workflowId is omitted', async () => {
    await store.append('default', {
      type: 'workflow.started',
      data: { featureId: 'default-feature', workflowType: 'feature' },
    });

    const result = await handleViewWorkflowStatus({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('default-feature');
  });

  it('should return VIEW_ERROR when workflowId contains invalid characters', async () => {
    const result = await handleViewWorkflowStatus(
      { workflowId: 'INVALID/ID' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toBeTruthy();
  });
});

describe('handleViewTasks', () => {
  it('should return task details for a workflow', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTasks({ workflowId: 'wf-001' }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);

    const t1 = data.find((t) => t.taskId === 't1');
    expect(t1).toBeDefined();
    expect(t1!.status).toBe('completed');
    expect(t1!.title).toBe('Build login');
  });

  it('should filter tasks by status', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTasks(
      { workflowId: 'wf-001', filter: { status: 'completed' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].taskId).toBe('t1');
  });

  it('should return all tasks when filter is empty object', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTasks(
      { workflowId: 'wf-001', filter: {} },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
  });

  it('should return empty array when filter matches nothing', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTasks(
      { workflowId: 'wf-001', filter: { status: 'nonexistent-status' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(0);
  });

  it('should use default streamId when workflowId is omitted', async () => {
    await store.append('default', {
      type: 'task.assigned',
      data: { taskId: 'dt1', title: 'Default task', branch: 'feat/default' },
    });

    const result = await handleViewTasks({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].taskId).toBe('dt1');
  });

  it('should return VIEW_ERROR when workflowId contains invalid characters', async () => {
    const result = await handleViewTasks(
      { workflowId: 'INVALID/ID' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toBeTruthy();
  });
});

describe('handleViewTasks limit', () => {
  it('handleViewTasks_WithLimit_ReturnsLimitedResults', async () => {
    await store.append('wf-limit', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append('wf-limit', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append('wf-limit', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Task 3', branch: 'feat/t3' },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-limit', limit: 2 },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
  });

  it('handleViewTasks_WithFilter_ReturnsOnlyMatching', async () => {
    await store.append('wf-filter-verify', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append('wf-filter-verify', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append('wf-filter-verify', {
      type: 'task.completed',
      data: { taskId: 't1', artifacts: ['a.ts'], duration: 30 },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-filter-verify', filter: { status: 'completed' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].taskId).toBe('t1');
  });

  /** Three of the four tasks match the filter, and the limit keeps two of them. */
  it('handleViewTasks_FilterAndLimit_AppliesBoth', async () => {
    await store.append('wf-both', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append('wf-both', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append('wf-both', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Task 3', branch: 'feat/t3' },
    });
    await store.append('wf-both', {
      type: 'task.assigned',
      data: { taskId: 't4', title: 'Task 4', branch: 'feat/t4' },
    });
    await store.append('wf-both', {
      type: 'task.completed',
      data: { taskId: 't1', artifacts: [], duration: 10 },
    });
    await store.append('wf-both', {
      type: 'task.completed',
      data: { taskId: 't2', artifacts: [], duration: 20 },
    });
    await store.append('wf-both', {
      type: 'task.completed',
      data: { taskId: 't3', artifacts: [], duration: 30 },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-both', filter: { status: 'completed' }, limit: 2 },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    for (const task of data) {
      expect(task.status).toBe('completed');
    }
  });
});

describe('handleViewTasks offset and fields', () => {
  it('handleViewTasks_WithOffset_SkipsTasks', async () => {
    await store.append('wf-offset', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append('wf-offset', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append('wf-offset', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Task 3', branch: 'feat/t3' },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-offset', offset: 1 },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
  });

  it('handleViewTasks_WithFields_ReturnsOnlyRequestedFields', async () => {
    await store.append('wf-fields', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1', worktree: '/tmp/wt1' },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-fields', fields: ['taskId', 'status'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    const keys = Object.keys(data[0]);
    expect(keys).toEqual(expect.arrayContaining(['taskId', 'status']));
    expect(keys).toHaveLength(2);
    expect(data[0].taskId).toBe('t1');
    expect(data[0].status).toBe('assigned');
  });

  it('handleViewTasks_WithFieldsAndFilter_AppliesBoth', async () => {
    await store.append('wf-ff', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append('wf-ff', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append('wf-ff', {
      type: 'task.completed',
      data: { taskId: 't1', artifacts: ['a.ts'], duration: 30 },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-ff', filter: { status: 'completed' }, fields: ['taskId', 'status'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].taskId).toBe('t1');
    expect(data[0].status).toBe('completed');
    const keys = Object.keys(data[0]);
    expect(keys).toHaveLength(2);
  });

  it('handleViewTasks_WithOffsetAndLimit_PaginatesCorrectly', async () => {
    await store.append('wf-ol', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append('wf-ol', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append('wf-ol', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Task 3', branch: 'feat/t3' },
    });

    const result = await handleViewTasks(
      { workflowId: 'wf-ol', offset: 1, limit: 1 },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
  });
});

describe('handleViewPipeline', () => {
  it('should aggregate pipeline data across workflows', async () => {
    await populateWorkflow('wf-001');

    await store.append('wf-002', {
      type: 'workflow.started',
      data: { featureId: 'billing-feature', workflowType: 'feature' },
    });
    await store.append('wf-002', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Build billing' },
    });

    const result = await handleViewPipeline({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(2);

    const wf1 = workflows.find((w) => w.featureId === 'auth-feature');
    const wf2 = workflows.find((w) => w.featureId === 'billing-feature');
    expect(wf1).toBeDefined();
    expect(wf2).toBeDefined();
    expect(wf1!.taskCount).toBe(2);
    expect(wf2!.taskCount).toBe(1);
  });

  it('should return empty workflows array when no event streams exist', async () => {
    const result = await handleViewPipeline({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(0);
  });

  it('handleViewPipeline_WithLimit_ReturnsLimitedWorkflows', async () => {
    await store.append('wf-p1', {
      type: 'workflow.started',
      data: { featureId: 'feat-1', workflowType: 'feature' },
    });
    await store.append('wf-p2', {
      type: 'workflow.started',
      data: { featureId: 'feat-2', workflowType: 'feature' },
    });
    await store.append('wf-p3', {
      type: 'workflow.started',
      data: { featureId: 'feat-3', workflowType: 'debug' },
    });

    const result = await handleViewPipeline({ limit: 2 }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(2);
  });

  it('handleViewPipeline_WithOffset_SkipsWorkflows', async () => {
    await store.append('wf-p1', {
      type: 'workflow.started',
      data: { featureId: 'feat-1', workflowType: 'feature' },
    });
    await store.append('wf-p2', {
      type: 'workflow.started',
      data: { featureId: 'feat-2', workflowType: 'feature' },
    });
    await store.append('wf-p3', {
      type: 'workflow.started',
      data: { featureId: 'feat-3', workflowType: 'debug' },
    });

    const result = await handleViewPipeline({ offset: 1 }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(2);
  });

  it('handleViewPipeline_WithLimitAndOffset_ReturnsSlice', async () => {
    await store.append('wf-p1', {
      type: 'workflow.started',
      data: { featureId: 'feat-1', workflowType: 'feature' },
    });
    await store.append('wf-p2', {
      type: 'workflow.started',
      data: { featureId: 'feat-2', workflowType: 'feature' },
    });
    await store.append('wf-p3', {
      type: 'workflow.started',
      data: { featureId: 'feat-3', workflowType: 'debug' },
    });

    const result = await handleViewPipeline({ limit: 1, offset: 1 }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(1);
  });

  it('handleViewPipeline_NoParams_ReturnsAll', async () => {
    await store.append('wf-p1', {
      type: 'workflow.started',
      data: { featureId: 'feat-1', workflowType: 'feature' },
    });
    await store.append('wf-p2', {
      type: 'workflow.started',
      data: { featureId: 'feat-2', workflowType: 'feature' },
    });
    await store.append('wf-p3', {
      type: 'workflow.started',
      data: { featureId: 'feat-3', workflowType: 'debug' },
    });

    const result = await handleViewPipeline({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(3);
  });

  it('handleViewPipeline_WithLimit_OnlyMaterializesSubset', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append(`wf-lazy-${i}`, {
        type: 'workflow.started',
        data: { featureId: `feat-lazy-${i}`, workflowType: 'feature' },
      });
    }

    const result = await handleViewPipeline({ limit: 2 }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>>; total: number };
    expect(data.workflows).toHaveLength(2);
    expect(data.total).toBe(5);
  });

  it('handleViewPipeline_WithOffsetAndLimit_ReturnsCorrectSlice', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append(`wf-slice-${i}`, {
        type: 'workflow.started',
        data: { featureId: `feat-slice-${i}`, workflowType: 'feature' },
      });
    }

    const result = await handleViewPipeline({ offset: 2, limit: 2 }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>>; total: number };
    expect(data.workflows).toHaveLength(2);
    expect(data.total).toBe(5);
  });

  it('handleViewPipeline_ReturnsTotal', async () => {
    for (let i = 1; i <= 3; i++) {
      await store.append(`wf-total-${i}`, {
        type: 'workflow.started',
        data: { featureId: `feat-total-${i}`, workflowType: 'feature' },
      });
    }

    const result = await handleViewPipeline({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>>; total: number };
    expect(data.total).toBe(3);
    expect(data.workflows).toHaveLength(3);
  });

  /**
   * The event store accepts stream ids that are not safe snapshot names: `__`-prefixed sentinels and two-segment slash ids.
   * `SnapshotStore` rejects an unsafe id with `Invalid streamId`, so the pipeline handler drops those ids with `isSnapshotSafeId`.
   * The view then succeeds and omits those streams.
   */
  it('excludes discovered streams with non-snapshot-safe IDs instead of crashing', async () => {
    await populateWorkflow('wf-001');

    for (const streamId of [
      'elicitation/0e24a37e-0043-46cc-9ae7-bdfa5bd8d2be',
      'workflow-state/meai-10-5',
      'workflow/preview-4-substrate-realization',
      'invariants/user',
      '__migration__',
    ]) {
      await store.append(streamId, {
        type: 'workflow.started',
        data: { featureId: streamId, workflowType: 'feature' },
      });
    }

    const result = await handleViewPipeline(
      { includeCompleted: true },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      expect(result.error?.message).not.toContain('Invalid streamId');
    }
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.featureId).toBe('auth-feature');
  });

  it('handleViewPipeline_ExcludesTerminalPhases_ByDefault', async () => {
    await store.append('wf-active', {
      type: 'workflow.started',
      data: { featureId: 'active-feat', workflowType: 'feature' },
    });
    await store.append('wf-done', {
      type: 'workflow.started',
      data: { featureId: 'done-feat', workflowType: 'feature' },
    });
    await store.append('wf-done', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'completed' },
    });
    await store.append('wf-cancelled', {
      type: 'workflow.started',
      data: { featureId: 'cancelled-feat', workflowType: 'debug' },
    });
    await store.append('wf-cancelled', {
      type: 'workflow.transition',
      data: { from: 'investigate', to: 'cancelled' },
    });

    const result = await handleViewPipeline({}, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>>; total: number };
    expect(data.total).toBe(1);
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0].featureId).toBe('active-feat');
  });

  it('handleViewPipeline_IncludesTerminalPhases_WhenRequested', async () => {
    await store.append('wf-inc-active', {
      type: 'workflow.started',
      data: { featureId: 'inc-active', workflowType: 'feature' },
    });
    await store.append('wf-inc-done', {
      type: 'workflow.started',
      data: { featureId: 'inc-done', workflowType: 'feature' },
    });
    await store.append('wf-inc-done', {
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'completed' },
    });

    const result = await handleViewPipeline({ includeCompleted: true }, tempDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>>; total: number };
    expect(data.total).toBe(2);
    expect(data.workflows).toHaveLength(2);
  });
});

describe('ViewMaterializer Singleton Cache', () => {
  it('ViewMaterializer_Singleton_ReusedAcrossQueries: second call sees updated data via high-water mark', async () => {
    await populateWorkflow('wf-singleton');

    const result1 = await handleViewWorkflowStatus({ workflowId: 'wf-singleton' }, tempDir, store);
    expect(result1.success).toBe(true);
    const data1 = result1.data as Record<string, unknown>;
    expect(data1.tasksCompleted).toBe(1);

    await store.append('wf-singleton', {
      type: 'task.claimed',
      data: { taskId: 't2', agentId: 'agent-2', claimedAt: '2025-06-15T11:00:00Z' },
    });
    await store.append('wf-singleton', {
      type: 'task.completed',
      data: { taskId: 't2', artifacts: ['signup.ts'], duration: 45 },
    });

    const result2 = await handleViewWorkflowStatus({ workflowId: 'wf-singleton' }, tempDir, store);
    expect(result2.success).toBe(true);
    const data2 = result2.data as Record<string, unknown>;
    expect(data2.tasksCompleted).toBe(2);
  });

  it('resetMaterializerCache_CreatesNewInstance: after reset, fresh state is used', async () => {
    await populateWorkflow('wf-reset');

    const result1 = await handleViewWorkflowStatus({ workflowId: 'wf-reset' }, tempDir, store);
    expect(result1.success).toBe(true);

    resetMaterializerCache();

    const result2 = await handleViewWorkflowStatus({ workflowId: 'wf-reset' }, tempDir, store);
    expect(result2.success).toBe(true);
    const data2 = result2.data as Record<string, unknown>;
    expect(data2.featureId).toBe('auth-feature');
  });

  it('should invalidate materializer cache when stateDir changes', () => {
    const materializer1 = getOrCreateMaterializer(tempDir);
    const otherDir = tempDir + '-other';
    const materializer2 = getOrCreateMaterializer(otherDir);
    expect(materializer2).not.toBe(materializer1);
  });
});

