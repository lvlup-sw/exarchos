/**
 * The cursor-pump subscription primitive. A subscription is a cursor over the committed event log.
 * Each delivery is a drain: read the matching events after the cursor, deliver them in order, and
 * advance the cursor. Every wake signal runs the same drain, so delivery is exactly once and in
 * order, whatever signal fires.
 *
 * Two wake tiers call {@link Subscription.requestDrain}. In Tier 1, the post-commit hook of the
 * appender calls {@link SubscriptionRegistry.wake} in the same process. In Tier 2, a poll loop on
 * the {@link SubscriptionClock} reads {@link SubscriptionEventReader.dataVersion} every `floorMs`.
 * It drains only when the token changes, which is when a different process commits. SQLite
 * `PRAGMA data_version` ignores the commits of the observer itself.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from './schemas.js';

/**
 * The match predicate for a subscription.
 *
 * - `streamId`: when set, the subscription observes one stream, and its cursor is the per-stream
 *   sequence. When omitted, the subscription observes every stream.
 * - `eventTypes`: when set, the subscription delivers only events of these types. Other events
 *   still advance the cursor, so a stream with many of them needs no second scan.
 */
export interface SubscriptionFilter {
  readonly streamId?: string;
  readonly eventTypes?: readonly string[];
}

/** Delivery callback. Invoked once per matching event, in global order. */
export type SubscriptionListener = (event: WorkflowEvent) => void;

export interface SubscribeOptions {
  /**
   * Start the cursor at this sequence instead of the stream head, so the subscriber sees the
   * events after `fromSequence`. Only a single-stream filter uses it. A cross-stream filter starts
   * at the current head of every known stream.
   */
  readonly fromSequence?: number;
  /** Override of the Tier-2 poll-floor interval for this call, captured at registration. */
  readonly floorMs?: number;
}

/**
 * The handle that {@link SubscriptionRegistry.subscribe} returns. The dispatch that registers a
 * subscription disposes it, and no daemon exists. `dispose()` is idempotent.
 */
export interface SubscriptionHandle {
  readonly id: string;
  readonly disposed: boolean;
  dispose(): void;
  /** Snapshot of this subscription's Tier-2 floor telemetry (see {@link SubscriptionPerf}). */
  perf(): SubscriptionPerf;
}

/**
 * Read seam the drain pulls committed events through. Kept deliberately
 * narrow (and synchronous — the SQLite backend reads are synchronous) so the
 * registry has no dependency on `EventStore` internals and is trivially
 * driven by a hermetic fixture in unit tests. The production wiring in
 * `EventStore.subscribe()` implements this over its read backend.
 */
export interface SubscriptionEventReader {
  /** Highest committed sequence on `streamId`, or 0 when empty/unknown. */
  headSequence(streamId: string): number;
  /**
   * Committed events on `streamId` with `sequence > afterSequence`, in
   * ascending sequence order. MUST include events of every type (not only
   * the subscription's `eventTypes`) so the cursor can advance past
   * non-matching events.
   */
  readStreamAfter(streamId: string, afterSequence: number): readonly WorkflowEvent[];
  /** Every stream id known to the backend (for cross-stream subscriptions). */
  listStreams(): readonly string[];
  /**
   * The Tier-2 change token (see `StorageBackend.dataVersion`). An unchanged value means no
   * foreign commit, so the floor loop skips the drain. The read must cost almost nothing. It must
   * not keep a read cursor open across calls, because that pins a snapshot that hides the commit.
   */
  dataVersion(): number;
}

/**
 * The injectable clock. The Tier-1 drain uses no wall-clock time. The Tier-2 poll floor schedules
 * its ticks through {@link scheduleInterval}, so tests drive them deterministically.
 */
export interface SubscriptionClock {
  now(): number;
  /**
   * Schedule `tick` to run every `intervalMs` until the caller invokes the returned canceller.
   * When a clock omits this method, the subscription has no Tier-2 floor. The default clock of
   * the registry supplies a host timer. The canceller must be idempotent and stop all ticks.
   */
  scheduleInterval?(tick: () => void, intervalMs: number): () => void;
}

/** Documented default poll-floor interval (ms) for the Tier-2 wake tier. */
export const DEFAULT_FLOOR_MS = 250;

/**
 * The default clock of the registry: wall-clock `now` and a host-timer `scheduleInterval`. The
 * code calls `unref` on the timer, so the Tier-2 floor never keeps the process alive. The DOM lib
 * types do not declare `unref`, so the call is guarded.
 */
function defaultSubscriptionClock(): SubscriptionClock {
  return {
    now: () => Date.now(),
    scheduleInterval: (tick, intervalMs) => {
      const timer = setInterval(tick, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    },
  };
}

/**
 * Per-subscription Tier-2 floor telemetry, surfaced on
 * {@link SubscriptionHandle.perf}. Lets callers/perf harnesses observe the
 * effective poll interval and how much drain work the floor actually did.
 */
export interface SubscriptionPerf {
  /** Effective poll-floor interval (ms) — per-call override or registry default. */
  readonly floorMs: number;
  /** Total floor-loop ticks observed so far. */
  readonly floorTicks: number;
  /**
   * Ticks that saw a `dataVersion()` change and therefore triggered a cursor
   * drain. `floorTicks - floorDrains` ticks were near-free no-ops (no foreign
   * commit, no event-log re-read).
   */
  readonly floorDrains: number;
}

export interface SubscriptionRegistryOptions {
  readonly clock?: SubscriptionClock;
  readonly defaultFloorMs?: number;
}

/**
 * A deterministic global order for a merged drain batch. Events in one stream compare by
 * `sequence`, which is the total order of that stream. Across streams, the order is
 * `(timestamp, streamId, sequence)`. The per-stream cursor gives exactly-once delivery, so the
 * cross-stream order affects only presentation.
 */
function compareGlobalOrder(a: WorkflowEvent, b: WorkflowEvent): number {
  if (a.streamId === b.streamId) return a.sequence - b.sequence;
  const byTs = a.timestamp.localeCompare(b.timestamp);
  if (byTs !== 0) return byTs;
  const byStream = a.streamId.localeCompare(b.streamId);
  if (byStream !== 0) return byStream;
  return a.sequence - b.sequence;
}

class Subscription {
  readonly id = randomUUID();
  disposed = false;

  /** Per-stream last-delivered sequence — the cursor. */
  private readonly cursors = new Map<string, number>();
  /** Re-entrancy guard so at most one drain runs at a time per subscription. */
  private draining = false;
  /** Set when a wake arrives during a drain. The wakes merge into one more run. */
  private rerun = false;

  /**
   * The last Tier-2 change token. The constructor captures it before the initial drain, and each
   * tick that drains advances it.
   */
  private floorVersion = 0;
  /** Cancels the Tier-2 floor loop. It is `undefined` when no floor loop runs. */
  private cancelFloor?: (() => void) | undefined;
  /** Tier-2 telemetry (surfaced via {@link perf}). */
  private floorTicks = 0;
  private floorDrains = 0;

  /**
   * Registration runs in a fixed order, which gives the no-gap guarantee across the two tiers.
   * It captures the cursor, then the `dataVersion()` baseline, then runs the initial drain, then
   * starts the floor loop. A foreign commit between the cursor and the baseline has a sequence
   * above the cursor, so the initial drain delivers it. A later commit that the drain misses
   * moves the token, so a later tick drains it.
   *
   * A clock with no scheduler runs Tier 1 only. The floor loop does not start when a listener
   * disposes the subscription during the initial drain.
   */
  constructor(
    private readonly filter: SubscriptionFilter,
    private readonly listener: SubscriptionListener,
    private readonly reader: SubscriptionEventReader,
    /** The injectable clock that drives the Tier-2 poll floor. */
    private readonly clock: SubscriptionClock,
    /** Effective Tier-2 poll-floor interval (per-call override or registry default). */
    readonly floorMs: number,
    fromSequence: number | undefined,
    private readonly onDispose: (sub: Subscription) => void,
  ) {
    if (this.filter.streamId !== undefined) {
      this.cursors.set(
        this.filter.streamId,
        fromSequence ?? this.reader.headSequence(this.filter.streamId),
      );
    } else {
      for (const streamId of this.reader.listStreams()) {
        this.cursors.set(streamId, this.reader.headSequence(streamId));
      }
    }
    this.floorVersion = this.reader.dataVersion();
    this.requestDrain();
    if (!this.disposed) {
      this.cancelFloor = this.clock.scheduleInterval?.(() => this.floorTick(), this.floorMs);
    }
  }

  /**
   * One Tier-2 poll tick. It reads {@link SubscriptionEventReader.dataVersion} once and drains only
   * when the token changed, which is when a foreign process committed.
   *
   * The tick advances the baseline before the drain, so a commit during the drain moves the token
   * again and the next tick drains it. The tick catches every error, because it runs in a native
   * `setInterval` callback and `requestDrain()` lets read errors through. On an error, the
   * baseline goes back so that the next tick tries again. The cursor prevents a second delivery.
   */
  private floorTick(): void {
    if (this.disposed) return;
    this.floorTicks++;
    const baseline = this.floorVersion;
    try {
      const current = this.reader.dataVersion();
      if (current === baseline) return;
      this.floorVersion = current;
      this.floorDrains++;
      this.requestDrain();
    } catch {
      this.floorVersion = baseline;
    }
  }

  /** Snapshot of this subscription's Tier-2 floor telemetry. */
  perf(): SubscriptionPerf {
    return {
      floorMs: this.floorMs,
      floorTicks: this.floorTicks,
      floorDrains: this.floorDrains,
    };
  }

  /** True when a commit on `streamId` can produce a matching event. */
  matchesStream(streamId: string): boolean {
    return this.filter.streamId === undefined || this.filter.streamId === streamId;
  }

  private matchesEvent(event: WorkflowEvent): boolean {
    if (this.filter.streamId !== undefined && event.streamId !== this.filter.streamId) {
      return false;
    }
    if (this.filter.eventTypes !== undefined && !this.filter.eventTypes.includes(event.type)) {
      return false;
    }
    return true;
  }

  /**
   * Trigger a drain. Serialized per subscription: if a drain is already
   * running (a wake arrived mid-delivery), flag a re-run and return so the
   * initial drain and a concurrent wake never double-deliver. The loop
   * drains-until-quiescent so a wake that lands during delivery is not lost.
   */
  requestDrain(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.rerun = false;
        this.drainOnce();
      } while (this.rerun && !this.disposed);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Read every stream, then advance the cursors, then deliver. When a read throws, no cursor
   * moves, so the next drain reads from the same positions and skips no event. Each cursor moves
   * past every event read, matching or not, so non-matching events cause no second scan. The drain
   * ignores a listener error and continues the batch, because delivery is a best-effort observation.
   */
  private drainOnce(): void {
    const streams =
      this.filter.streamId !== undefined
        ? [this.filter.streamId]
        : this.unionStreams();

    const batch: WorkflowEvent[] = [];
    const pendingCursors: Array<[streamId: string, tailSequence: number]> = [];
    for (const streamId of streams) {
      const cursor = this.cursors.get(streamId) ?? 0;
      const events = this.reader.readStreamAfter(streamId, cursor);
      if (events.length === 0) continue;
      for (const event of events) batch.push(event);
      pendingCursors.push([streamId, events[events.length - 1]?.sequence ?? cursor]);
    }

    for (const [streamId, tailSequence] of pendingCursors) {
      this.cursors.set(streamId, tailSequence);
    }

    if (batch.length === 0) return;
    batch.sort(compareGlobalOrder);

    for (const event of batch) {
      if (this.disposed) return;
      if (!this.matchesEvent(event)) continue;
      try {
        this.listener(event);
      } catch {
      }
    }
  }

  /** Streams to scan for a cross-stream drain: backend streams ∪ cursor keys. */
  private unionStreams(): string[] {
    const streams = new Set<string>(this.reader.listStreams());
    for (const streamId of this.cursors.keys()) streams.add(streamId);
    return [...streams];
  }

  /** Stop the Tier-2 floor loop first, so no tick runs after the owning dispatch ends. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFloor?.();
    this.cancelFloor = undefined;
    this.onDispose(this);
  }
}

/**
 * Owns the live subscriptions and sends Tier-1 wakes to them. {@link wake} returns early on an
 * empty registry, so an append with no subscriber costs one size check.
 */
export class SubscriptionRegistry {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly reader: SubscriptionEventReader;
  /** The injectable clock for the Tier-2 floor. */
  readonly clock: SubscriptionClock;
  /** The default poll-floor interval. */
  readonly defaultFloorMs: number;

  /**
   * The default clock supplies a real `scheduleInterval`, so production subscriptions get the
   * Tier-2 floor. An injected clock without a scheduler gives no floor.
   */
  constructor(reader: SubscriptionEventReader, options?: SubscriptionRegistryOptions) {
    this.reader = reader;
    this.clock = options?.clock ?? defaultSubscriptionClock();
    this.defaultFloorMs = options?.defaultFloorMs ?? DEFAULT_FLOOR_MS;
  }

  /** The number of live subscriptions. Leak checks read this value. */
  get size(): number {
    return this.subscriptions.size;
  }

  subscribe(
    filter: SubscriptionFilter,
    listener: SubscriptionListener,
    options?: SubscribeOptions,
  ): SubscriptionHandle {
    const sub = new Subscription(
      filter,
      listener,
      this.reader,
      this.clock,
      options?.floorMs ?? this.defaultFloorMs,
      options?.fromSequence,
      (s) => {
        this.subscriptions.delete(s.id);
      },
    );
    this.subscriptions.set(sub.id, sub);
    return {
      id: sub.id,
      get disposed() {
        return sub.disposed;
      },
      dispose: () => sub.dispose(),
      perf: () => sub.perf(),
    };
  }

  /**
   * The Tier-1 wake. The append path calls it after the commit, outside the per-stream mutex.
   * Each matching subscription drains in isolation, so a failure cannot reach siblings or the
   * append. The loop iterates a copy, because a listener can register or dispose a subscription.
   */
  wake(streamId: string): void {
    if (this.subscriptions.size === 0) return;
    for (const sub of [...this.subscriptions.values()]) {
      if (sub.disposed || !sub.matchesStream(streamId)) continue;
      try {
        sub.requestDrain();
      } catch {
      }
    }
  }

  /** Dispose every live subscription at dispatch teardown. */
  disposeAll(): void {
    for (const sub of [...this.subscriptions.values()]) sub.dispose();
    this.subscriptions.clear();
  }
}
