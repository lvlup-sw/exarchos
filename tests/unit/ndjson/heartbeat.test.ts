import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { NdjsonEncoder } from '../../../src/ndjson/encoder.js';
import { FrameSchema } from '../../../src/ndjson/frames.js';
import { startHeartbeat } from '../../../src/ndjson/heartbeat.js';

/** Parses the captured NDJSON bytes into validated frames. */
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

  /** A third heartbeat must not arrive 1 ms before the third interval ends. */
  it('NdjsonHeartbeat_IdleStream_EmitsEvery30s', () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));

    const encoder = new NdjsonEncoder(sink);
    const cancel = startHeartbeat(encoder);

    try {
      expect(drainFrames(chunks).length).toBe(0);

      vi.advanceTimersByTime(30_000);
      let frames = drainFrames(chunks);
      expect(frames.length).toBe(1);
      expect(frames[0]?.type).toBe('heartbeat');

      vi.advanceTimersByTime(30_000);
      frames = drainFrames(chunks);
      expect(frames.length).toBe(2);
      expect(frames.every((f) => f.type === 'heartbeat')).toBe(true);

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

    vi.advanceTimersByTime(30_000);
    expect(drainFrames(chunks).length).toBe(1);

    cancel();

    vi.advanceTimersByTime(120_000);
    expect(drainFrames(chunks).length).toBe(1);
  });
});
