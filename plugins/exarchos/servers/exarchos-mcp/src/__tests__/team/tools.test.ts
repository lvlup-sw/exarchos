import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleTeamSpawn,
  handleTeamMessage,
  handleTeamBroadcast,
  handleTeamShutdown,
  handleTeamStatus,
} from '../../team/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'team-tools-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── A17: Team MCP Tools ────────────────────────────────────────────────────

describe('handleTeamSpawn', () => {
  it('valid input spawns teammate', async () => {
    const result = await handleTeamSpawn(
      {
        name: 'agent-1',
        role: 'implementer',
        taskId: 't1',
        taskTitle: 'Build login',
        streamId: 'wf-001',
      },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        name: 'agent-1',
        role: 'implementer',
        taskId: 't1',
        status: 'active',
      }),
    );

    // Verify event was emitted
    const events = await store.query('wf-001', { type: 'task.assigned' });
    expect(events).toHaveLength(1);
  });

  it('invalid role returns error', async () => {
    const result = await handleTeamSpawn(
      {
        name: 'agent-1',
        role: 'nonexistent-role',
        taskId: 't1',
        taskTitle: 'Task',
        streamId: 'wf-001',
      },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ROLE');
  });

  it('duplicate name returns error', async () => {
    await handleTeamSpawn(
      { name: 'agent-1', role: 'implementer', taskId: 't1', taskTitle: 'Task 1', streamId: 'wf-001' },
      tempDir,
    );

    const result = await handleTeamSpawn(
      { name: 'agent-1', role: 'reviewer', taskId: 't2', taskTitle: 'Task 2', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SPAWN_FAILED');
  });
});

describe('handleTeamMessage', () => {
  beforeEach(async () => {
    await handleTeamSpawn(
      { name: 'agent-1', role: 'implementer', taskId: 't1', taskTitle: 'Task 1', streamId: 'wf-001' },
      tempDir,
    );
    await handleTeamSpawn(
      { name: 'agent-2', role: 'reviewer', taskId: 't2', taskTitle: 'Task 2', streamId: 'wf-001' },
      tempDir,
    );
  });

  it('valid target sends message', async () => {
    const result = await handleTeamMessage(
      { from: 'agent-1', to: 'agent-2', content: 'Review ready', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'agent.message' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        from: 'agent-1',
        to: 'agent-2',
        content: 'Review ready',
      }),
    );
  });

  it('message to unknown target returns error', async () => {
    const result = await handleTeamMessage(
      { from: 'agent-1', to: 'unknown', content: 'Hello', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MESSAGE_FAILED');
  });
});

describe('handleTeamBroadcast', () => {
  beforeEach(async () => {
    await handleTeamSpawn(
      { name: 'agent-1', role: 'implementer', taskId: 't1', taskTitle: 'Task 1', streamId: 'wf-001' },
      tempDir,
    );
    await handleTeamSpawn(
      { name: 'agent-2', role: 'reviewer', taskId: 't2', taskTitle: 'Task 2', streamId: 'wf-001' },
      tempDir,
    );
  });

  it('broadcasts to all teammates', async () => {
    const result = await handleTeamBroadcast(
      { from: 'orchestrator', content: 'All tasks paused', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'agent.message' });
    const broadcasts = events.filter(
      (e) => (e.data as Record<string, unknown>)?.messageType === 'broadcast',
    );
    expect(broadcasts).toHaveLength(1);
  });
});

describe('handleTeamShutdown', () => {
  beforeEach(async () => {
    await handleTeamSpawn(
      { name: 'agent-1', role: 'implementer', taskId: 't1', taskTitle: 'Task 1', streamId: 'wf-001' },
      tempDir,
    );
  });

  it('valid name shuts down teammate', async () => {
    const result = await handleTeamShutdown(
      { name: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);

    // Verify teammate is gone
    const statusResult = await handleTeamStatus({}, tempDir);
    expect(statusResult.success).toBe(true);
    const data = statusResult.data as { activeCount: number };
    expect(data.activeCount).toBe(0);
  });

  it('unknown name returns error', async () => {
    const result = await handleTeamShutdown(
      { name: 'unknown', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SHUTDOWN_FAILED');
  });
});

describe('handleTeamStatus', () => {
  it('returns all teammates', async () => {
    await handleTeamSpawn(
      { name: 'agent-1', role: 'implementer', taskId: 't1', taskTitle: 'Task 1', streamId: 'wf-001' },
      tempDir,
    );
    await handleTeamSpawn(
      { name: 'agent-2', role: 'reviewer', taskId: 't2', taskTitle: 'Task 2', streamId: 'wf-001' },
      tempDir,
    );

    const result = await handleTeamStatus({}, tempDir);

    expect(result.success).toBe(true);
    const data = result.data as { teammates: unknown[]; activeCount: number; staleCount: number };
    expect(data.teammates).toHaveLength(2);
    expect(data.activeCount).toBe(2);
    expect(data.staleCount).toBe(0);
  });
});
