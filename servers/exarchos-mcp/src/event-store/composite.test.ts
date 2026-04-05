import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from './store.js';
import { ChannelEmitter } from '../channel/emitter.js';

vi.mock('./tools.js', () => ({
  handleEventAppend: vi.fn().mockResolvedValue({
    success: true,
    data: { streamId: 'test', sequence: 1, type: 'test.event' },
  } satisfies ToolResult),
  handleEventQuery: vi.fn().mockResolvedValue({
    success: true,
    data: [{ streamId: 'test', sequence: 1, type: 'test.event' }],
  } satisfies ToolResult),
  handleBatchAppend: vi.fn().mockResolvedValue({
    success: true,
    data: [
      { streamId: 'test', sequence: 1, type: 'task.completed' },
      { streamId: 'test', sequence: 2, type: 'task.progressed' },
    ],
  } satisfies ToolResult),
}));

import { handleEvent } from './composite.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

describe('handleEvent', () => {
  const stateDir = '/tmp/test-state';
  const ctx = makeCtx(stateDir);

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
      const result = await handleEvent(args, ctx);

      // Assert
      expect(handleEventAppend).toHaveBeenCalledWith(
        {
          stream: 'workflow-123',
          event: { type: 'task.assigned', data: { taskId: 't1' } },
          expectedSequence: 5,
          idempotencyKey: 'key-1',
        },
        stateDir,
        ctx.eventStore,
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
      const result = await handleEvent(args, ctx);

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
        ctx.eventStore,
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
      const result = await handleEvent(args, ctx);

      // Assert
      expect(result).toEqual({
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: 'Unknown action: delete. Valid actions: append, query, batch_append, describe',
        },
      });
      expect(handleEventAppend).not.toHaveBeenCalled();
      expect(handleEventQuery).not.toHaveBeenCalled();
    });
  });
});

describe('handleEvent channel integration', () => {
  const stateDir = '/tmp/test-channel';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes qualifying event to channelEmitter after successful append', async () => {
    const mockServer = { notification: vi.fn().mockResolvedValue(undefined) };
    const emitter = new ChannelEmitter(mockServer);
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
      channelEmitter: emitter,
    };

    await handleEvent(
      { action: 'append', stream: 'test-wf', event: { type: 'task.completed', data: {} } },
      ctx,
    );

    expect(mockServer.notification).toHaveBeenCalledTimes(1);
    expect(mockServer.notification).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'notifications/claude/channel' }),
    );
  });

  it('does not push info-level events (below default threshold)', async () => {
    const mockServer = { notification: vi.fn().mockResolvedValue(undefined) };
    const emitter = new ChannelEmitter(mockServer);
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
      channelEmitter: emitter,
    };

    // task.progressed is not in the priority map, so it defaults to 'info'
    // which is below the default 'success' threshold
    await handleEvent(
      { action: 'append', stream: 'test-wf', event: { type: 'task.progressed', data: {} } },
      ctx,
    );

    expect(mockServer.notification).not.toHaveBeenCalled();
  });

  it('does not fail when channelEmitter is not configured', async () => {
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
    };

    const result = await handleEvent(
      { action: 'append', stream: 'test-wf', event: { type: 'task.completed', data: {} } },
      ctx,
    );

    expect(result.success).toBe(true);
  });

  it('pushes channel notifications for qualifying events in batch_append', async () => {
    const mockServer = { notification: vi.fn().mockResolvedValue(undefined) };
    const emitter = new ChannelEmitter(mockServer);
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
      channelEmitter: emitter,
    };

    await handleEvent(
      {
        action: 'batch_append',
        stream: 'test-wf',
        events: [
          { type: 'task.completed', data: {} },
          { type: 'task.progressed', data: {} },
        ],
      },
      ctx,
    );

    // Only task.completed qualifies (success level); task.progressed is info (below threshold)
    expect(mockServer.notification).toHaveBeenCalledTimes(1);
    expect(mockServer.notification).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'notifications/claude/channel' }),
    );
  });

  it('does not propagate channelEmitter errors to caller', async () => {
    const mockServer = { notification: vi.fn().mockRejectedValue(new Error('channel down')) };
    const emitter = new ChannelEmitter(mockServer);
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
      channelEmitter: emitter,
    };

    const result = await handleEvent(
      { action: 'append', stream: 'test-wf', event: { type: 'task.completed', data: {} } },
      ctx,
    );

    // The event append itself should still succeed
    expect(result.success).toBe(true);
  });
});
