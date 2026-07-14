import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from './schemas.js';

/**
 * DR-1 — Cursor-pump subscription primitive (#1315).
 *
 * A subscription is a cursor over the committed event log. Delivery is
 * ALWAYS a cursor-driven drain: read matching events after the cursor,
 * deliver them in global sequence order, advance the cursor. The cursor is
 * the load-bearing invariant — every wake signal (Tier-1 in-process
 * post-commit hook here; the Tier-2 `dataVersion()` poll floor in task-002)
 * merely triggers the SAME drain, so exactly-once, in-order delivery holds
 * by construction regardless of which signal fired or how many fired.
 *
 * Scope of THIS module (task-001): registration + the cursor drain + the
 * Tier-1 wake plumbing. The Tier-2 cross-process poll floor is deliberately
 * NOT implemented here — {@link SubscriptionClock} and the per-subscription
 * `floorMs` are captured as the seam task-002 binds the floor loop to.
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
}

/**
 * Injectable clock seam (INV-16). Task-001 uses NO wall-clock time — the
 * Tier-1 drain is signal-driven, not timed. This interface exists so the
 * task-002 Tier-2 poll floor is deterministic (no `Date.now()`, no
 * `setTimeout` sleeps) the moment it lands.
 */
export interface SubscriptionClock {
  now(): number;
}

/** Documented default poll-floor interval (task-002 consumes it). */
export const DEFAULT_FLOOR_MS = 250;

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

  constructor(
    private readonly filter: SubscriptionFilter,
    private readonly listener: SubscriptionListener,
    private readonly reader: SubscriptionEventReader,
    /** Captured for task-002's Tier-2 floor; unused by the Tier-1 path. */
    readonly floorMs: number,
    fromSequence: number | undefined,
    private readonly onDispose: (sub: Subscription) => void,
  ) {
    // Registration is atomic: capture the baseline cursor(s) synchronously
    // (single-threaded JS — no gap between reading head and recording it),
    // THEN schedule the unconditional initial drain. Any event committed
    // after this point is delivered by the initial drain or a later wake,
    // never lost to a baseline that already covered it.
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
    // Unconditional initial drain — covers an event that committed at the
    // exact registration instant (the baseline-already-included case is a
    // no-op; nothing is after the cursor).
    this.requestDrain();
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
    this.clock = options?.clock ?? { now: () => Date.now() };
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
