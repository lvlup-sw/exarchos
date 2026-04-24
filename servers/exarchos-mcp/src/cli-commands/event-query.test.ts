import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { FrameSchema, type Frame } from '../ndjson/frames.js';
import { runEventQueryFollow } from './event-query.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Collect stream bytes into a buffer. Resolves when the stream ends. */
async function collect(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse an NDJSON buffer into an array of validated frames. */
function parseFrames(raw: string): Frame[] {
  const lines = raw.split('\n').filter((line) => line.length > 0);
  return lines.map((line) => FrameSchema.parse(JSON.parse(line) as unknown));
}

/** Build a synthetic WorkflowEvent for test input. */
function makeEvent(sequence: number): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    type: 'task.completed',
    schemaVersion: '1.0',
    data: { taskId: `t${sequence}` },
  };
}

/**
 * Build a controllable async event source. Tests push events/close/error
 * signals and the handler consumes them as an async iterable.
 */
interface Controller {
  push(event: WorkflowEvent): void;
  close(): void;
  fail(err: Error): void;
  source: AsyncIterable<WorkflowEvent>;
}

function makeSource(): Controller {
  // Queue of pending events; resolvers wait on pull.
  const queue: WorkflowEvent[] = [];
  const pending: Array<{
    resolve: (r: IteratorResult<WorkflowEvent>) => void;
    reject: (err: Error) => void;
  }> = [];
  let closed = false;
  let failure: Error | null = null;

  function drainToResolver(): void {
    while (pending.length > 0 && (queue.length > 0 || closed || failure)) {
      const waiter = pending.shift()!;
      if (failure !== null) {
        waiter.reject(failure);
        continue;
      }
      if (queue.length > 0) {
        waiter.resolve({ value: queue.shift()!, done: false });
        continue;
      }
      waiter.resolve({ value: undefined, done: true });
    }
  }

  const iterable: AsyncIterable<WorkflowEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
      return {
        next(): Promise<IteratorResult<WorkflowEvent>> {
          if (failure !== null) return Promise.reject(failure);
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
          });
        },
      };
    },
  };

  return {
    push(event: WorkflowEvent): void {
      queue.push(event);
      drainToResolver();
    },
    close(): void {
      closed = true;
      drainToResolver();
    },
    fail(err: Error): void {
      failure = err;
      drainToResolver();
    },
    source: iterable,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('event query --follow (T042, DR-9)', () => {
  beforeEach(() => {
    // Avoid real timers leaking across tests.
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('EventQueryCli_WithFollow_EmitsOneLinePerEvent', async () => {
    const sink = new PassThrough();
    const controller = makeSource();

    const run = runEventQueryFollow({
      source: controller.source,
      sink,
      heartbeatIntervalMs: 60_000, // long enough that no heartbeat fires in this test
    });

    controller.push(makeEvent(1));
    controller.push(makeEvent(2));
    controller.push(makeEvent(3));
    controller.close();

    await run;
    const raw = await collect(sink);
    const frames = parseFrames(raw);

    // 3 event frames followed by 1 end frame
    const eventFrames = frames.filter((f) => f.type === 'event');
    expect(eventFrames).toHaveLength(3);
    for (const frame of eventFrames) {
      expect(frame.type).toBe('event');
    }
  });

  it('EventQueryCli_StreamClose_EmitsEndFrame', async () => {
    const sink = new PassThrough();
    const controller = makeSource();

    const run = runEventQueryFollow({
      source: controller.source,
      sink,
      heartbeatIntervalMs: 60_000,
    });

    controller.push(makeEvent(1));
    controller.close();

    await run;
    const raw = await collect(sink);
    const frames = parseFrames(raw);

    // The last frame must be an `end` frame — written after all events.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const last = frames[frames.length - 1];
    expect(last.type).toBe('end');
  });

  it('EventQueryCli_IdleFollow_EmitsHeartbeat', async () => {
    vi.useFakeTimers();
    const sink = new PassThrough();
    const controller = makeSource();

    const run = runEventQueryFollow({
      source: controller.source,
      sink,
      heartbeatIntervalMs: 30_000,
    });

    // Yield to event loop so the heartbeat timer is armed, then advance 30s.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    controller.close();

    // Flush any pending microtasks so the `end` frame lands.
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    await run;
    const raw = await collect(sink);
    const frames = parseFrames(raw);

    const heartbeats = frames.filter((f) => f.type === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
  });
});
