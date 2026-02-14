// ─── Composite Orchestrate Handler Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock team handler functions ────────────────────────────────────────────

vi.mock('../team/tools.js', () => ({
  handleTeamSpawn: vi.fn(),
  handleTeamMessage: vi.fn(),
  handleTeamBroadcast: vi.fn(),
  handleTeamShutdown: vi.fn(),
  handleTeamStatus: vi.fn(),
}));

// ─── Mock task handler functions ────────────────────────────────────────────

vi.mock('../tasks/tools.js', () => ({
  handleTaskClaim: vi.fn(),
  handleTaskComplete: vi.fn(),
  handleTaskFail: vi.fn(),
}));

import { handleTeamSpawn, handleTeamMessage, handleTeamBroadcast, handleTeamShutdown, handleTeamStatus } from '../team/tools.js';
import { handleTaskClaim, handleTaskComplete, handleTaskFail } from '../tasks/tools.js';
import { handleOrchestrate } from './composite.js';

const STATE_DIR = '/tmp/test-state';

function successResult(data: unknown): ToolResult {
  return { success: true, data };
}

describe('handleOrchestrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Team Actions ───────────────────────────────────────────────────────

  describe('team actions', () => {
    it('handleOrchestrate_TeamSpawn_DelegatesToHandleTeamSpawn', async () => {
      // Arrange
      const expected = successResult({ name: 'agent-1' });
      vi.mocked(handleTeamSpawn).mockResolvedValue(expected);
      const args = {
        action: 'team_spawn',
        name: 'agent-1',
        role: 'implementer',
        taskId: 't1',
        taskTitle: 'Do stuff',
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTeamSpawn).toHaveBeenCalledWith(
        { name: 'agent-1', role: 'implementer', taskId: 't1', taskTitle: 'Do stuff', streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TeamMessage_DelegatesToHandleTeamMessage', async () => {
      // Arrange
      const expected = successResult({ sent: true });
      vi.mocked(handleTeamMessage).mockResolvedValue(expected);
      const args = {
        action: 'team_message',
        from: 'orchestrator',
        to: 'agent-1',
        content: 'hello',
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTeamMessage).toHaveBeenCalledWith(
        { from: 'orchestrator', to: 'agent-1', content: 'hello', streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TeamBroadcast_DelegatesToHandleTeamBroadcast', async () => {
      // Arrange
      const expected = successResult({ broadcast: true });
      vi.mocked(handleTeamBroadcast).mockResolvedValue(expected);
      const args = {
        action: 'team_broadcast',
        from: 'orchestrator',
        content: 'attention all',
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTeamBroadcast).toHaveBeenCalledWith(
        { from: 'orchestrator', content: 'attention all', streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TeamShutdown_DelegatesToHandleTeamShutdown', async () => {
      // Arrange
      const expected = successResult({ shutdown: true });
      vi.mocked(handleTeamShutdown).mockResolvedValue(expected);
      const args = {
        action: 'team_shutdown',
        name: 'agent-1',
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTeamShutdown).toHaveBeenCalledWith(
        { name: 'agent-1', streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TeamStatus_DelegatesToHandleTeamStatus', async () => {
      // Arrange
      const expected = successResult({ activeCount: 2, staleCount: 0 });
      vi.mocked(handleTeamStatus).mockResolvedValue(expected);
      const args = {
        action: 'team_status',
        summary: true,
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTeamStatus).toHaveBeenCalledWith(
        { summary: true },
        STATE_DIR,
      );
    });
  });

  // ─── Task Actions ───────────────────────────────────────────────────────

  describe('task actions', () => {
    it('handleOrchestrate_TaskClaim_DelegatesToHandleTaskClaim', async () => {
      // Arrange
      const expected = successResult({ streamId: 's1', sequence: 1, type: 'task.claimed' });
      vi.mocked(handleTaskClaim).mockResolvedValue(expected);
      const args = {
        action: 'task_claim',
        taskId: 't1',
        agentId: 'agent-1',
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTaskClaim).toHaveBeenCalledWith(
        { taskId: 't1', agentId: 'agent-1', streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TaskComplete_DelegatesToHandleTaskComplete', async () => {
      // Arrange
      const expected = successResult({ streamId: 's1', sequence: 2, type: 'task.completed' });
      vi.mocked(handleTaskComplete).mockResolvedValue(expected);
      const args = {
        action: 'task_complete',
        taskId: 't1',
        result: { artifacts: ['file.ts'] },
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTaskComplete).toHaveBeenCalledWith(
        { taskId: 't1', result: { artifacts: ['file.ts'] }, streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TaskFail_DelegatesToHandleTaskFail', async () => {
      // Arrange
      const expected = successResult({ streamId: 's1', sequence: 3, type: 'task.failed' });
      vi.mocked(handleTaskFail).mockResolvedValue(expected);
      const args = {
        action: 'task_fail',
        taskId: 't1',
        error: 'something broke',
        diagnostics: { log: 'details' },
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTaskFail).toHaveBeenCalledWith(
        { taskId: 't1', error: 'something broke', diagnostics: { log: 'details' }, streamId: 's1' },
        STATE_DIR,
      );
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handleOrchestrate_UnknownAction_ReturnsError', async () => {
      // Arrange
      const args = { action: 'unknown_action' };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      expect(result.error?.message).toContain('unknown_action');
    });
  });
});
