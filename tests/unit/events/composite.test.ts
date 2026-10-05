import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../src/format.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import { ChannelEmitter } from '../../../src/adapters/channel/emitter.js';

vi.mock('../../../src/events/tools.js', () => ({
  handleEventAppend: vi.fn().mockResolvedValue({
    success: true,
    data: { streamId: 'test', sequence: 1, type: 'test.event' },
  } satisfies ToolResult),
  handleEventQuery: vi.fn().mockResolvedValue({
    success: true,
    data: {
      events: [{ streamId: 'test', sequence: 1, type: 'test.event' }],
      page: { total: 1, offset: 0, limit: 20, hasMore: false },
    },
  } satisfies ToolResult),
  handleBatchAppend: vi.fn().mockResolvedValue({
    success: true,
    data: [
      { streamId: 'test', sequence: 1, type: 'task.completed' },
      { streamId: 'test', sequence: 2, type: 'task.progressed' },
    ],
  } satisfies ToolResult),
}));

import { handleEvent } from '../../../src/events/composite.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from '../../../src/events/tools.js';

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
    /** A successful response is an envelope, so it also carries an empty `next_actions`. */
    it('should delegate to handleEventAppend', async () => {
      const args = {
        action: 'append',
        stream: 'workflow-123',
        event: { type: 'task.assigned', data: { taskId: 't1' } },
        expectedSequence: 5,
        idempotencyKey: 'key-1',
      };

      const result = await handleEvent(args, ctx);

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
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ streamId: 'test', sequence: 1, type: 'test.event' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('query action', () => {
    /** A successful response is an envelope, so it also carries an empty `next_actions`. */
    it('should delegate to handleEventQuery', async () => {
      const args = {
        action: 'query',
        stream: 'workflow-123',
        filter: { type: 'task.assigned' },
        limit: 10,
        offset: 0,
        fields: ['type', 'data'],
      };

      const result = await handleEvent(args, ctx);

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
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        events: [{ streamId: 'test', sequence: 1, type: 'test.event' }],
        page: { total: 1, offset: 0, limit: 20, hasMore: false },
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const args = { action: 'delete' };

      const result = await handleEvent(args, ctx);

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

/**
 * Asserts the envelope shape that `handleEvent` returns for a successful action:
 * `success`, `data`, an empty `next_actions`, an object `_meta`, and a numeric `_perf.ms`.
 * The file mocks the handlers, so the envelope suite checks only the wrap at the tool boundary.
 * An event response carries no workflow state, so `next_actions` is empty.
 */
function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  expect(typeof env.success).toBe('boolean');

  expect(Object.hasOwn(env, 'data')).toBe(true);

  expect(Array.isArray(env.next_actions)).toBe(true);
  expect((env.next_actions as unknown[]).length).toBe(0);

  expect(env._meta).toBeTypeOf('object');
  expect(env._meta).not.toBeNull();

  expect(env._perf).toBeTypeOf('object');
  expect(env._perf).not.toBeNull();
  const perf = env._perf as Record<string, unknown>;
  expect(typeof perf.ms).toBe('number');
}

describe('EventToolResponses_AllActions_ReturnEnvelope (T037, DR-7)', () => {
  const stateDir = '/tmp/test-event-envelope-state';
  const ctx = makeCtx(stateDir);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('append action returns Envelope', async () => {
    const result = await handleEvent(
      {
        action: 'append',
        stream: 'envelope-wf',
        event: { type: 'task.completed', data: {} },
      },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('query action returns Envelope', async () => {
    const result = await handleEvent(
      { action: 'query', stream: 'envelope-wf' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('batch_append action returns Envelope', async () => {
    const result = await handleEvent(
      {
        action: 'batch_append',
        stream: 'envelope-wf',
        events: [
          { type: 'task.completed', data: {} },
          { type: 'task.progressed', data: {} },
        ],
      },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('describe action returns Envelope', async () => {
    const result = await handleEvent(
      { action: 'describe', actions: ['append'] },
      ctx,
    );
    assertEnvelopeShape(result);
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

  /** `task.progressed` is not in the priority map, so its priority is `info`, which is below the default `success` threshold. */
  it('does not push info-level events (below default threshold)', async () => {
    const mockServer = { notification: vi.fn().mockResolvedValue(undefined) };
    const emitter = new ChannelEmitter(mockServer);
    const ctx: DispatchContext = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
      channelEmitter: emitter,
    };

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

  /** Only `task.completed` reaches the threshold. `task.progressed` has the `info` priority. */
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

    expect(result.success).toBe(true);
  });
});
