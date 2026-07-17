// ─── Tests for the `inspect --follow` streaming carriers (DR-4, task-009) ─────
//
// Two carriers stream a live workflow tail over the ONE DR-1 cursor-pump
// subscription:
//   • CLI (NDJSON)  — `runInspectFollow` frames each delivered event as an
//     NDJSON `event` frame, deduped by sequence, with heartbeat frames on
//     silence driven by an INJECTED timer (INV-16 — no wall-clock).
//   • MCP (Tasks)   — `tasksFollow` drives the SAME core over the SAME
//     subscription contract; `tasks/cancel` → subscription dispose.
//
// Boundary discipline: the named cases drive a REAL `EventStore` subscription
// and observe disposal on the real handle. The dedup roundtrip property test
// exercises the pure frame transform against an adversarial (owned) source
// fixture — the killable heart of the by-sequence dedup guarantee.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { PassThrough } from 'node:stream';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { EventStore } from '../../event-store/store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type {
  SubscribeOptions,
  SubscriptionClock,
  SubscriptionFilter,
  SubscriptionListener,
} from '../../event-store/subscriptions.js';
import { NdjsonEncoder } from '../../ndjson/encoder.js';
import { FrameSchema, type Frame } from '../../ndjson/frames.js';
import {
  runInspectFollow,
  type FollowSubscribe,
} from '../../cli/follow-loop.js';
import { tasksFollow } from '../../mcp/tasks-methods.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
 * Manually-driven clock (INV-16). `now()` is fixed so heartbeat timestamps are
 * deterministic; `scheduleInterval` records the tick so a test fires it with no
 * wall-clock sleep. Cancelling drops the loop.
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

/**
 * A hermetic subscribe fixture that captures the listener so a test can drive
 * exact deliveries. Returns a disposable handle; tracks disposal.
 */
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

// ─── Real-EventStore fixture ────────────────────────────────────────────────

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

/** The real DR-1 subscription contract, bound to the fixture store. */
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

// ─── CLI (NDJSON) carrier ────────────────────────────────────────────────────

describe('inspect --follow — CLI NDJSON carrier (DR-4)', () => {
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
      // No clock → no heartbeat, so the frame stream is purely event + end.
    });

    // Live appends over the REAL subscription — delivered synchronously
    // post-commit by the Tier-1 hook.
    await seed(FEATURE, 3);

    controller.abort();
    await handle.done;
    sink.end();

    const frames = parseFrames(await collect(sink));
    const eventFrames = frames.filter((f) => f.type === 'event');
    const seqs = eventFrames.map((f) => (f as { sequence: number }).sequence);

    // Each committed sequence appears EXACTLY once, in ascending order.
    expect(seqs).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate frame
    // Terminal `end` frame closes the stream in-band.
    expect(frames.at(-1)).toMatchObject({ type: 'end' });
  });

  it('InspectFollow_HeartbeatSinkThrows_ContainedAndLaterFramesStillFlow', async () => {
    // `onFrame` is a CALLER-supplied sink (NDJSON encoder write / MCP
    // task-update push). The heartbeat fires inside `scheduleInterval`, so a
    // throwing sink must be contained — otherwise it escapes the tick as an
    // unhandled process-level exception, the same gap `floorTick()` had.
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

    // The heartbeat tick's sink throws → contained, not process-level.
    expect(() => clock.fireAll()).not.toThrow();
    expect(frames).toHaveLength(0); // the throwing heartbeat delivered nothing

    // The follow loop survives: real event frames still flow afterwards …
    src.deliver(evt(1));
    expect(frames.map((f) => f.type)).toEqual(['event']);

    // … and a later heartbeat still emits once the sink recovers.
    failNextHeartbeat = false;
    clock.fireAll(); // suppressed — the delivered event reset the idle marker
    clock.fireAll(); // silence → heartbeat resumes
    expect(frames.map((f) => f.type)).toEqual(['event', 'heartbeat']);

    controller.abort();
    await handle.done;
  });

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

    // Silence: an injected tick emits a heartbeat with the INJECTED timestamp.
    clock.fireAll();
    // Activity: a delivered event resets the idle marker...
    src.deliver(evt(1));
    // ...so the very next tick is SUPPRESSED (heartbeat only marks silence).
    clock.fireAll();
    // Silence again → heartbeat resumes.
    clock.fireAll();

    const heartbeats = frames.filter((f) => f.type === 'heartbeat');
    expect(heartbeats).toHaveLength(2); // one before, one after — NOT during activity
    // INV-16: timestamp is derived from the injected clock, not wall-clock.
    const expectedTs = new Date(clock.fixedNow).toISOString();
    for (const hb of heartbeats) {
      expect((hb as { timestamp: string }).timestamp).toBe(expectedTs);
    }
    // The event frame landed between the two heartbeats.
    expect(frames.map((f) => f.type)).toEqual(['heartbeat', 'event', 'heartbeat']);

    controller.abort();
    await handle.done;
    // Heartbeat loop cancelled on teardown — no live timer leaks.
    expect(clock.loopCount).toBe(0);
  });

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

    // Live before abort — no process signal involved.
    expect(handle.disposed()).toBe(false);
    expect(spy.calls[0]!.disposeCount).toBe(0);

    controller.abort();
    await handle.done;

    // The abort disposed the REAL DR-1 subscription (INV-15).
    expect(handle.disposed()).toBe(true);
    expect(spy.calls[0]!.disposeCount).toBe(1);
  });
});

// ─── MCP (Tasks) carrier ─────────────────────────────────────────────────────

describe('inspect --follow — MCP Tasks carrier (DR-4)', () => {
  it('InspectFollow_McpTasks_SharesSubscriptionContract', async () => {
    const FEATURE = 'feat-shared';
    // ONE subscribe spy handed to BOTH facades proves they drive the SAME
    // DR-1 subscription contract (same filter + options), not two divergent
    // paths.
    const spy = spySubscribe(realSubscribe());

    const cliFrames: Frame[] = [];
    const mcpFrames: Frame[] = [];
    const cliCtl = new AbortController();

    // CLI arm.
    const cli = runInspectFollow({
      subscribe: spy.subscribe,
      featureId: FEATURE,
      fromSequence: 0,
      onFrame: (f) => cliFrames.push(f),
      signal: cliCtl.signal,
    });
    // MCP Tasks arm — SAME core, SAME contract; owns its cancel seam.
    const mcp = tasksFollow({
      subscribe: spy.subscribe,
      featureId: FEATURE,
      fromSequence: 0,
      onFrame: (f) => mcpFrames.push(f),
    });

    // Both registered against the same contract.
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]!.filter).toEqual({ streamId: FEATURE });
    expect(spy.calls[1]!.filter).toEqual({ streamId: FEATURE });
    expect(spy.calls[0]!.options).toEqual({ fromSequence: 0 });
    expect(spy.calls[1]!.options).toEqual({ fromSequence: 0 });

    // Same live events → byte-identical event-frame streams (INV-2).
    await seed(FEATURE, 3);

    const cliSeqs = cliFrames.filter((f) => f.type === 'event').map((f) => (f as { sequence: number }).sequence);
    const mcpSeqs = mcpFrames.filter((f) => f.type === 'event').map((f) => (f as { sequence: number }).sequence);
    expect(cliSeqs).toEqual([1, 2, 3]);
    expect(mcpSeqs).toEqual(cliSeqs);

    // task-cancel → subscription dispose (the MCP-facade wire).
    expect(mcp.disposed()).toBe(false);
    mcp.cancel();
    await mcp.done;
    expect(mcp.disposed()).toBe(true);
    expect(spy.calls[1]!.disposeCount).toBe(1);

    cliCtl.abort();
    await cli.done;
    expect(spy.calls[0]!.disposeCount).toBe(1);
  });
});

// ─── Dedup roundtrip property (data-transformation) ──────────────────────────

describe('inspect --follow — dedup roundtrip property (DR-4)', () => {
  it('InspectFollow_FrameStream_ContainsEachSequenceExactlyOnceMonotonic', () => {
    fc.assert(
      fc.property(
        // A source of (possibly duplicated, possibly out-of-order) sequences —
        // the adversary the by-sequence dedup guard must collapse.
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

          // Expected = the "record highs" of the input (monotonic, exactly once).
          const expected: number[] = [];
          let running = 0;
          for (const s of seqs) {
            if (s > running) {
              expected.push(s);
              running = s;
            }
          }
          expect(out).toEqual(expected);
          // Strictly increasing → no duplicate, always monotonic.
          for (let i = 1; i < out.length; i++) {
            expect(out[i]).toBeGreaterThan(out[i - 1]);
          }
          // Every emitted sequence came from the source.
          const inputSet = new Set(seqs);
          for (const s of out) expect(inputSet.has(s)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
