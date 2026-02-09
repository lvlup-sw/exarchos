import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleViewWorkflowStatus,
  handleViewTeamStatus,
  handleViewTasks,
  handleViewPipeline,
} from '../../views/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'view-tools-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
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

  it('should return VIEW_ERROR when an internal error occurs', async () => {
    // Use an invalid streamId (uppercase) to trigger validateStreamId error in EventStore.query
    const result = await handleViewWorkflowStatus({ workflowId: '../INVALID' }, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toContain('Invalid streamId');
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

  it('should return VIEW_ERROR when an internal error occurs', async () => {
    // Use an invalid streamId (uppercase) to trigger validateStreamId error in EventStore.query
    const result = await handleViewTeamStatus({ workflowId: '../INVALID' }, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toContain('Invalid streamId');
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

  it('should return VIEW_ERROR when an internal error occurs', async () => {
    // Use an invalid streamId (uppercase) to trigger validateStreamId error in EventStore.query
    const result = await handleViewTasks({ workflowId: '../INVALID' }, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toContain('Invalid streamId');
  });

  it('should return all tasks when filter is an empty object', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTasks(
      { workflowId: 'wf-001', filter: {} },
      tempDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    // Empty filter object matches all tasks (every key passes vacuously)
    expect(data).toHaveLength(2);
  });

  it('should return empty array when filter matches no tasks', async () => {
    await populateWorkflow('wf-001');

    const result = await handleViewTasks(
      { workflowId: 'wf-001', filter: { status: 'nonexistent' } },
      tempDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(0);
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
    // tempDir is empty — no .events.jsonl files
    const result = await handleViewPipeline({}, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(0);
  });

  it('should return VIEW_ERROR when a discovered stream has an invalid ID', async () => {
    // Create a .events.jsonl file with an uppercase name so discoverStreams
    // returns the ID, but EventStore.query rejects it via validateStreamId
    const invalidFile = path.join(tempDir, 'UPPERCASE.events.jsonl');
    await writeFile(invalidFile, '');

    const result = await handleViewPipeline({}, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VIEW_ERROR');
    expect(result.error!.message).toContain('Invalid streamId');
  });
});
