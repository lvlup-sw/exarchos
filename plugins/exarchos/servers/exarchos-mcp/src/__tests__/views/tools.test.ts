import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleViewWorkflowStatus,
  handleViewTeamStatus,
  handleViewTasks,
  handleViewPipeline,
  resetMaterializerCache,
} from '../../views/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'view-tools-test-'));
  store = new EventStore(tempDir);
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Helper: populate a workflow stream ────────────────────────────────────

async function populateWorkflow(streamId: string) {
  await store.append(streamId, {
    type: 'workflow.started',
    data: { featureId: 'auth-feature', workflowType: 'feature' },
  });
  await store.append(streamId, {
    type: 'team.formed',
    data: {
      teammates: [
        { name: 'agent-1', role: 'coder', model: 'claude' },
        { name: 'agent-2', role: 'reviewer' },
      ],
    },
  });
  await store.append(streamId, {
    type: 'phase.transitioned',
    data: { from: 'started', to: 'delegating' },
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

// ─── A11: View MCP Tool Tests ──────────────────────────────────────────────

describe('handleViewWorkflowStatus', () => {
  it('should return workflow status view data', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewWorkflowStatus({ workflowId: 'wf-001' }, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('auth-feature');
    expect(data.workflowType).toBe('feature');
    expect(data.phase).toBe('delegating');
    expect(data.tasksTotal).toBe(2);
    expect(data.tasksCompleted).toBe(1);
  });

  it('should return empty view for nonexistent workflow', async () => {
    const result = await handleViewWorkflowStatus({ workflowId: 'nonexistent' }, tempDir);

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

    const result = await handleViewWorkflowStatus({}, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.featureId).toBe('default-feature');
  });

  it('should return VIEW_ERROR when workflowId contains invalid characters', async () => {
    const result = await handleViewWorkflowStatus(
      { workflowId: 'INVALID/ID' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toBeTruthy();
  });
});

describe('handleViewTeamStatus', () => {
  it('should return team composition and current tasks', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTeamStatus({ workflowId: 'wf-001' }, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const teammates = data.teammates as Array<{ name: string; role: string }>;
    expect(teammates).toHaveLength(2);
    expect(teammates[0].name).toBe('agent-1');
    expect(teammates[0].role).toBe('coder');
  });

  it('should use default streamId when workflowId is omitted', async () => {
    await store.append('default', {
      type: 'team.formed',
      data: {
        teammates: [
          { name: 'default-agent', role: 'coder' },
        ],
      },
    });

    const result = await handleViewTeamStatus({}, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const teammates = data.teammates as Array<{ name: string; role: string }>;
    expect(teammates).toHaveLength(1);
    expect(teammates[0].name).toBe('default-agent');
  });

  it('should return VIEW_ERROR when workflowId contains invalid characters', async () => {
    const result = await handleViewTeamStatus(
      { workflowId: 'INVALID/ID' },
      tempDir,
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

    const result = await handleViewTasks({ workflowId: 'wf-001' }, tempDir);

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

    const result = await handleViewTasks({}, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].taskId).toBe('dt1');
  });

  it('should return VIEW_ERROR when workflowId contains invalid characters', async () => {
    const result = await handleViewTasks(
      { workflowId: 'INVALID/ID' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toBeTruthy();
  });
});

describe('handleViewPipeline', () => {
  it('should aggregate pipeline data across workflows', async () => {
    await populateWorkflow('wf-001');

    // Add a second workflow
    await store.append('wf-002', {
      type: 'workflow.started',
      data: { featureId: 'billing-feature', workflowType: 'feature' },
    });
    await store.append('wf-002', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Build billing' },
    });

    const result = await handleViewPipeline({}, tempDir);

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
    const result = await handleViewPipeline({}, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(0);
  });

  it('should return VIEW_ERROR when discovered stream has invalid ID', async () => {
    // Create an events file with uppercase characters in the name,
    // which will cause assertSafeId to throw in SnapshotStore
    await fs.writeFile(
      path.join(tempDir, 'INVALID_STREAM.events.jsonl'),
      JSON.stringify({ type: 'workflow.started', sequence: 1, streamId: 'INVALID_STREAM', timestamp: new Date().toISOString(), data: {} }) + '\n',
    );

    const result = await handleViewPipeline({}, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toBeTruthy();
  });
});

// ─── B2: Singleton ViewMaterializer Cache ──────────────────────────────────

describe('ViewMaterializer Singleton Cache', () => {
  it('ViewMaterializer_Singleton_ReusedAcrossQueries: second call sees updated data via high-water mark', async () => {
    await populateWorkflow('wf-singleton');

    // First query
    const result1 = await handleViewWorkflowStatus({ workflowId: 'wf-singleton' }, tempDir);
    expect(result1.success).toBe(true);
    const data1 = result1.data as Record<string, unknown>;
    expect(data1.tasksCompleted).toBe(1);

    // Append more events to the same stream (second task completed)
    await store.append('wf-singleton', {
      type: 'task.claimed',
      data: { taskId: 't2', agentId: 'agent-2', claimedAt: '2025-06-15T11:00:00Z' },
    });
    await store.append('wf-singleton', {
      type: 'task.completed',
      data: { taskId: 't2', artifacts: ['signup.ts'], duration: 45 },
    });

    // Second query — uses cached materializer, but high-water mark should process new events
    const result2 = await handleViewWorkflowStatus({ workflowId: 'wf-singleton' }, tempDir);
    expect(result2.success).toBe(true);
    const data2 = result2.data as Record<string, unknown>;
    // Should see updated data: 2 tasks completed now
    expect(data2.tasksCompleted).toBe(2);
  });

  it('resetMaterializerCache_CreatesNewInstance: after reset, fresh state is used', async () => {
    await populateWorkflow('wf-reset');

    // First query to populate cache
    const result1 = await handleViewWorkflowStatus({ workflowId: 'wf-reset' }, tempDir);
    expect(result1.success).toBe(true);

    // Reset the cache
    resetMaterializerCache();

    // Query again — should still work with fresh instances
    const result2 = await handleViewWorkflowStatus({ workflowId: 'wf-reset' }, tempDir);
    expect(result2.success).toBe(true);
    const data2 = result2.data as Record<string, unknown>;
    expect(data2.featureId).toBe('auth-feature');
  });
});
