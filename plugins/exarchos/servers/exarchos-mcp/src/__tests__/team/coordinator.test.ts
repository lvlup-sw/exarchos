import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TeamCoordinator } from '../../team/coordinator.js';
import type { TeammateInfo } from '../../team/coordinator.js';
import { EventStore } from '../../event-store/store.js';
import { ROLES } from '../../team/roles.js';
import type { TaskInput } from '../../team/composition.js';

let tempDir: string;
let eventStore: EventStore;
let coordinator: TeamCoordinator;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'coordinator-test-'));
  eventStore = new EventStore(tempDir);
  coordinator = new TeamCoordinator(eventStore, {
    maxTeammates: 5,
    stateDir: tempDir,
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── A14: Team Coordinator — Spawn Lifecycle ────────────────────────────────

describe('TeamCoordinator spawn', () => {
  const task: TaskInput = { taskId: 't1', title: 'Build login' };

  it('tracks teammate and emits TaskAssigned event', async () => {
    const info = await coordinator.spawn('agent-1', ROLES.implementer, task, 'test-stream');

    expect(info.name).toBe('agent-1');
    expect(info.role).toBe('implementer');
    expect(info.taskId).toBe('t1');
    expect(info.status).toBe('active');
    expect(info.spawnedAt).toBeDefined();
    expect(info.lastActivityAt).toBeDefined();

    // Verify event was emitted
    const events = await eventStore.query('test-stream', { type: 'task.assigned' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        taskId: 't1',
        title: 'Build login',
        assignee: 'agent-1',
      }),
    );
  });

  it('rejects if max teammates reached', async () => {
    const smallCoordinator = new TeamCoordinator(eventStore, {
      maxTeammates: 2,
      stateDir: tempDir,
    });

    await smallCoordinator.spawn('agent-1', ROLES.implementer, { taskId: 't1', title: 'Task 1' }, 'stream');
    await smallCoordinator.spawn('agent-2', ROLES.implementer, { taskId: 't2', title: 'Task 2' }, 'stream');

    await expect(
      smallCoordinator.spawn('agent-3', ROLES.implementer, { taskId: 't3', title: 'Task 3' }, 'stream'),
    ).rejects.toThrow(/max teammates/i);
  });

  it('rejects if duplicate name', async () => {
    await coordinator.spawn('agent-1', ROLES.implementer, task, 'stream');

    await expect(
      coordinator.spawn('agent-1', ROLES.reviewer, { taskId: 't2', title: 'Task 2' }, 'stream'),
    ).rejects.toThrow(/already exists/i);
  });

  it('spawn includes worktree path when provided', async () => {
    const info = await coordinator.spawn(
      'agent-1',
      ROLES.implementer,
      task,
      'test-stream',
      '/tmp/worktree/login',
    );

    const events = await eventStore.query('test-stream', { type: 'task.assigned' });
    expect(events[0].data).toEqual(
      expect.objectContaining({
        worktree: '/tmp/worktree/login',
      }),
    );
  });
});

// ─── A15: Team Coordinator — Message Routing + Broadcast ────────────────────

describe('TeamCoordinator messaging', () => {
  beforeEach(async () => {
    await coordinator.spawn('agent-1', ROLES.implementer, { taskId: 't1', title: 'Task 1' }, 'stream');
    await coordinator.spawn('agent-2', ROLES.reviewer, { taskId: 't2', title: 'Task 2' }, 'stream');
  });

  it('sendMessage emits AgentMessage event', async () => {
    await coordinator.sendMessage('agent-1', 'agent-2', 'Please review my code', 'stream');

    const events = await eventStore.query('stream', { type: 'agent.message' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        from: 'agent-1',
        to: 'agent-2',
        content: 'Please review my code',
        messageType: 'direct',
      }),
    );
  });

  it('broadcast emits to all teammates', async () => {
    await coordinator.broadcast('orchestrator', 'All tasks paused', 'stream');

    const events = await eventStore.query('stream', { type: 'agent.message' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        from: 'orchestrator',
        to: '*',
        content: 'All tasks paused',
        messageType: 'broadcast',
      }),
    );
  });

  it('message to unknown teammate returns error', async () => {
    await expect(
      coordinator.sendMessage('agent-1', 'unknown-agent', 'Hello', 'stream'),
    ).rejects.toThrow(/not found/i);
  });

  it('sendMessage with custom messageType', async () => {
    await coordinator.sendMessage('agent-1', 'agent-2', 'Status update', 'stream', 'status');

    const events = await eventStore.query('stream', { type: 'agent.message' });
    expect(events[0].data).toEqual(
      expect.objectContaining({
        messageType: 'status',
      }),
    );
  });
});

// ─── A16: Team Coordinator — Shutdown + Health Check ────────────────────────

describe('TeamCoordinator shutdown', () => {
  beforeEach(async () => {
    await coordinator.spawn('agent-1', ROLES.implementer, { taskId: 't1', title: 'Task 1' }, 'stream');
    await coordinator.spawn('agent-2', ROLES.reviewer, { taskId: 't2', title: 'Task 2' }, 'stream');
  });

  it('shutdown removes teammate and emits event', async () => {
    await coordinator.shutdown('agent-1', 'stream');

    const status = coordinator.getStatus();
    const names = status.teammates.map((t) => t.name);
    expect(names).not.toContain('agent-1');
    expect(status.activeCount).toBe(1);

    // Verify shutdown was recorded — we check for a generic event approach
    // The coordinator emits an agent.message or we just verify it's gone
  });

  it('shutdown emits agent.message shutdown event', async () => {
    await coordinator.shutdown('agent-1', 'stream');

    const events = await eventStore.query('stream', { type: 'agent.message' });
    const shutdownEvents = events.filter(
      (e) => (e.data as Record<string, unknown>)?.messageType === 'shutdown',
    );
    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0].data).toEqual(
      expect.objectContaining({
        from: 'system',
        to: 'agent-1',
        content: 'shutdown',
        messageType: 'shutdown',
      }),
    );
  });

  it('shutdownAll emits event for each teammate', async () => {
    await coordinator.spawn('agent-3', ROLES.implementer, { taskId: 't3', title: 'Task 3' }, 'stream');

    await coordinator.shutdownAll('stream');

    const status = coordinator.getStatus();
    expect(status.teammates).toHaveLength(0);
    expect(status.activeCount).toBe(0);

    const events = await eventStore.query('stream', { type: 'agent.message' });
    const shutdownEvents = events.filter(
      (e) => (e.data as Record<string, unknown>)?.messageType === 'shutdown',
    );
    expect(shutdownEvents).toHaveLength(3);
    const targets = shutdownEvents.map(
      (e) => (e.data as Record<string, unknown>)?.to,
    );
    expect(targets).toContain('agent-1');
    expect(targets).toContain('agent-2');
    expect(targets).toContain('agent-3');
  });

  it('shutdown non-existent member throws without emitting event', async () => {
    await expect(
      coordinator.shutdown('unknown-agent', 'stream'),
    ).rejects.toThrow(/not found/i);

    const events = await eventStore.query('stream', { type: 'agent.message' });
    const shutdownEvents = events.filter(
      (e) => (e.data as Record<string, unknown>)?.messageType === 'shutdown',
    );
    expect(shutdownEvents).toHaveLength(0);
  });

  it('shutdownAll cleans up all teammates', async () => {
    await coordinator.shutdownAll('stream');

    const status = coordinator.getStatus();
    expect(status.teammates).toHaveLength(0);
    expect(status.activeCount).toBe(0);
  });

  it('shutdown unknown teammate throws', async () => {
    await expect(
      coordinator.shutdown('unknown-agent', 'stream'),
    ).rejects.toThrow(/not found/i);
  });
});

describe('TeamCoordinator health check', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stale teammate detected after timeout', async () => {
    const coord = new TeamCoordinator(eventStore, {
      maxTeammates: 5,
      stateDir: tempDir,
    });

    await coord.spawn('agent-1', ROLES.implementer, { taskId: 't1', title: 'Task 1' }, 'stream');

    // Advance time by 30 minutes
    vi.advanceTimersByTime(30 * 60 * 1000);

    const health = coord.checkHealth(15); // stale after 15 minutes
    const staleAgents = health.filter((t) => t.status === 'stale');

    expect(staleAgents).toHaveLength(1);
    expect(staleAgents[0].name).toBe('agent-1');
  });

  it('recently active teammate is not stale', async () => {
    const coord = new TeamCoordinator(eventStore, {
      maxTeammates: 5,
      stateDir: tempDir,
    });

    await coord.spawn('agent-1', ROLES.implementer, { taskId: 't1', title: 'Task 1' }, 'stream');

    // Advance time slightly
    vi.advanceTimersByTime(5 * 60 * 1000); // 5 minutes

    // Update activity
    coord.updateActivity('agent-1');

    // Advance a bit more
    vi.advanceTimersByTime(5 * 60 * 1000); // another 5 minutes = 10 total

    const health = coord.checkHealth(15); // stale after 15 minutes
    const staleAgents = health.filter((t) => t.status === 'stale');

    expect(staleAgents).toHaveLength(0);
  });
});

describe('TeamCoordinator getStatus', () => {
  it('returns all teammate health', async () => {
    await coordinator.spawn('agent-1', ROLES.implementer, { taskId: 't1', title: 'Task 1' }, 'stream');
    await coordinator.spawn('agent-2', ROLES.reviewer, { taskId: 't2', title: 'Task 2' }, 'stream');

    const status = coordinator.getStatus();

    expect(status.teammates).toHaveLength(2);
    expect(status.activeCount).toBe(2);
    expect(status.staleCount).toBe(0);

    const names = status.teammates.map((t) => t.name);
    expect(names).toContain('agent-1');
    expect(names).toContain('agent-2');
  });
});
