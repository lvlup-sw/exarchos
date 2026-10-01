import type { WorkflowEvent } from '../../events/schemas.js';
import type { SnapshotStore } from './snapshot-store.js';
import type { StorageBackend } from '../../storage/backend.js';
import { viewLogger } from '../../logger.js';
import type { ProjectionCursor } from '../freshness.js';

export interface ViewProjection<T> {
  /** Create the initial/default view state. */
  init(): T;
  /** Apply a single event to the current view state, returning the new state. */
  apply(view: T, event: WorkflowEvent): T;
}

interface ViewState<T = unknown> {
  readonly view: T;
  readonly highWaterMark: number;
}

export interface MaterializerOptions {
  readonly snapshotStore?: SnapshotStore;
  readonly snapshotInterval?: number;
  readonly maxCacheEntries?: number;
  readonly backend?: StorageBackend;
  /** Size of the sliding window for thrashing detection (default: 100). */
  readonly thrashingWindowSize?: number;
}

const DEFAULT_SNAPSHOT_INTERVAL = 50;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const DEFAULT_THRASHING_WINDOW_SIZE = 100;

/**
 * True for a `__`-prefixed sentinel stream, such as `__migration__`, where the event store writes progress events.
 * `SnapshotStore` accepts only ids that match `/^[a-z0-9-]+$/`, so a sentinel id that reaches it crashes the view.
 * The materializer skips sentinel streams and keeps that strict id pattern, which stops a snapshot file name such as `..`.
 */
export const isInternalSentinelStream = (id: string): boolean => id.startsWith('__');

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

export class ViewMaterializer {
  private readonly projections = new Map<string, ViewProjection<unknown>>();
  /** Cached view states, keyed by `${viewName}:${streamId}`. The first key in map order is the least recently used. */
  private readonly states = new Map<string, ViewState>();
  /** The high-water mark of the last snapshot for each key. */
  private readonly lastSnapshotHwm = new Map<string, number>();

  private readonly snapshotStore?: SnapshotStore | undefined;
  private readonly snapshotInterval: number;
  private readonly maxCacheEntries: number;
  private readonly backend?: StorageBackend | undefined;

  /** Snapshot writes in progress. Materialization does not wait for them, but `flush` does. */
  private pendingSnapshots: Promise<void>[] = [];

  private cacheHits = 0;
  private cacheMisses = 0;
  /** Count of `materializeFresh` calls, which skip the LRU cache. It is kept apart from hits and misses, so a good hit rate cannot hide bypass traffic. */
  private cacheBypasses = 0;

  /** Lookups per thrashing check. The materializer logs a warning when more than half of the lookups in one window miss. */
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
    return this.materializeAt<T>(streamId, viewName, events).view;
  }

  /**
   * Materializes a view and returns the fold with the sequence it covers.
   * The pair keeps a fold and the evidence of its coverage together, and `projections/fold-at-tail.ts` turns the pair into a guarantee.
   * A sentinel stream returns `projection.init()` at sequence 0, with no cache entry and no snapshot.
   *
   * The fold applies only the events past the high-water mark of the cached state.
   * The caller must pass events in sequence order, because the last new event sets the high-water mark.
   * When the high-water mark moves `snapshotInterval` past the last snapshot, the materializer saves to the backend view cache.
   * With no backend, it starts a snapshot write and does not wait for it.
   */
  materializeAt<T>(
    streamId: string,
    viewName: string,
    events: WorkflowEvent[],
  ): { view: T; sequence: number } {
    const projection = this.projections.get(viewName);
    if (!projection) {
      throw new Error(`No projection registered for view: ${viewName}`);
    }

    if (isInternalSentinelStream(streamId)) {
      viewLogger.debug(
        { streamId, viewName },
        'ViewMaterializer: skipping sentinel stream',
      );
      return { view: projection.init() as T, sequence: 0 };
    }

    const stateKey = `${viewName}:${streamId}`;
    let state = this.states.get(stateKey) as ViewState<T> | undefined;

    if (state) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
      this.recentMisses++;
    }
    this.recentTotal++;

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

    const newEvents = events.filter((e) => e.sequence > state!.highWaterMark);

    let currentView = state.view;
    for (const event of newEvents) {
      currentView = projection.apply(currentView, event) as T;
    }

    const maxSequence =
      newEvents.length > 0
        ? (newEvents[newEvents.length - 1]?.sequence ?? state.highWaterMark)
        : state.highWaterMark;

    const updatedState: ViewState<T> = {
      view: currentView,
      highWaterMark: maxSequence,
    };

    this.states.delete(stateKey);
    this.states.set(stateKey, updatedState as ViewState);

    this.evictIfNeeded();

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
          const savePromise = this.snapshotStore.save(streamId, viewName, currentView, maxSequence).catch((err) => {
            viewLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Snapshot save failed');
          });
          this.pendingSnapshots.push(savePromise);
        }
      }
    }

    return { view: currentView, sequence: maxSequence };
  }

  /**
   * Await all pending snapshot writes. Useful for tests and graceful shutdown.
   */
  async flush(): Promise<void> {
    await Promise.all(this.pendingSnapshots);
    this.pendingSnapshots = [];
  }

  /**
   * Loads view state from the backend view cache, or from the snapshot store when there is no backend.
   * Returns false when nothing loads. A sentinel stream returns false and reads nothing.
   */
  async loadFromSnapshot(streamId: string, viewName: string): Promise<boolean> {
    if (isInternalSentinelStream(streamId)) {
      viewLogger.debug(
        { streamId, viewName },
        'ViewMaterializer: skipping snapshot load for sentinel stream',
      );
      return false;
    }
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
   * Returns the cached view state without new events, or `undefined` when the cache has no entry.
   * A read moves the entry to the most recently used position.
   */
  getState<T>(streamId: string, viewName: string): ViewState<T> | undefined {
    const stateKey = `${viewName}:${streamId}`;
    const state = this.states.get(stateKey);
    if (state) {
      this.states.delete(stateKey);
      this.states.set(stateKey, state);
    }
    return state as ViewState<T> | undefined;
  }

  /**
   * Returns the cursor of each cached fold for `streamId`. The freshness check compares them with the durable event tail.
   * Unlike {@link getState}, it does not change the LRU order, so a freshness read cannot change eviction.
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
   * Returns cumulative cache statistics.
   * `bypasses` counts the `materializeFresh` calls, which skip the LRU cache. It is not part of the `missRate` denominator.
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

  /** Adds 1 to the `bypasses` count of `getCacheStats`. `materializeFresh` calls it. */
  recordBypass(): void {
    this.cacheBypasses++;
  }

  /**
   * Drops the cached fold of one stream for `viewName`. This is the repair for the `projection-ahead` case.
   * A fold with a cursor past the durable tail holds events that the log does not have.
   * `materialize` cannot repair it, because its high-water-mark filter discards every event at or below that cursor.
   * After the drop, the next fold replays the full log.
   */
  discardFold(streamId: string, viewName: string): void {
    const stateKey = `${viewName}:${streamId}`;
    this.states.delete(stateKey);
    this.lastSnapshotHwm.delete(stateKey);
  }

  /**
   * Loads a view state from outside the materializer, such as a snapshot.
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
   * Folds `events` from `projection.init()` and records a bypass. It does not read or write the LRU cache.
   * `materializeFiltered` uses it for correlation-filtered queries.
   * `asOf` reads use it after `resolveAsOfEvents` trims the event list.
   * As a result, a bounded read cannot mix the cached fold into its result, or change the cache for later live reads.
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
