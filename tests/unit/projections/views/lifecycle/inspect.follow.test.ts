// Tests for the two `inspect --follow` carriers. `runInspectFollow` (CLI) and
// `tasksFollow` (MCP Tasks) share one core and one subscription contract. The
// delivery and disposal tests use a real `EventStore` subscription. The
// heartbeat tests and the property test use a fixture that the test drives.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { PassThrough } from 'node:stream';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { EventStore } from '../../../../../src/events/store.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import type { WorkflowEvent } from '../../../../../src/events/schemas.js';
import type {
  SubscribeOptions,
  SubscriptionClock,
  SubscriptionFilter,
  SubscriptionListener,
} from '../../../../../src/events/subscriptions.js';
import { NdjsonEncoder } from '../../../../../src/ndjson/encoder.js';
import { FrameSchema, type Frame } from '../../../../../src/ndjson/frames.js';
import {
  runInspectFollow,
  type FollowSubscribe,
} from '../../../../../src/cli/follow-loop.js';
import { tasksFollow } from '../../../../../src/mcp/tasks-methods.js';

/** Collect a PassThrough's bytes once ended. */
async function collect(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse an NDJSON buffer into validated frames. */
function parseFrames(raw: string): Frame[] {
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => FrameSchema.parse(JSON.parse(line) as unknown));
}

/** A synthetic WorkflowEvent fixture (owned — for the transform-only tests). */
function evt(sequence: number): WorkflowEvent {
  return {
    streamId: 'feat-x',
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    type: 'task.completed',
    schemaVersion: '1.0',
  } as WorkflowEvent;
}

/**
 * A clock that the test drives. `now()` returns a fixed time, so heartbeat timestamps are
 * deterministic. `scheduleInterval` records the tick, and `fireAll` runs it with no sleep.
 */
class ManualClock implements SubscriptionClock {
  readonly fixedNow: number;
  private readonly loops: Array<{ tick: () => void }> = [];
  constructor(fixedNow = 1_700_000_000_000) {
    this.fixedNow = fixedNow;
  }
  now(): number {
    return this.fixedNow;
  }
  scheduleInterval(tick: () => void): () => void {
    const entry = { tick };
    this.loops.push(entry);
    return () => {
      const i = this.loops.indexOf(entry);
      if (i >= 0) this.loops.splice(i, 1);
    };
  }
  /** Fire one tick on every live loop. */
  fireAll(): void {
    for (const { tick } of [...this.loops]) tick();
  }
  get loopCount(): number {
    return this.loops.length;
  }
}

/** A subscribe fixture that captures the listener, so a test delivers exact events. It records disposal. */
function capturingSubscribe(): {
  subscribe: FollowSubscribe;
  deliver(event: WorkflowEvent): void;
  disposed(): boolean;
} {
  let listener: SubscriptionListener | undefined;
  let disposed = false;
  const subscribe: FollowSubscribe = (_filter, onEvent) => {
    listener = onEvent;
    return {
      id: 'capturing',
      get disposed(): boolean {
        return disposed;
      },
      dispose(): void {
        disposed = true;
      },
      perf: () => ({ floorMs: 0, floorTicks: 0, floorDrains: 0 }),
    };
  };
  return {
    subscribe,
    deliver: (event) => listener?.(event),
    disposed: () => disposed,
  };
}

interface SpyCall {
  readonly filter: SubscriptionFilter;
  readonly options?: SubscribeOptions;
  disposeCount: number;
}

/** Wrap a real subscribe fn, recording each call's contract + dispose count. */
function spySubscribe(inner: FollowSubscribe): {
  subscribe: FollowSubscribe;
  calls: SpyCall[];
} {
  const calls: SpyCall[] = [];
  const subscribe: FollowSubscribe = (filter, onEvent, options) => {
    const rec: SpyCall = { filter, options, disposeCount: 0 };
    calls.push(rec);
    const h = inner(filter, onEvent, options);
    return {
      id: h.id,
      get disposed(): boolean {
        return h.disposed;
      },
      dispose(): void {
        rec.disposeCount++;
        h.dispose();
      },
      perf: () => h.perf(),
    };
  };
  return { subscribe, calls };
}

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'inspect-follow-'));
  store = new EventStore(tempDir);
  await store.initialize();
});

afterEach(async () => {
  store.disposeSubscriptions();
  await store.close?.();
  await rmrfAsync(tempDir);
});

/** The subscription contract of the fixture store. */
function realSubscribe(): FollowSubscribe {
  return (filter, onEvent, options) => store.subscribe(filter, onEvent, options);
}

async function seed(streamId: string, n: number): Promise<void> {
  await store.append(streamId, {
    type: 'workflow.started',
    data: { featureId: streamId, workflowType: 'feature' },
  });
  for (let i = 2; i <= n; i++) {
    await store.append(streamId, { type: 'workflow.transition', data: { to: `p${i}` } });
  }
}

describe('inspect --follow — CLI NDJSON carrier (DR-4)', () => {
  /**
   * The call passes no clock, so no heartbeat runs. The post-commit hook of the store delivers each
   * event during its append, so the test aborts with no wait.
   */
  it('InspectFollow_AppendedEvents_NdjsonFramesDedupedBySequence', async () => {
    const FEATURE = 'feat-ndjson';
    const sink = new PassThrough();
    const encoder = new NdjsonEncoder(sink);
    const controller = new AbortController();

    const handle = runInspectFollow({
      subscribe: realSubscribe(),
      featureId: FEATURE,
      fromSequence: 0,
      onFrame: (frame) => encoder.write(frame),
      signal: controller.signal,
    });

    await seed(FEATURE, 3);

    controller.abort();
    await handle.done;
    sink.end();

    const frames = parseFrames(await collect(sink));
    const eventFrames = frames.filter((f) => f.type === 'event');
    const seqs = eventFrames.map((f) => (f as { sequence: number }).sequence);

    expect(seqs).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(frames.at(-1)).toMatchObject({ type: 'end' });
  });

  /**
   * The heartbeat calls the sink of the caller inside a timer tick, where a throw becomes an
   * uncaught process error. The tick must catch the throw. After the event frame, the first tick
   * emits nothing, because the event counts as activity. The second tick emits a heartbeat.
   */
  it('InspectFollow_HeartbeatSinkThrows_ContainedAndLaterFramesStillFlow', async () => {
    const clock = new ManualClock();
    const src = capturingSubscribe();
    const frames: Frame[] = [];
    const controller = new AbortController();
    let failNextHeartbeat = true;

    const handle = runInspectFollow({
      subscribe: src.subscribe,
      featureId: 'feat-hb-throw',
      onFrame: (frame) => {
        if (frame.type === 'heartbeat' && failNextHeartbeat) throw new Error('sink boom');
        frames.push(frame);
      },
      signal: controller.signal,
      clock,
      heartbeatIntervalMs: 1000,
    });

    expect(() => clock.fireAll()).not.toThrow();
    expect(frames).toHaveLength(0);

    src.deliver(evt(1));
    expect(frames.map((f) => f.type)).toEqual(['event']);

    failNextHeartbeat = false;
    clock.fireAll();
    clock.fireAll();
    expect(frames.map((f) => f.type)).toEqual(['event', 'heartbeat']);

    controller.abort();
    await handle.done;
  });

  /**
   * A tick after an event emits nothing, so a heartbeat marks only an idle gap. Each heartbeat
   * timestamp comes from the injected clock. The abort cancels the heartbeat loop.
   */
  it('InspectFollow_SilentGap_HeartbeatFramesOnInjectedTimer', async () => {
    const clock = new ManualClock();
    const src = capturingSubscribe();
    const frames: Frame[] = [];
    const controller = new AbortController();

    const handle = runInspectFollow({
      subscribe: src.subscribe,
      featureId: 'feat-hb',
      onFrame: (frame) => frames.push(frame),
      signal: controller.signal,
      clock,
      heartbeatIntervalMs: 1000,
    });

    clock.fireAll();
    src.deliver(evt(1));
    clock.fireAll();
    clock.fireAll();

    const heartbeats = frames.filter((f) => f.type === 'heartbeat');
    expect(heartbeats).toHaveLength(2);
    const expectedTs = new Date(clock.fixedNow).toISOString();
    for (const hb of heartbeats) {
      expect((hb as { timestamp: string }).timestamp).toBe(expectedTs);
    }
    expect(frames.map((f) => f.type)).toEqual(['heartbeat', 'event', 'heartbeat']);

    controller.abort();
    await handle.done;
    expect(clock.loopCount).toBe(0);
  });

  /** The abort disposes the real store subscription. The test sends no process signal. */
  it('InspectFollow_Abort_SubscriptionDisposed', async () => {
    const spy = spySubscribe(realSubscribe());
    const controller = new AbortController();
    const handle = runInspectFollow({
      subscribe: spy.subscribe,
      featureId: 'feat-abort',
      fromSequence: 0,
      onFrame: () => {},
      signal: controller.signal,
    });

    expect(handle.disposed()).toBe(false);
    expect(spy.calls[0].disposeCount).toBe(0);

    controller.abort();
    await handle.done;

    expect(handle.disposed()).toBe(true);
    expect(spy.calls[0].disposeCount).toBe(1);
  });
});

describe('inspect --follow — MCP Tasks carrier (DR-4)', () => {
  /**
   * Both carriers receive one subscribe spy. Equal filters and options show that they use the same
   * subscription contract. `cancel` on the MCP handle disposes its subscription.
   */
  it('InspectFollow_McpTasks_SharesSubscriptionContract', async () => {
    const FEATURE = 'feat-shared';
    const spy = spySubscribe(realSubscribe());

    const cliFrames: Frame[] = [];
    const mcpFrames: Frame[] = [];
    const cliCtl = new AbortController();

    const cli = runInspectFollow({
      subscribe: spy.subscribe,
      featureId: FEATURE,
      fromSequence: 0,
      onFrame: (f) => cliFrames.push(f),
      signal: cliCtl.signal,
    });
    const mcp = tasksFollow({
      subscribe: spy.subscribe,
      featureId: FEATURE,
      fromSequence: 0,
      onFrame: (f) => mcpFrames.push(f),
    });

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].filter).toEqual({ streamId: FEATURE });
    expect(spy.calls[1].filter).toEqual({ streamId: FEATURE });
    expect(spy.calls[0].options).toEqual({ fromSequence: 0 });
    expect(spy.calls[1].options).toEqual({ fromSequence: 0 });

    await seed(FEATURE, 3);

    const cliSeqs = cliFrames.filter((f) => f.type === 'event').map((f) => (f as { sequence: number }).sequence);
    const mcpSeqs = mcpFrames.filter((f) => f.type === 'event').map((f) => (f as { sequence: number }).sequence);
    expect(cliSeqs).toEqual([1, 2, 3]);
    expect(mcpSeqs).toEqual(cliSeqs);

    expect(mcp.disposed()).toBe(false);
    mcp.cancel();
    await mcp.done;
    expect(mcp.disposed()).toBe(true);
    expect(spy.calls[1].disposeCount).toBe(1);

    cliCtl.abort();
    await cli.done;
    expect(spy.calls[0].disposeCount).toBe(1);
  });
});

describe('inspect --follow — dedup roundtrip property (DR-4)', () => {
  /**
   * The source delivers sequences with duplicates and in any order. The expected output holds
   * each sequence that is higher than every sequence before it.
   */
  it('InspectFollow_FrameStream_ContainsEachSequenceExactlyOnceMonotonic', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 0, maxLength: 30 }),
        (seqs) => {
          const src = capturingSubscribe();
          const frames: Frame[] = [];
          const controller = new AbortController();
          runInspectFollow({
            subscribe: src.subscribe,
            featureId: 'feat-prop',
            onFrame: (f) => frames.push(f),
            signal: controller.signal,
          });
          for (const s of seqs) src.deliver(evt(s));

          const out = frames
            .filter((f) => f.type === 'event')
            .map((f) => (f as { sequence: number }).sequence);

          const expected: number[] = [];
          let running = 0;
          for (const s of seqs) {
            if (s > running) {
              expected.push(s);
              running = s;
            }
          }
          expect(out).toEqual(expected);
          for (let i = 1; i < out.length; i++) {
            expect(out[i]).toBeGreaterThan(out[i - 1]);
          }
          const inputSet = new Set(seqs);
          for (const s of out) expect(inputSet.has(s)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
