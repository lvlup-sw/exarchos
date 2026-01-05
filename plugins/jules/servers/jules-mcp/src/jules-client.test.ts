import { describe, it, expect, vi } from 'vitest';
import { JulesClient } from './jules-client.js';
import {
  mockSource,
  mockPrivateSource,
  mockSession,
  mockSessionAwaitingApproval,
  mockSessionCompleted,
  mockActivityPlanning,
  mockActivityCoding,
  mockErrorUnauthorized,
  mockErrorNotFound,
  mockErrorBadRequest,
  mockErrorSourceNotFound
} from './test/fixtures.js';

const BASE_URL = 'https://jules.googleapis.com/v1alpha';

describe('JulesClient', () => {
  const apiKey = 'test-api-key';

  // ==========================================================================
  // listSources() Tests
  // ==========================================================================
  describe('listSources', () => {
    it('should return list of connected repositories', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({ sources: [mockSource] }));
      const client = new JulesClient(apiKey);

      // Act
      const sources = await client.listSources();

      // Assert
      expect(sources).toHaveLength(1);
      expect(sources[0].name).toBe('sources/github/lvlup-sw/test-repo');
      expect(sources[0].githubRepo.owner).toBe('lvlup-sw');
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sources`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Goog-Api-Key': apiKey
          })
        })
      );
    });

    it('should return multiple sources when available', async () => {
      // Arrange
      fetchMock.mockResponseOnce(
        JSON.stringify({ sources: [mockSource, mockPrivateSource] })
      );
      const client = new JulesClient(apiKey);

      // Act
      const sources = await client.listSources();

      // Assert
      expect(sources).toHaveLength(2);
      expect(sources[1].githubRepo.isPrivate).toBe(true);
    });

    it('should return empty array when no sources connected', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({ sources: [] }));
      const client = new JulesClient(apiKey);

      // Act
      const sources = await client.listSources();

      // Assert
      expect(sources).toHaveLength(0);
    });

    it('should throw error when API returns unauthorized', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorUnauthorized), {
        status: 401
      });
      const client = new JulesClient('invalid-key');

      // Act & Assert
      await expect(client.listSources()).rejects.toThrow('Invalid API key');
    });

    it('should throw error when network fails', async () => {
      // Arrange
      fetchMock.mockRejectOnce(new Error('Network error'));
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.listSources()).rejects.toThrow('Network error');
    });
  });

  // ==========================================================================
  // createSession() Tests
  // ==========================================================================
  describe('createSession', () => {
    it('should create session with required parameters', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockSession));
      const client = new JulesClient(apiKey);
      const params = {
        prompt: 'Add user profile feature with TDD',
        sourceContext: { source: 'sources/github/lvlup-sw/test-repo' }
      };

      // Act
      const session = await client.createSession(params);

      // Assert
      expect(session.id).toBe('abc123');
      expect(session.state).toBe('QUEUED');
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Add user profile feature')
        })
      );
    });

    it('should create session with all optional parameters', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockSession));
      const client = new JulesClient(apiKey);
      const params = {
        prompt: 'Add user profile feature',
        sourceContext: {
          source: 'sources/github/lvlup-sw/test-repo',
          githubRepoContext: { startingBranch: 'develop' }
        },
        title: 'User Profile Feature',
        requirePlanApproval: true,
        automationMode: 'AUTO_CREATE_PR' as const
      };

      // Act
      await client.createSession(params);

      // Assert
      const requestBody = JSON.parse(
        fetchMock.mock.calls[0][1]?.body as string
      );
      expect(requestBody.sourceContext.githubRepoContext.startingBranch).toBe(
        'develop'
      );
      expect(requestBody.title).toBe('User Profile Feature');
      expect(requestBody.requirePlanApproval).toBe(true);
      expect(requestBody.automationMode).toBe('AUTO_CREATE_PR');
    });

    it('should throw error when prompt is empty', async () => {
      // Arrange
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(
        client.createSession({
          prompt: '',
          sourceContext: { source: 'sources/github/lvlup-sw/test-repo' }
        })
      ).rejects.toThrow('Prompt cannot be empty');
    });

    it('should throw error when prompt is only whitespace', async () => {
      // Arrange
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(
        client.createSession({
          prompt: '   ',
          sourceContext: { source: 'sources/github/lvlup-sw/test-repo' }
        })
      ).rejects.toThrow('Prompt cannot be empty');
    });

    it('should throw error when source not found', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorSourceNotFound), {
        status: 404
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(
        client.createSession({
          prompt: 'Test task',
          sourceContext: { source: 'sources/invalid-repo' }
        })
      ).rejects.toThrow('Source not found');
    });
  });

  // ==========================================================================
  // getSession() Tests
  // ==========================================================================
  describe('getSession', () => {
    it('should return session by ID', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockSessionAwaitingApproval));
      const client = new JulesClient(apiKey);

      // Act
      const session = await client.getSession('abc123');

      // Assert
      expect(session.id).toBe('abc123');
      expect(session.state).toBe('AWAITING_PLAN_APPROVAL');
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123`,
        expect.any(Object)
      );
    });

    it('should return session with PR output when completed', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockSessionCompleted));
      const client = new JulesClient(apiKey);

      // Act
      const session = await client.getSession('abc123');

      // Assert
      expect(session.state).toBe('COMPLETED');
      expect(session.outputs).toHaveLength(1);
      expect(session.outputs![0].url).toContain('github.com');
    });

    it('should normalize session ID with sessions/ prefix', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockSession));
      const client = new JulesClient(apiKey);

      // Act
      await client.getSession('sessions/abc123');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123`,
        expect.any(Object)
      );
    });

    it('should throw error when session not found', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorNotFound), {
        status: 404
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.getSession('invalid-id')).rejects.toThrow(
        'Session not found'
      );
    });
  });

  // ==========================================================================
  // listSessions() Tests
  // ==========================================================================
  describe('listSessions', () => {
    it('should return list of sessions', async () => {
      // Arrange
      fetchMock.mockResponseOnce(
        JSON.stringify({ sessions: [mockSession, mockSessionCompleted] })
      );
      const client = new JulesClient(apiKey);

      // Act
      const sessions = await client.listSessions();

      // Assert
      expect(sessions).toHaveLength(2);
      expect(sessions[0].state).toBe('QUEUED');
      expect(sessions[1].state).toBe('COMPLETED');
    });

    it('should return empty array when no sessions exist', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({ sessions: [] }));
      const client = new JulesClient(apiKey);

      // Act
      const sessions = await client.listSessions();

      // Assert
      expect(sessions).toHaveLength(0);
    });
  });

  // ==========================================================================
  // approvePlan() Tests
  // ==========================================================================
  describe('approvePlan', () => {
    it('should approve pending plan successfully', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({}));
      const client = new JulesClient(apiKey);

      // Act
      await client.approvePlan('abc123');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123:approvePlan`,
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should normalize session ID with prefix', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({}));
      const client = new JulesClient(apiKey);

      // Act
      await client.approvePlan('sessions/abc123');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123:approvePlan`,
        expect.any(Object)
      );
    });

    it('should throw error when session not in correct state', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorBadRequest), {
        status: 400
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.approvePlan('abc123')).rejects.toThrow(
        'Session not awaiting plan approval'
      );
    });

    it('should throw error when session not found', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorNotFound), {
        status: 404
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.approvePlan('invalid-id')).rejects.toThrow(
        'Session not found'
      );
    });
  });

  // ==========================================================================
  // sendMessage() Tests
  // ==========================================================================
  describe('sendMessage', () => {
    it('should send message to session successfully', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({}));
      const client = new JulesClient(apiKey);

      // Act
      await client.sendMessage('abc123', 'Please add more tests');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123:sendMessage`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ prompt: 'Please add more tests' })
        })
      );
    });

    it('should throw error when message is empty', async () => {
      // Arrange
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.sendMessage('abc123', '')).rejects.toThrow(
        'Message cannot be empty'
      );
    });

    it('should throw error when message is only whitespace', async () => {
      // Arrange
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.sendMessage('abc123', '   ')).rejects.toThrow(
        'Message cannot be empty'
      );
    });

    it('should throw error when session not found', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorNotFound), {
        status: 404
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(
        client.sendMessage('invalid-id', 'Test message')
      ).rejects.toThrow('Session not found');
    });
  });

  // ==========================================================================
  // getActivities() Tests
  // ==========================================================================
  describe('getActivities', () => {
    it('should return activities for session', async () => {
      // Arrange
      fetchMock.mockResponseOnce(
        JSON.stringify({
          activities: [mockActivityPlanning, mockActivityCoding]
        })
      );
      const client = new JulesClient(apiKey);

      // Act
      const activities = await client.getActivities('abc123');

      // Assert
      expect(activities).toHaveLength(2);
      expect(activities[0].originator).toBe('agent');
      expect(activities[0].description).toBe('Analyzing codebase structure');
      expect(activities[1].originator).toBe('agent');
      expect(activities[1].description).toBe('Implementing UserProfile entity');
    });

    it('should return empty array when no activities', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({ activities: [] }));
      const client = new JulesClient(apiKey);

      // Act
      const activities = await client.getActivities('abc123');

      // Assert
      expect(activities).toHaveLength(0);
    });

    it('should throw error when session not found', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorNotFound), {
        status: 404
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.getActivities('invalid-id')).rejects.toThrow(
        'Session not found'
      );
    });
  });

  // ==========================================================================
  // deleteSession() Tests
  // ==========================================================================
  describe('deleteSession', () => {
    it('should delete/cancel session successfully', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({}));
      const client = new JulesClient(apiKey);

      // Act
      await client.deleteSession('abc123');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should normalize session ID with prefix', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify({}));
      const client = new JulesClient(apiKey);

      // Act
      await client.deleteSession('sessions/abc123');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/abc123`,
        expect.any(Object)
      );
    });

    it('should throw error when session not found', async () => {
      // Arrange
      fetchMock.mockResponseOnce(JSON.stringify(mockErrorNotFound), {
        status: 404
      });
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.deleteSession('invalid-id')).rejects.toThrow(
        'Session not found'
      );
    });

    it('should throw error when session already completed', async () => {
      // Arrange
      fetchMock.mockResponseOnce(
        JSON.stringify({
          error: {
            code: 400,
            message: 'Cannot delete completed session',
            status: 'FAILED_PRECONDITION'
          }
        }),
        { status: 400 }
      );
      const client = new JulesClient(apiKey);

      // Act & Assert
      await expect(client.deleteSession('completed-session')).rejects.toThrow(
        'Cannot delete completed session'
      );
    });
  });
});
