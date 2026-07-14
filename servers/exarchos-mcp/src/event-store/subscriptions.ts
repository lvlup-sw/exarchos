import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from './schemas.js';

/**
 * DR-1 — Cursor-pump subscription primitive (#1315).
 *
 * A subscription is a cursor over the committed event log. Delivery is
 * ALWAYS a cursor-driven drain: read matching events after the cursor,
 * deliver them in global sequence order, advance the cursor. The cursor is
 * the load-bearing invariant — every wake signal (Tier-1 in-process
 * post-commit hook; the Tier-2 `dataVersion()` poll floor) merely triggers
 * the SAME drain, so exactly-once, in-order delivery holds by construction
 * regardless of which signal fired or how many fired.
 *
 * Two wake tiers converge on {@link Subscription.requestDrain}:
 *  - Tier-1 (in-process): the appender's post-commit hook fans out through
 *    {@link SubscriptionRegistry.wake} the instant this process commits.
 *  - Tier-2 (cross-process poll floor): a loop on the injectable
 *    {@link SubscriptionClock} re-reads {@link SubscriptionEventReader.dataVersion}
 *    every `floorMs` and drains ONLY when the token changed — i.e. when a
 *    FOREIGN process committed (SQLite's `PRAGMA data_version` ignores the
 *    observer's own commits, which Tier-1 already delivers). The floor
 *    guarantees a bounded worst-case latency for events this process did not
 *    itself write; the cursor guarantees those events are never delivered
 *    twice even when both tiers fire for the same commit.
 *
 * No-gap / no-double across the tiers: the baseline `dataVersion()` is
 * captured at registration BEFORE the initial drain, so any commit not
 * covered by the initial drain necessarily bumps the token above baseline
 * and is picked up by a later tick; and because every signal re-enters the
 * same per-stream cursor drain, a Tier-1 wake at seq N+1 that sweeps up a
 * not-yet-seen foreign event at seq N delivers N before N+1, and a
 * subsequent tick for that same foreign commit re-drains to a no-op.
 */

// ─── Public contract ─────────────────────────────────────────────────────────

/**
 * Match predicate for a subscription.
 *
 * - `streamId` — when set, the subscription observes exactly one stream and
 *   its cursor is that stream's per-stream sequence (the clean, common case
 *   consumed by `wait`/`inspect`, which are always feature-scoped). When
 *   omitted, the subscription observes every stream (cross-stream fold).
 * - `eventTypes` — when set, only events whose `type` is in the list are
 *   delivered. Non-matching events still advance the cursor (they are read,
 *   just not delivered) so a stream dense with non-matching events never
 *   re-scans.
 */
export interface SubscriptionFilter {
  readonly streamId?: string;
  readonly eventTypes?: readonly string[];
}

/** Delivery callback. Invoked once per matching event, in global order. */
export type SubscriptionListener = (event: WorkflowEvent) => void;

export interface SubscribeOptions {
  /**
   * Start the cursor at this sequence instead of the stream head, so a
   * subscriber sees events committed AT OR AFTER `fromSequence + 1`. Only
   * meaningful for a single-stream filter (`filter.streamId` set); ignored
   * for cross-stream filters, whose baseline is the current head of every
   * known stream.
   */
  readonly fromSequence?: number;
  /**
   * Per-call override of the Tier-2 poll-floor interval (task-002). Captured
   * at registration; unused by the Tier-1 path in this module.
   */
  readonly floorMs?: number;
}

/**
 * Ephemeral handle returned by {@link SubscriptionRegistry.subscribe}.
 *
 * INV-15: subscriptions are per-dispatch and are disposed by the dispatch
 * that registered them — there is no daemon. `dispose()` is idempotent.
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
   * Tier-2 poll-floor change token (see `StorageBackend.dataVersion`). The
   * floor loop compares successive reads: an unchanged value means no
   * foreign commit and the loop skips the (more expensive) cursor drain
   * entirely. MUST be near-free and MUST NOT retain an open read cursor
   * across calls, or it would pin a snapshot that hides the very foreign
   * commit it is polling for.
   */
  dataVersion(): number;
}

/**
 * Injectable clock seam (INV-16). The Tier-1 drain is signal-driven and uses
 * no wall-clock time; the Tier-2 poll floor schedules its ticks through
 * {@link scheduleInterval} so tests drive them deterministically (no
 * `Date.now()`, no real `setTimeout` sleeps).
 */
export interface SubscriptionClock {
  now(): number;
  /**
   * Schedule `tick` to run every `intervalMs` until the returned canceller
   * is invoked. This is the ONLY timing seam the Tier-2 floor uses.
   *
   * OPTIONAL by design: when a clock omits it, the subscription runs with NO
   * Tier-2 floor (Tier-1 only). The registry's auto-created default clock
   * supplies a real, `unref`'d host-timer implementation so production
   * subscriptions get the floor; a test that injects a bare `{ now }` clock
   * opts out of real timers, and a test that injects a manual scheduler
   * drives the floor tick-by-tick.
   *
   * The canceller MUST be idempotent and stop all further ticks.
   */
  scheduleInterval?(tick: () => void, intervalMs: number): () => void;
}

/** Documented default poll-floor interval (ms) for the Tier-2 wake tier. */
export const DEFAULT_FLOOR_MS = 250;

/**
 * The registry's default clock when none is injected. Wall-clock `now` plus a
 * host-timer `scheduleInterval` whose handle is `unref`'d so the Tier-2 floor
 * never keeps the process alive on its own (the dispatch that owns the
 * subscription is what keeps the process live; the floor is a passive poll).
 */
function defaultSubscriptionClock(): SubscriptionClock {
  return {
    now: () => Date.now(),
    scheduleInterval: (tick, intervalMs) => {
      const timer = setInterval(tick, intervalMs);
      // `unref` exists on Node/Bun timer handles but not in the DOM lib types;
      // guard so this stays portable across the type surfaces.
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

// ─── Global-order comparator ────────────────────────────────────────────────

/**
 * Deterministic global ordering for a merged drain batch.
 *
 * Within a single stream the per-stream `sequence` is the authoritative
 * total order, so same-stream events compare purely by sequence — this makes
 * the single-stream delivery guarantee (the only ordering the DR-1
 * acceptance criteria assert) exact and independent of timestamp ties. Across
 * streams there is no shared sequence space, so `(timestamp, streamId,
 * sequence)` is the deterministic global proxy; exactly-once is guaranteed by
 * the per-stream cursor advance regardless, so the cross-stream order only
 * affects presentation.
 */
function compareGlobalOrder(a: WorkflowEvent, b: WorkflowEvent): number {
  if (a.streamId === b.streamId) return a.sequence - b.sequence;
  const byTs = a.timestamp.localeCompare(b.timestamp);
  if (byTs !== 0) return byTs;
  const byStream = a.streamId.localeCompare(b.streamId);
  if (byStream !== 0) return byStream;
  return a.sequence - b.sequence;
}

// ─── Subscription ────────────────────────────────────────────────────────────

class Subscription {
  readonly id = randomUUID();
  disposed = false;

  /** Per-stream last-delivered sequence — the cursor. */
  private readonly cursors = new Map<string, number>();
  /** Re-entrancy guard so at most one drain runs at a time per subscription. */
  private draining = false;
  /** Set when a wake arrives mid-drain; coalesces into a single re-run. */
  private rerun = false;

  /**
   * Last-observed Tier-2 change token. Captured at registration BEFORE the
   * initial drain (see the constructor ordering note) and advanced by each
   * tick that drains, so a tick fires the cursor drain only on a real change.
   */
  private floorVersion = 0;
  /** Cancels the Tier-2 floor loop; undefined when no floor loop is active. */
  private cancelFloor?: () => void;
  /** Tier-2 telemetry (surfaced via {@link perf}). */
  private floorTicks = 0;
  private floorDrains = 0;

  constructor(
    private readonly filter: SubscriptionFilter,
    private readonly listener: SubscriptionListener,
    private readonly reader: SubscriptionEventReader,
    /** Injectable clock (INV-16) — drives the Tier-2 poll floor. */
    private readonly clock: SubscriptionClock,
    /** Effective Tier-2 poll-floor interval (per-call override or registry default). */
    readonly floorMs: number,
    fromSequence: number | undefined,
    private readonly onDispose: (sub: Subscription) => void,
  ) {
    // Registration is atomic AND ordered: cursor first, THEN the Tier-2
    // baseline, THEN the initial drain, THEN the floor loop. The ordering is
    // load-bearing for the no-gap guarantee across the two wake tiers:
    //
    //   1. Capture the cursor(s) (T1). headSequence is read synchronously.
    //   2. Capture the dataVersion baseline (T2) — AFTER the cursor so a
    //      foreign commit landing between T1 and T2 is reflected in the
    //      baseline (its event has seq > cursor, so the initial drain still
    //      delivers it, and no future tick re-delivers it). If the baseline
    //      were captured BEFORE the cursor, such a commit would be past the
    //      cursor yet above no future token — a gap.
    //   3. Run the unconditional initial drain (T3) — covers everything with
    //      seq > cursor committed by now. Because T2 < T3, any commit not
    //      covered by the drain necessarily bumps the token above the
    //      baseline and is caught by a later tick — no gap.
    //   4. Start the floor loop (if the clock can schedule one).
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
    // The Tier-2 floor is opt-in on the clock: a bare `{ now }` clock (no
    // scheduler) runs Tier-1 only. Guard the schedule with the disposed flag
    // in case an initial-drain listener disposed synchronously.
    if (!this.disposed) {
      this.cancelFloor = this.clock.scheduleInterval?.(() => this.floorTick(), this.floorMs);
    }
  }

  /**
   * One Tier-2 poll-floor tick. Near-free by design: a single
   * {@link SubscriptionEventReader.dataVersion} read (no open statement held
   * across ticks) that re-enters the cursor drain ONLY when the token
   * changed — i.e. a foreign process committed. Own commits are delivered by
   * the Tier-1 hook and (for SQLite) do not bump the token, so a
   * no-foreign-commit tick never touches the event log.
   */
  private floorTick(): void {
    if (this.disposed) return;
    this.floorTicks++;
    const current = this.reader.dataVersion();
    if (current === this.floorVersion) return; // no foreign commit → no re-read
    // Advance the baseline BEFORE draining: a commit that lands during this
    // drain bumps the token past `current`, so the next tick still fires for
    // it (an extra harmless, cursor-guarded drain) rather than being folded
    // into the baseline and lost. Never a gap; at worst one redundant tick.
    this.floorVersion = current;
    this.floorDrains++;
    this.requestDrain();
  }

  /** Snapshot of this subscription's Tier-2 floor telemetry. */
  perf(): SubscriptionPerf {
    return {
      floorMs: this.floorMs,
      floorTicks: this.floorTicks,
      floorDrains: this.floorDrains,
    };
  }

  /** True when a commit on `streamId` could produce a matching event. */
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

  private drainOnce(): void {
    const streams =
      this.filter.streamId !== undefined
        ? [this.filter.streamId]
        : this.unionStreams();

    const batch: WorkflowEvent[] = [];
    for (const streamId of streams) {
      const cursor = this.cursors.get(streamId) ?? 0;
      const events = this.reader.readStreamAfter(streamId, cursor);
      if (events.length === 0) continue;
      for (const event of events) batch.push(event);
      // Advance the cursor PAST every event read (matching or not) so
      // trailing non-matching events never force a re-scan. Contiguous
      // per-stream sequences make the tail the last element.
      this.cursors.set(streamId, events[events.length - 1].sequence);
    }

    if (batch.length === 0) return;
    batch.sort(compareGlobalOrder);

    for (const event of batch) {
      if (this.disposed) return;
      if (!this.matchesEvent(event)) continue;
      // Listener isolation: a throw on one event must not drop the rest of
      // the batch, affect sibling subscriptions, or reach the appender.
      try {
        this.listener(event);
      } catch {
        // Intentionally swallowed — delivery is best-effort observation.
      }
    }
  }

  /** Streams to scan for a cross-stream drain: backend streams ∪ cursor keys. */
  private unionStreams(): string[] {
    const streams = new Set<string>(this.reader.listStreams());
    for (const streamId of this.cursors.keys()) streams.add(streamId);
    return [...streams];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Stop the Tier-2 floor loop first so no tick fires after disposal
    // (INV-15: a subscription does no work past the dispatch that owns it).
    this.cancelFloor?.();
    this.cancelFloor = undefined;
    this.onDispose(this);
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Owns the set of live subscriptions and routes Tier-1 wakes to them.
 *
 * The registry is the single guard on the append hot path: {@link wake}
 * early-returns on an empty registry, so a zero-subscriber append does no
 * listener work beyond one size check.
 */
export class SubscriptionRegistry {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly reader: SubscriptionEventReader;
  /** Injectable clock (INV-16) — retained for the task-002 Tier-2 floor. */
  readonly clock: SubscriptionClock;
  /** Default poll-floor interval — retained for the task-002 Tier-2 floor. */
  readonly defaultFloorMs: number;

  constructor(reader: SubscriptionEventReader, options?: SubscriptionRegistryOptions) {
    this.reader = reader;
    // The default clock supplies a real, unref'd `scheduleInterval` so
    // production subscriptions get the Tier-2 floor. An injected clock is
    // used verbatim — a bare `{ now }` clock opts out of the floor entirely.
    this.clock = options?.clock ?? defaultSubscriptionClock();
    this.defaultFloorMs = options?.defaultFloorMs ?? DEFAULT_FLOOR_MS;
  }

  /** Number of live subscriptions (INV-15 leak assertions read this). */
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
   * Tier-1 wake. Called by the append path AFTER the transaction commits and
   * AFTER the per-stream mutex releases (never inside the lock). Fans out to
   * every subscription whose filter could match `streamId`, each drain
   * isolated so one failing subscription cannot affect siblings or the
   * append that triggered the wake.
   */
  wake(streamId: string): void {
    if (this.subscriptions.size === 0) return;
    // Snapshot: a listener that appends may register/dispose subscriptions
    // synchronously mid-iteration.
    for (const sub of [...this.subscriptions.values()]) {
      if (sub.disposed || !sub.matchesStream(streamId)) continue;
      try {
        sub.requestDrain();
      } catch {
        // Isolate subscription-level failures from the append result.
      }
    }
  }

  /** Dispose every live subscription (dispatch teardown — INV-15). */
  disposeAll(): void {
    for (const sub of [...this.subscriptions.values()]) sub.dispose();
    this.subscriptions.clear();
  }
}
