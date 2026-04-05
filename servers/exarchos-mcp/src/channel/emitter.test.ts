import { describe, it, expect, vi } from 'vitest';
import { ChannelEmitter } from './emitter.js';

// Minimal mock of MCP Server's notification method
function createMockServer() {
  return {
    notification: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ChannelEmitter', () => {
  it('push calls server notification for events meeting threshold', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never);

    await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'success',
    );

    expect(server.notification).toHaveBeenCalledTimes(1);
    expect(server.notification).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'notifications/claude/channel',
        params: expect.objectContaining({
          content: expect.any(String),
          meta: expect.objectContaining({ type: 'task.completed' }),
        }),
      }),
    );
  });

  it('push does NOT call server notification for events below threshold', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never);

    await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'task.progressed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'info',
    );

    expect(server.notification).not.toHaveBeenCalled();
  });

  it('push does not throw when server.notification rejects', async () => {
    const server = createMockServer();
    server.notification.mockRejectedValue(new Error('not connected'));
    const emitter = new ChannelEmitter(server as never);

    // Should not throw
    await expect(
      emitter.push(
        { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
        'success',
      ),
    ).resolves.not.toThrow();
  });

  it('respects custom threshold option', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never, { threshold: 'warning' });

    await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'success',
    );

    // success < warning threshold, so should NOT push
    expect(server.notification).not.toHaveBeenCalled();
  });

  it('pushes when priority equals custom threshold', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never, { threshold: 'warning' });

    await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'task.failed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'warning',
    );

    expect(server.notification).toHaveBeenCalledTimes(1);
  });
});
