import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

vi.mock('./tools.js', () => ({
  handleEventAppend: vi.fn().mockResolvedValue({
    success: true,
    data: { streamId: 'test', sequence: 1, type: 'test.event' },
  } satisfies ToolResult),
  handleEventQuery: vi.fn().mockResolvedValue({
    success: true,
    data: [{ streamId: 'test', sequence: 1, type: 'test.event' }],
  } satisfies ToolResult),
}));

import { handleEvent } from './composite.js';
import { handleEventAppend, handleEventQuery } from './tools.js';

describe('handleEvent', () => {
  const stateDir = '/tmp/test-state';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('append action', () => {
    it('should delegate to handleEventAppend', async () => {
      // Arrange
      const args = {
        action: 'append',
        stream: 'workflow-123',
        event: { type: 'task.assigned', data: { taskId: 't1' } },
        expectedSequence: 5,
        idempotencyKey: 'key-1',
      };

      // Act
      const result = await handleEvent(args, stateDir);

      // Assert
      expect(handleEventAppend).toHaveBeenCalledWith(
        {
          stream: 'workflow-123',
          event: { type: 'task.assigned', data: { taskId: 't1' } },
          expectedSequence: 5,
          idempotencyKey: 'key-1',
        },
        stateDir,
      );
      expect(result).toEqual({
        success: true,
        data: { streamId: 'test', sequence: 1, type: 'test.event' },
      });
    });
  });

  describe('query action', () => {
    it('should delegate to handleEventQuery', async () => {
      // Arrange
      const args = {
        action: 'query',
        stream: 'workflow-123',
        filter: { type: 'task.assigned' },
        limit: 10,
        offset: 0,
        fields: ['type', 'data'],
      };

      // Act
      const result = await handleEvent(args, stateDir);

      // Assert
      expect(handleEventQuery).toHaveBeenCalledWith(
        {
          stream: 'workflow-123',
          filter: { type: 'task.assigned' },
          limit: 10,
          offset: 0,
          fields: ['type', 'data'],
        },
        stateDir,
      );
      expect(result).toEqual({
        success: true,
        data: [{ streamId: 'test', sequence: 1, type: 'test.event' }],
      });
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      // Arrange
      const args = { action: 'delete' };

      // Act
      const result = await handleEvent(args, stateDir);

      // Assert
      expect(result).toEqual({
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: 'Unknown action: delete. Valid actions: append, query',
        },
      });
      expect(handleEventAppend).not.toHaveBeenCalled();
      expect(handleEventQuery).not.toHaveBeenCalled();
    });
  });
});
