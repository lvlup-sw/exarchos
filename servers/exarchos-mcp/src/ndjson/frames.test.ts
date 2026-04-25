import { describe, it, expect } from 'vitest';
import { FrameSchema } from './frames.js';

describe('NDJSON frame schema (DR-9)', () => {
  it('NdjsonFrame_DiscriminatedUnion_ParsesAllTypes', () => {
    const event = FrameSchema.safeParse({
      type: 'event',
      event: { foo: 'bar' },
      sequence: 1,
    });
    expect(event.success).toBe(true);

    const heartbeat = FrameSchema.safeParse({
      type: 'heartbeat',
      timestamp: '2026-04-24T10:00:00Z',
    });
    expect(heartbeat.success).toBe(true);

    const end = FrameSchema.safeParse({
      type: 'end',
      reason: 'complete',
    });
    expect(end.success).toBe(true);

    const error = FrameSchema.safeParse({
      type: 'error',
      code: 'EIO',
      message: 'disk full',
    });
    expect(error.success).toBe(true);

    const unknown = FrameSchema.safeParse({ type: 'unknown' });
    expect(unknown.success).toBe(false);
  });
});
