import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJulesTools } from './tools.js';
import type { IJulesClient } from './types.js';
import {
  mockSource,
  mockPrivateSource,
  mockSession,
  mockSessionAwaitingApproval,
  mockSessionCompleted,
  mockActivityPlanning
} from './test/fixtures.js';

describe('Jules MCP Tools', () => {
  let mockClient: IJulesClient;
  let tools: ReturnType<typeof createJulesTools>;

  beforeEach(() => {
    mockClient = {
      listSources: vi.fn(),
      createSession: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(),
      approvePlan: vi.fn(),
      sendMessage: vi.fn(),
      getActivities: vi.fn(),
      deleteSession: vi.fn()
    };
    tools = createJulesTools(mockClient);
  });

  // ==========================================================================
  // jules_list_sources Tests
  // ==========================================================================
  describe('jules_list_sources', () => {
    it('should return formatted list of sources', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([
        mockSource,
        mockPrivateSource
      ]);

      // Act
      const result = await tools.jules_list_sources({});

      // Assert
      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sources).toHaveLength(2);
      expect(parsed.sources[0].repo).toBe('lvlup-sw/test-repo');
      expect(parsed.sources[1].isPrivate).toBe(true);
    });

    it('should return message when no sources found', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([]);

      // Act
      const result = await tools.jules_list_sources({});

      // Assert
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('No repositories connected');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockRejectedValue(
        new Error('API error')
      );

      // Act
      const result = await tools.jules_list_sources({});

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error');
      expect(result.content[0].text).toContain('API error');
    });
  });

  // ==========================================================================
  // jules_create_task Tests
  // ==========================================================================
  describe('jules_create_task', () => {
    it('should create task and return session info', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
      vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

      // Act
      const result = await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: 'Add user profile feature'
      });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe('abc123');
      expect(parsed.state).toBe('QUEUED');
      expect(parsed.url).toContain('jules.google');
    });

    it('should pass branch parameter correctly using githubRepoContext', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
      vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

      // Act
      await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: 'Test task',
        branch: 'develop'
      });

      // Assert
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceContext: {
            source: 'sources/github/lvlup-sw/test-repo',
            githubRepoContext: {
              startingBranch: 'develop'
            }
          }
        })
      );
    });

    it('should use default branch main when not specified', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
      vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

      // Act
      await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: 'Test task'
      });

      // Assert
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceContext: {
            source: 'sources/github/lvlup-sw/test-repo',
            githubRepoContext: {
              startingBranch: 'main'
            }
          }
        })
      );
    });

    it('should use correct source format with slashes', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
      vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

      // Act
      await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: 'Test task'
      });

      // Assert
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceContext: expect.objectContaining({
            source: 'sources/github/lvlup-sw/test-repo'
          })
        })
      );
    });

    it('should return error when repo is not connected to Jules', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);

      // Act
      const result = await tools.jules_create_task({
        repo: 'other-org/other-repo',
        prompt: 'Test task'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not connected to Jules');
      expect(result.content[0].text).toContain('lvlup-sw/test-repo');
      expect(mockClient.createSession).not.toHaveBeenCalled();
    });

    it('should return error with empty connected repos message when none connected', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([]);

      // Act
      const result = await tools.jules_create_task({
        repo: 'any/repo',
        prompt: 'Test task'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not connected to Jules');
      expect(result.content[0].text).toContain('none');
    });

    it('should automatically inject TDD instructions into prompt', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
      vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

      // Act
      await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: 'Add user profile feature'
      });

      // Assert - verify TDD instructions are appended
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('TDD Requirements')
        })
      );
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('RED Phase')
        })
      );
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('GREEN Phase')
        })
      );
    });

    it('should return error when repo is empty', async () => {
      // Act
      const result = await tools.jules_create_task({
        repo: '',
        prompt: 'Test task'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('repo');
    });

    it('should return error when prompt is empty', async () => {
      // Act
      const result = await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: ''
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('prompt');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
      vi.mocked(mockClient.createSession).mockRejectedValue(
        new Error('API error')
      );

      // Act
      const result = await tools.jules_create_task({
        repo: 'lvlup-sw/test-repo',
        prompt: 'Test task'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('API error');
    });
  });

  // ==========================================================================
  // jules_check_status Tests
  // ==========================================================================
  describe('jules_check_status', () => {
    it('should return status for queued session', async () => {
      // Arrange
      vi.mocked(mockClient.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await tools.jules_check_status({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe('abc123');
      expect(parsed.state).toBe('QUEUED');
      expect(parsed.title).toBe('Add user profile feature');
    });

    it('should return status with PR URL when completed', async () => {
      // Arrange
      vi.mocked(mockClient.getSession).mockResolvedValue(mockSessionCompleted);

      // Act
      const result = await tools.jules_check_status({ sessionId: 'abc123' });

      // Assert
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.state).toBe('COMPLETED');
      expect(parsed.pullRequestUrl).toContain('github.com');
    });

    it('should return error when sessionId is empty', async () => {
      // Act
      const result = await tools.jules_check_status({ sessionId: '' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      vi.mocked(mockClient.getSession).mockRejectedValue(
        new Error('Session not found')
      );

      // Act
      const result = await tools.jules_check_status({
        sessionId: 'invalid-id'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session not found');
    });
  });

  // ==========================================================================
  // jules_approve_plan Tests
  // ==========================================================================
  describe('jules_approve_plan', () => {
    it('should approve plan successfully', async () => {
      // Arrange
      vi.mocked(mockClient.approvePlan).mockResolvedValue(undefined);

      // Act
      const result = await tools.jules_approve_plan({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.sessionId).toBe('abc123');
      expect(mockClient.approvePlan).toHaveBeenCalledWith('abc123');
    });

    it('should return error when sessionId is empty', async () => {
      // Act
      const result = await tools.jules_approve_plan({ sessionId: '' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      vi.mocked(mockClient.approvePlan).mockRejectedValue(
        new Error('Session not awaiting plan approval')
      );

      // Act
      const result = await tools.jules_approve_plan({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'Session not awaiting plan approval'
      );
    });
  });

  // ==========================================================================
  // jules_send_feedback Tests
  // ==========================================================================
  describe('jules_send_feedback', () => {
    it('should send feedback successfully', async () => {
      // Arrange
      vi.mocked(mockClient.sendMessage).mockResolvedValue(undefined);

      // Act
      const result = await tools.jules_send_feedback({
        sessionId: 'abc123',
        message: 'Add more tests please'
      });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.sessionId).toBe('abc123');
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        'abc123',
        'Add more tests please'
      );
    });

    it('should return error when sessionId is empty', async () => {
      // Act
      const result = await tools.jules_send_feedback({
        sessionId: '',
        message: 'Test message'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('should return error when message is empty', async () => {
      // Act
      const result = await tools.jules_send_feedback({
        sessionId: 'abc123',
        message: ''
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('message');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      vi.mocked(mockClient.sendMessage).mockRejectedValue(
        new Error('Session not awaiting feedback')
      );

      // Act
      const result = await tools.jules_send_feedback({
        sessionId: 'abc123',
        message: 'Test'
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session not awaiting feedback');
    });
  });

  // ==========================================================================
  // jules_cancel Tests
  // ==========================================================================
  describe('jules_cancel', () => {
    it('should cancel session successfully', async () => {
      // Arrange
      vi.mocked(mockClient.deleteSession).mockResolvedValue(undefined);

      // Act
      const result = await tools.jules_cancel({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.sessionId).toBe('abc123');
      expect(mockClient.deleteSession).toHaveBeenCalledWith('abc123');
    });

    it('should return error when sessionId is empty', async () => {
      // Act
      const result = await tools.jules_cancel({ sessionId: '' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      vi.mocked(mockClient.deleteSession).mockRejectedValue(
        new Error('Cannot delete completed session')
      );

      // Act
      const result = await tools.jules_cancel({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'Cannot delete completed session'
      );
    });
  });

  // ==========================================================================
  // Tool Schemas Tests
  // ==========================================================================
  describe('Tool Schemas', () => {
    it('should export all tool schemas', async () => {
      const { toolSchemas } = await import('./tools.js');

      expect(toolSchemas.jules_list_sources).toBeDefined();
      expect(toolSchemas.jules_create_task).toBeDefined();
      expect(toolSchemas.jules_check_status).toBeDefined();
      expect(toolSchemas.jules_approve_plan).toBeDefined();
      expect(toolSchemas.jules_send_feedback).toBeDefined();
      expect(toolSchemas.jules_cancel).toBeDefined();
    });

    it('should have proper descriptions for all tools', async () => {
      const { toolDescriptions } = await import('./tools.js');

      expect(toolDescriptions.jules_list_sources.toLowerCase()).toContain('repositories');
      expect(toolDescriptions.jules_create_task.toLowerCase()).toContain('task');
      expect(toolDescriptions.jules_check_status.toLowerCase()).toContain('status');
      expect(toolDescriptions.jules_approve_plan.toLowerCase()).toContain('approve');
      expect(toolDescriptions.jules_send_feedback.toLowerCase()).toContain('feedback');
      expect(toolDescriptions.jules_cancel.toLowerCase()).toContain('cancel');
    });
  });
});
