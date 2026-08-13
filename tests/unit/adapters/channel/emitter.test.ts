import { describe, it, expect, vi } from 'vitest';
import { ChannelEmitter } from '../../../../src/adapters/channel/emitter.js';
import { RequiredDeliveryError } from '../../../../src/adapters/channel/delivery.js';

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

  it('push does not throw when server.notification rejects, and reports a failed outcome', async () => {
    const server = createMockServer();
    const cause = new Error('not connected');
    server.notification.mockRejectedValue(cause);
    const emitter = new ChannelEmitter(server as never);

    // Best-effort push resolves (never throws) — but the failure is OBSERVABLE
    // as a typed carrier, not swallowed by an empty catch.
    const outcome = await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'success',
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.cause).toBe(cause);
    }
  });

  it('push returns a delivered outcome on success', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never);
    const outcome = await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'success',
    );
    expect(outcome.kind).toBe('delivered');
  });

  it('push returns a skipped outcome (not delivered) when below threshold', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never);
    const outcome = await emitter.push(
      { streamId: 'wf-1', sequence: 1, type: 'x', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'info',
    );
    expect(outcome.kind).toBe('skipped');
    expect(server.notification).not.toHaveBeenCalled();
  });

  it('pushRequired REJECTS with a typed RequiredDeliveryError when transport fails', async () => {
    const server = createMockServer();
    server.notification.mockRejectedValue(new Error('sink down'));
    const emitter = new ChannelEmitter(server as never);

    await expect(
      emitter.pushRequired(
        { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
        'success',
      ),
    ).rejects.toBeInstanceOf(RequiredDeliveryError);
  });

  it('pushRequired resolves to delivered when transport succeeds', async () => {
    const server = createMockServer();
    const emitter = new ChannelEmitter(server as never);
    const outcome = await emitter.pushRequired(
      { streamId: 'wf-1', sequence: 1, type: 'task.completed', data: {}, timestamp: '2026-04-05T00:00:00Z' },
      'success',
    );
    expect(outcome.kind).toBe('delivered');
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
