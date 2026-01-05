import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJulesTools, detectQuestion } from './tools.js';
import type { IJulesClient } from './types.js';
import {
  mockSource,
  mockPrivateSource,
  mockSession,
  mockSessionAwaitingApproval,
  mockSessionCompleted,
  mockActivityPlanning,
  mockActivityAgentQuestion,
  mockActivityAgentStatement,
  mockActivityUserMessage,
  mockActivityPlanGenerated,
  mockActivityPlanApproved,
  mockActivityWithArtifacts
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

  // ==========================================================================
  // jules_get_conversation Tests
  // ==========================================================================
  describe('jules_get_conversation', () => {
    it('jules_get_conversation_ValidSession_ReturnsActivities', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockResolvedValue([
        mockActivityPlanGenerated,
        mockActivityAgentQuestion,
        mockActivityUserMessage,
        mockActivityAgentStatement
      ]);

      // Act
      const result = await tools.jules_get_conversation({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe('abc123');
      expect(parsed.activities).toHaveLength(4);
      expect(parsed.activities[0].type).toBe('plan');
      expect(parsed.activities[1].type).toBe('agent_message');
      expect(parsed.activities[2].type).toBe('user_message');
    });

    it('jules_get_conversation_WithLimit_RespectsLimit', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockResolvedValue([
        mockActivityPlanGenerated,
        mockActivityAgentQuestion,
        mockActivityUserMessage,
        mockActivityAgentStatement
      ]);

      // Act
      const result = await tools.jules_get_conversation({
        sessionId: 'abc123',
        limit: 2
      });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.activities).toHaveLength(2);
    });

    it('jules_get_conversation_EmptyActivities_ReturnsEmptyArray', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockResolvedValue([]);

      // Act
      const result = await tools.jules_get_conversation({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.activities).toEqual([]);
    });

    it('jules_get_conversation_EmptySessionId_ReturnsError', async () => {
      // Act
      const result = await tools.jules_get_conversation({ sessionId: '' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('jules_get_conversation_ApiError_ReturnsError', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockRejectedValue(
        new Error('Session not found')
      );

      // Act
      const result = await tools.jules_get_conversation({ sessionId: 'invalid' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session not found');
    });

    it('jules_get_conversation_WithArtifacts_IncludesArtifactSummary', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockResolvedValue([
        mockActivityWithArtifacts
      ]);

      // Act
      const result = await tools.jules_get_conversation({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.activities[0].artifacts).toBeDefined();
      expect(parsed.activities[0].artifacts[0].type).toBe('changeset');
    });
  });

  // ==========================================================================
  // detectQuestion Tests
  // ==========================================================================
  describe('detectQuestion', () => {
    it('detectQuestion_EndsWithQuestionMark_ReturnsTrue', () => {
      expect(detectQuestion('What framework should I use?')).toBe(true);
    });

    it('detectQuestion_ContainsShouldI_ReturnsTrue', () => {
      expect(detectQuestion('Should I use React or Vue for this project')).toBe(true);
    });

    it('detectQuestion_ContainsDoYouWant_ReturnsTrue', () => {
      expect(detectQuestion('Do you want me to proceed with the implementation')).toBe(true);
    });

    it('detectQuestion_ContainsPleaseConfirm_ReturnsTrue', () => {
      expect(detectQuestion('Please confirm the database schema before I continue')).toBe(true);
    });

    it('detectQuestion_ContainsWhichOption_ReturnsTrue', () => {
      expect(detectQuestion('Which option would you prefer for the API design')).toBe(true);
    });

    it('detectQuestion_ContainsCanYouProvide_ReturnsTrue', () => {
      expect(detectQuestion('Can you provide more details about the expected behavior')).toBe(true);
    });

    it('detectQuestion_PlainStatement_ReturnsFalse', () => {
      expect(detectQuestion('I have completed the implementation.')).toBe(false);
    });

    it('detectQuestion_ProgressUpdate_ReturnsFalse', () => {
      expect(detectQuestion('Working on the user profile feature now.')).toBe(false);
    });

    it('detectQuestion_EmptyString_ReturnsFalse', () => {
      expect(detectQuestion('')).toBe(false);
    });

    it('detectQuestion_QuestionMarkInMiddle_ReturnsFalse', () => {
      // Question mark in middle shouldn't trigger - must be end or question phrase
      expect(detectQuestion('The file config?.json was updated successfully.')).toBe(false);
    });
  });

  // ==========================================================================
  // jules_get_pending_question Tests
  // ==========================================================================
  describe('jules_get_pending_question', () => {
    it('jules_get_pending_question_HasQuestion_ReturnsQuestion', async () => {
      // Arrange - last activity is an agent question
      vi.mocked(mockClient.getActivities).mockResolvedValue([
        mockActivityPlanGenerated,
        mockActivityUserMessage,
        mockActivityAgentQuestion  // Last activity is a question
      ]);

      // Act
      const result = await tools.jules_get_pending_question({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe('abc123');
      expect(parsed.hasPendingQuestion).toBe(true);
      expect(parsed.question).toContain('Which database should I use');
      expect(parsed.detectedAt).toBeDefined();
    });

    it('jules_get_pending_question_NoQuestion_ReturnsFalse', async () => {
      // Arrange - last activity is a statement, not a question
      vi.mocked(mockClient.getActivities).mockResolvedValue([
        mockActivityPlanGenerated,
        mockActivityAgentQuestion,
        mockActivityUserMessage,
        mockActivityAgentStatement  // Last activity is NOT a question
      ]);

      // Act
      const result = await tools.jules_get_pending_question({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.hasPendingQuestion).toBe(false);
      expect(parsed.question).toBeUndefined();
    });

    it('jules_get_pending_question_NoAgentMessages_ReturnsFalse', async () => {
      // Arrange - only user messages and plans, no agent messages
      vi.mocked(mockClient.getActivities).mockResolvedValue([
        mockActivityPlanGenerated,
        mockActivityUserMessage
      ]);

      // Act
      const result = await tools.jules_get_pending_question({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.hasPendingQuestion).toBe(false);
    });

    it('jules_get_pending_question_EmptyActivities_ReturnsFalse', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockResolvedValue([]);

      // Act
      const result = await tools.jules_get_pending_question({ sessionId: 'abc123' });

      // Assert
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.hasPendingQuestion).toBe(false);
    });

    it('jules_get_pending_question_EmptySessionId_ReturnsError', async () => {
      // Act
      const result = await tools.jules_get_pending_question({ sessionId: '' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('jules_get_pending_question_ApiError_ReturnsError', async () => {
      // Arrange
      vi.mocked(mockClient.getActivities).mockRejectedValue(
        new Error('Session not found')
      );

      // Act
      const result = await tools.jules_get_pending_question({ sessionId: 'invalid' });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session not found');
    });
  });
});
