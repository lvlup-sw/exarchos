import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { encodeFrame, NdjsonEncoder } from './encoder.js';
import { FrameSchema, type Frame } from './frames.js';

describe('NDJSON encoder (DR-9, T027)', () => {
  it('NdjsonEncoder_EncodeEvent_ProducesValidLine', () => {
    const frame: Frame = {
      type: 'event',
      event: { name: 'workflow.started', payload: { id: 'wf-1' } },
      sequence: 42,
    };

    const line = encodeFrame(frame);

    // One single line terminated by \n
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);

    // Round-trips via JSON.parse
    const parsed = JSON.parse(line.slice(0, -1)) as unknown;
    expect(parsed).toEqual(frame);
  });

  it('NdjsonEncoder_RoundTrip_PreservesAllEventTypes', async () => {
    const frames: Frame[] = [
      {
        type: 'event',
        event: { name: 'workflow.started', payload: { id: 'wf-1' } },
        sequence: 1,
      },
      {
        type: 'heartbeat',
        timestamp: '2026-04-24T10:00:00Z',
      },
      {
        type: 'end',
        reason: 'complete',
      },
      {
        type: 'error',
        code: 'EIO',
        message: 'disk full',
      },
    ];

    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));

    const encoder = new NdjsonEncoder(sink);
    for (const frame of frames) {
      encoder.write(frame);
    }
    encoder.end();

    // Wait for stream to finish flushing
    await new Promise<void>((resolve) => sink.on('end', () => resolve()));

    const output = Buffer.concat(chunks).toString('utf8');
    const lines = output.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(frames.length);

    const parsedFrames = lines.map((line) => {
      const obj = JSON.parse(line) as unknown;
      const result = FrameSchema.safeParse(obj);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      return result.data;
    });

    expect(parsedFrames).toEqual(frames);
  });
});
