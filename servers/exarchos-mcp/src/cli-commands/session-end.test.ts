import { describe, it, expect } from 'vitest';
import { handleSessionEnd } from './session-end.js';
import { routeCommand } from '../cli.js';

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('session-end command', () => {
  describe('handleSessionEnd', () => {
    it('handleSessionEnd_ValidStdin_ReturnsSuccess', async () => {
      // Arrange
      const stdinData = {
        session_id: 'abc',
        transcript_path: '/tmp/test.jsonl',
      };

      // Act
      const result = await handleSessionEnd(stdinData, '/tmp/state');

      // Assert
      expect(result).toEqual({ continue: true });
    });

    it('handleSessionEnd_MissingSessionId_ReturnsError', async () => {
      // Arrange
      const stdinData = {
        transcript_path: '/tmp/test.jsonl',
      };

      // Act
      const result = await handleSessionEnd(stdinData, '/tmp/state');

      // Assert
      expect(result).toEqual({
        error: {
          code: 'MISSING_SESSION_ID',
          message: 'session_id is required',
        },
      });
    });

    it('handleSessionEnd_MissingTranscriptPath_ReturnsError', async () => {
      // Arrange
      const stdinData = {
        session_id: 'abc',
      };

      // Act
      const result = await handleSessionEnd(stdinData, '/tmp/state');

      // Assert
      expect(result).toEqual({
        error: {
          code: 'MISSING_TRANSCRIPT_PATH',
          message: 'transcript_path is required',
        },
      });
    });

    it('handleSessionEnd_EmptyStdin_ReturnsError', async () => {
      // Arrange
      const stdinData = {};

      // Act
      const result = await handleSessionEnd(stdinData, '/tmp/state');

      // Assert
      expect(result).toHaveProperty('error');
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('MISSING_SESSION_ID');
    });

    it('handleSessionEnd_NonStringSessionId_ReturnsError', async () => {
      // Arrange
      const stdinData = {
        session_id: 123,
        transcript_path: '/tmp/test.jsonl',
      };

      // Act
      const result = await handleSessionEnd(stdinData, '/tmp/state');

      // Assert
      expect(result).toEqual({
        error: {
          code: 'MISSING_SESSION_ID',
          message: 'session_id is required',
        },
      });
    });

    it('handleSessionEnd_NonStringTranscriptPath_ReturnsError', async () => {
      // Arrange
      const stdinData = {
        session_id: 'abc',
        transcript_path: 42,
      };

      // Act
      const result = await handleSessionEnd(stdinData, '/tmp/state');

      // Assert
      expect(result).toEqual({
        error: {
          code: 'MISSING_TRANSCRIPT_PATH',
          message: 'transcript_path is required',
        },
      });
    });
  });

  describe('routeCommand integration', () => {
    it('routeCommand_SessionEnd_CallsSessionEndHandler', async () => {
      // Arrange
      const stdinData = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript.jsonl',
      };

      // Act
      const result = await routeCommand('session-end', stdinData);

      // Assert
      expect(result).toEqual({ continue: true });
    });

    it('routeCommand_SessionEnd_WithMissingData_ReturnsError', async () => {
      // Act
      const result = await routeCommand('session-end', {});

      // Assert
      expect(result).toHaveProperty('error');
      expect(result.error?.code).toBe('MISSING_SESSION_ID');
    });
  });
});
