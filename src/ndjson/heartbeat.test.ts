import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { NdjsonEncoder } from './encoder.js';
import { FrameSchema } from './frames.js';
import { startHeartbeat } from './heartbeat.js';

/**
 * Parse NDJSON bytes captured from a PassThrough into validated frames.
 *
 * Heartbeat writes arrive synchronously on the same tick as `encoder.write()`,
 * but the PassThrough delivers them through the event loop. Flushing is done
 * by awaiting a microtask after advancing fake timers.
 */
function drainFrames(chunks: Buffer[]): ReturnType<typeof FrameSchema.parse>[] {
  const output = Buffer.concat(chunks).toString('utf8');
  const lines = output.split('\n').filter((l) => l.length > 0);
  return lines.map((line) => FrameSchema.parse(JSON.parse(line) as unknown));
}

describe('NDJSON heartbeat (DR-9, T028)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('NdjsonHeartbeat_IdleStream_EmitsEvery30s', () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));

    const encoder = new NdjsonEncoder(sink);
    const cancel = startHeartbeat(encoder);

    try {
      // No frames yet.
      expect(drainFrames(chunks).length).toBe(0);

      // Advance 30s → exactly 1 heartbeat.
      vi.advanceTimersByTime(30_000);
      let frames = drainFrames(chunks);
      expect(frames.length).toBe(1);
      expect(frames[0]?.type).toBe('heartbeat');

      // Advance another 30s → total 2 heartbeats.
      vi.advanceTimersByTime(30_000);
      frames = drainFrames(chunks);
      expect(frames.length).toBe(2);
      expect(frames.every((f) => f.type === 'heartbeat')).toBe(true);

      // Advance 29_999ms more → still 2 (interval not yet reached).
      vi.advanceTimersByTime(29_999);
      frames = drainFrames(chunks);
      expect(frames.length).toBe(2);
    } finally {
      cancel();
    }
  });

  it('NdjsonHeartbeat_Cancel_StopsEmission', () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));

    const encoder = new NdjsonEncoder(sink);
    const cancel = startHeartbeat(encoder);

    // Emit 1 heartbeat, then cancel.
    vi.advanceTimersByTime(30_000);
    expect(drainFrames(chunks).length).toBe(1);

    cancel();

    // Advance well past multiple intervals — no new frames.
    vi.advanceTimersByTime(120_000);
    expect(drainFrames(chunks).length).toBe(1);
  });
});
