import type { WorkflowEvent } from '../event-store/schemas.js';
import type { SnapshotStore } from './snapshot-store.js';
import type { StorageBackend } from '../storage/backend.js';
import { viewLogger } from '../logger.js';
import type { ProjectionCursor } from '../projections/freshness.js';

// ─── View Projection Interface ─────────────────────────────────────────────

export interface ViewProjection<T> {
  /** Create the initial/default view state. */
  init(): T;
  /** Apply a single event to the current view state, returning the new state. */
  apply(view: T, event: WorkflowEvent): T;
}

// ─── View State Entry ──────────────────────────────────────────────────────

interface ViewState<T = unknown> {
  readonly view: T;
  readonly highWaterMark: number;
}

// ─── Materializer Options ──────────────────────────────────────────────────

export interface MaterializerOptions {
  readonly snapshotStore?: SnapshotStore;
  readonly snapshotInterval?: number;
  readonly maxCacheEntries?: number;
  readonly backend?: StorageBackend;
  /** Size of the sliding window for thrashing detection (default: 100). */
  readonly thrashingWindowSize?: number;
}

// ─── Default Snapshot Interval ─────────────────────────────────────────────

const DEFAULT_SNAPSHOT_INTERVAL = 50;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const DEFAULT_THRASHING_WINDOW_SIZE = 100;

// ─── Internal Sentinel Streams (#1434) ─────────────────────────────────────
//
// The event store writes progress events to `__`-prefixed sentinel streams
// (e.g. `__migration__` from `migrateV5ToV6`). These are intentionally
// outside the user-facing kebab-only featureId vocabulary, but the pipeline
// view's stream-iteration path forwards every discovered streamId into
// `materialize`, which transitively reaches `SnapshotStore.getSnapshotPath`
// — and that enforces `SAFE_ID_PATTERN = /^[a-z0-9-]+$/`, crashing the view
// with `VIEW_ERROR: Invalid streamId: "__migration__"` on any clean install
// that has run a schema migration.
//
// Skipping at this layer is narrower than relaxing `SAFE_ID_PATTERN` (option
// (b) in #1434, explicitly rejected); the kebab-only constraint is the
// right shape for user-facing featureIds and we don't want a future caller
// to accidentally name a snapshot file `..` or `subdir/foo`.
const isInternalSentinelStream = (id: string): boolean => id.startsWith('__');

/** Read EXARCHOS_MAX_CACHE_ENTRIES from env, falling back to default on invalid/missing. */
function parseEnvMaxCacheEntries(): number {
  const raw = process.env.EXARCHOS_MAX_CACHE_ENTRIES;
  if (raw === undefined) return DEFAULT_MAX_CACHE_ENTRIES;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return DEFAULT_MAX_CACHE_ENTRIES;
  return parsed;
}

/** Read EXARCHOS_SNAPSHOT_INTERVAL from env, falling back to default on invalid/missing. */
function parseEnvSnapshotInterval(): number {
  const raw = process.env.EXARCHOS_SNAPSHOT_INTERVAL;
  if (raw === undefined) return DEFAULT_SNAPSHOT_INTERVAL;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return DEFAULT_SNAPSHOT_INTERVAL;
  return parsed;
}

// ─── View Materializer ─────────────────────────────────────────────────────

export class ViewMaterializer {
  private readonly projections = new Map<string, ViewProjection<unknown>>();
  // Key: `${viewName}:${streamId}` → ViewState
  private readonly states = new Map<string, ViewState>();
  // Track last snapshot high-water mark per key for interval-based snapshotting
  private readonly lastSnapshotHwm = new Map<string, number>();

  private readonly snapshotStore?: SnapshotStore | undefined;
  private readonly snapshotInterval: number;
  private readonly maxCacheEntries: number;
  private readonly backend?: StorageBackend | undefined;

  // Pending snapshot writes (fire-and-forget, but flushable for tests/shutdown)
  private pendingSnapshots: Promise<void>[] = [];

  // Cache hit/miss counters
  private cacheHits = 0;
  private cacheMisses = 0;
  // Cache-bypass counter (#1448 item 5 / PR #1447 DIM-2 audit). Incremented by
  // `materializeFiltered` in `views/tools.ts`, which skips the LRU cache entirely
  // for correlation-filtered queries. Tracked on a separate axis from hits/misses
  // so the existing hit-rate calculation stays well-defined; otherwise a healthy
  // hitRate could mask thousands of invisible bypass calls.
  private cacheBypasses = 0;

  // Thrashing detection sliding window
  private readonly thrashingWindowSize: number;
  private recentMisses = 0;
  private recentTotal = 0;

  constructor(options?: MaterializerOptions) {
    this.snapshotStore = options?.snapshotStore;
    this.snapshotInterval = options?.snapshotInterval ?? parseEnvSnapshotInterval();
    this.maxCacheEntries = options?.maxCacheEntries ?? parseEnvMaxCacheEntries();
    this.backend = options?.backend;
    this.thrashingWindowSize = options?.thrashingWindowSize ?? DEFAULT_THRASHING_WINDOW_SIZE;
  }

  /**
   * Register a named projection.
   */
  register<T>(viewName: string, projection: ViewProjection<T>): void {
    this.projections.set(viewName, projection as ViewProjection<unknown>);
  }

  /**
   * Unregister a named projection and remove all cached state for it.
   */
  unregister(viewName: string): void {
    this.projections.delete(viewName);
    // Remove all cached states for this projection
    const prefix = `${viewName}:`;
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(prefix)) {
        this.states.delete(key);
        this.lastSnapshotHwm.delete(key);
      }
    }
  }

  /**
   * Materialize a view by applying events through the registered projection.
   * Uses high-water mark tracking for incremental updates.
   */
  materialize<T>(streamId: string, viewName: string, events: WorkflowEvent[]): T {
    const projection = this.projections.get(viewName);
    if (!projection) {
      throw new Error(`No projection registered for view: ${viewName}`);
    }

    // #1434 — skip `__`-prefixed sentinel streams (e.g. `__migration__`) so
    // they never reach `SnapshotStore.getSnapshotPath`, whose `SAFE_ID_PATTERN`
    // rejects underscores and crashes the pipeline view. Returning
    // `projection.init()` keeps the caller's iteration loop happy without
    // polluting the LRU cache or persisting a snapshot for the sentinel.
    if (isInternalSentinelStream(streamId)) {
      viewLogger.debug(
        { streamId, viewName },
        'ViewMaterializer: skipping sentinel stream',
      );
      return projection.init() as T;
    }

    const stateKey = `${viewName}:${streamId}`;
    let state = this.states.get(stateKey) as ViewState<T> | undefined;

    // Track cache hit/miss
    if (state) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
      this.recentMisses++;
    }
    this.recentTotal++;

    // Check for thrashing at window boundary
    if (this.recentTotal >= this.thrashingWindowSize) {
      if (this.recentMisses / this.recentTotal > 0.5) {
        viewLogger.warn(
          { missRate: (this.recentMisses / this.recentTotal).toFixed(2), cacheSize: this.states.size, maxCacheEntries: this.maxCacheEntries },
          'View cache thrashing detected — miss rate exceeds 50% over last window. Consider increasing EXARCHOS_MAX_CACHE_ENTRIES',
        );
      }
      this.recentMisses = 0;
      this.recentTotal = 0;
    }

    if (!state) {
      state = {
        view: projection.init() as T,
        highWaterMark: 0,
      };
    }

    // Only process events past the high-water mark
    const newEvents = events.filter((e) => e.sequence > state!.highWaterMark);

    let currentView = state.view;
    for (const event of newEvents) {
      currentView = projection.apply(currentView, event) as T;
    }

    // Update high-water mark to the max sequence seen
    // Events are append-only and monotonically increasing, so the last element is the max
    const maxSequence =
      newEvents.length > 0
        ? (newEvents[newEvents.length - 1]?.sequence ?? state.highWaterMark)
        : state.highWaterMark;

    const updatedState: ViewState<T> = {
      view: currentView,
      highWaterMark: maxSequence,
    };

    // LRU: delete and re-insert to move to end (most recently used)
    this.states.delete(stateKey);
    this.states.set(stateKey, updatedState as ViewState);

    // Evict least recently used if over limit
    this.evictIfNeeded();

    // Trigger cache/snapshot save if interval crossed
    if (newEvents.length > 0) {
      const lastSnapHwm = this.lastSnapshotHwm.get(stateKey) ?? 0;
      if (maxSequence - lastSnapHwm >= this.snapshotInterval) {
        this.lastSnapshotHwm.set(stateKey, maxSequence);

        if (this.backend) {
          try {
            this.backend.setViewCache(streamId, viewName, currentView, maxSequence);
          } catch (err) {
            viewLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Backend view cache save failed');
          }
        } else if (this.snapshotStore) {
          // Fire and forget - snapshot is async but we don't block materialization.
          // Track the promise so flush() can await completion for tests/shutdown.
          const savePromise = this.snapshotStore.save(streamId, viewName, currentView, maxSequence).catch((err) => {
            viewLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Snapshot save failed');
          });
          this.pendingSnapshots.push(savePromise);
        }
      }
    }

    return currentView;
  }

  /**
   * Await all pending snapshot writes. Useful for tests and graceful shutdown.
   */
  async flush(): Promise<void> {
    await Promise.all(this.pendingSnapshots);
    this.pendingSnapshots = [];
  }

  /**
   * Load view state from a snapshot, if one exists.
   * Falls back to default init state if snapshot is missing or corrupt.
   */
  async loadFromSnapshot(streamId: string, viewName: string): Promise<boolean> {
    // #1434 — sentinel streams never have a meaningful snapshot to load and
    // would otherwise trip `SnapshotStore.getSnapshotPath`'s kebab-only
    // validator. Short-circuit before touching the backend/snapshotStore.
    if (isInternalSentinelStream(streamId)) {
      viewLogger.debug(
        { streamId, viewName },
        'ViewMaterializer: skipping snapshot load for sentinel stream',
      );
      return false;
    }
    // Prefer backend view cache when available
    if (this.backend) {
      const cached = this.backend.getViewCache(streamId, viewName);
      if (!cached) return false;

      const stateKey = `${viewName}:${streamId}`;
      this.states.set(stateKey, {
        view: cached.state,
        highWaterMark: cached.highWaterMark,
      });
      this.lastSnapshotHwm.set(stateKey, cached.highWaterMark);
      this.evictIfNeeded();
      return true;
    }

    if (!this.snapshotStore) return false;

    const snapshot = await this.snapshotStore.load(streamId, viewName);
    if (!snapshot) return false;

    const stateKey = `${viewName}:${streamId}`;
    this.states.set(stateKey, {
      view: snapshot.view,
      highWaterMark: snapshot.highWaterMark,
    });
    this.lastSnapshotHwm.set(stateKey, snapshot.highWaterMark);
    this.evictIfNeeded();
    return true;
  }

  /**
   * Get the current cached view state without processing new events.
   * Returns undefined if no state has been materialized yet.
   */
  getState<T>(streamId: string, viewName: string): ViewState<T> | undefined {
    const stateKey = `${viewName}:${streamId}`;
    const state = this.states.get(stateKey);
    if (state) {
      // Refresh LRU order: delete and re-insert to move to end
      this.states.delete(stateKey);
      this.states.set(stateKey, state);
    }
    return state as ViewState<T> | undefined;
  }

  /**
   * EFF-002: enumerate every cached fold's cursor for `streamId`.
   *
   * The freshness chokepoint compares these against the stream's durable event
   * tail. Read-only — unlike {@link getState} it deliberately does NOT refresh
   * LRU order, so observing freshness cannot change eviction behaviour.
   */
  getStreamCursors(streamId: string): ProjectionCursor[] {
    const suffix = `:${streamId}`;
    const cursors: ProjectionCursor[] = [];
    for (const [key, state] of this.states) {
      if (!key.endsWith(suffix)) continue;
      cursors.push({
        viewName: key.slice(0, key.length - suffix.length),
        cursor: state.highWaterMark,
      });
    }
    return cursors;
  }

  /**
   * Return cumulative cache statistics for monitoring and diagnostics.
   *
   * `bypasses` counts calls to `materializeFiltered` (correlation-filtered
   * queries that skip the LRU cache entirely). It is reported alongside hits
   * and misses but is NOT folded into the missRate denominator — bypasses are
   * an orthogonal axis, not a cache outcome.
   */
  getCacheStats(): { hits: number; misses: number; size: number; missRate: number; bypasses: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.states.size,
      missRate: total > 0 ? this.cacheMisses / total : 0,
      bypasses: this.cacheBypasses,
    };
  }

  /**
   * Record a cache bypass (called by `materializeFiltered` in `views/tools.ts`).
   * Increments the `bypasses` counter exposed via `getCacheStats()`.
   *
   * Cache-bypass paths skip the LRU entirely, so without this counter their
   * traffic is invisible to hit/miss telemetry — `cacheHits=950, cacheMisses=50`
   * could look healthy while 5,000 filtered calls bypassed silently (PR #1447
   * DIM-2 audit finding).
   */
  recordBypass(): void {
    this.cacheBypasses++;
  }

  /**
   * Load a pre-existing view state (e.g., from a snapshot).
   */
  loadState<T>(streamId: string, viewName: string, view: T, highWaterMark: number): void {
    const stateKey = `${viewName}:${streamId}`;
    this.states.set(stateKey, { view, highWaterMark });
    this.evictIfNeeded();
  }

  /**
   * Check if a projection is registered.
   */
  hasProjection(viewName: string): boolean {
    return this.projections.has(viewName);
  }

  /**
   * Get projection by name (for snapshot recovery).
   */
  getProjection<T>(viewName: string): ViewProjection<T> | undefined {
    return this.projections.get(viewName) as ViewProjection<T> | undefined;
  }

  /**
   * Cache-bypassing fresh fold over an explicit, already-bounded event list.
   *
   * Folds `events` from `projection.init()` and returns the result WITHOUT
   * reading or writing the LRU cache (so the next cached `materialize` call
   * still sees the full unbounded roll-up). Records a bypass for telemetry.
   *
   * Used by:
   *  - correlation-filtered view queries (`materializeFiltered` in
   *    `views/tools.ts` delegates here — #1437), and
   *  - `asOf` bounded-fold reads (#1555) on both the `get` and `view`
   *    surfaces, where the caller has already trimmed the list to
   *    `events[0..N]` via `boundEvents`/`resolveAsOfEvents`.
   *
   * Centralizing the fresh fold here keeps the cache-bypass contract in ONE
   * place: a bounded read can never bleed the hwm-cached unbounded base into
   * its result, and can never contaminate the cache for later live reads.
   */
  materializeFresh<T>(viewName: string, events: readonly WorkflowEvent[]): T {
    const projection = this.getProjection<T>(viewName);
    if (!projection) {
      throw new Error(`No projection registered for view: ${viewName}`);
    }
    this.recordBypass();
    let view = projection.init();
    for (const event of events) {
      view = projection.apply(view, event);
    }
    return view;
  }

  /**
   * Evict the least recently used cache entry if the cache exceeds maxCacheEntries.
   * Uses Map insertion order: the first key is the least recently used.
   */
  private evictIfNeeded(): void {
    while (this.states.size > this.maxCacheEntries) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
      this.lastSnapshotHwm.delete(oldest);
    }
  }
}
