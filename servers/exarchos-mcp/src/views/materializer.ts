import type { WorkflowEvent } from '../event-store/schemas.js';
import type { SnapshotStore } from './snapshot-store.js';
import type { StorageBackend } from '../storage/backend.js';
import { viewLogger } from '../logger.js';

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

  private readonly snapshotStore?: SnapshotStore;
  private readonly snapshotInterval: number;
  private readonly maxCacheEntries: number;
  private readonly backend?: StorageBackend;

  // Cache hit/miss counters
  private cacheHits = 0;
  private cacheMisses = 0;

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
        ? newEvents[newEvents.length - 1].sequence
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
          // Fire and forget - snapshot is async but we don't block materialization
          this.snapshotStore.save(streamId, viewName, currentView, maxSequence).catch((err) => {
            viewLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Snapshot save failed');
          });
        }
      }
    }

    return currentView;
  }

  /**
   * Load view state from a snapshot, if one exists.
   * Falls back to default init state if snapshot is missing or corrupt.
   */
  async loadFromSnapshot(streamId: string, viewName: string): Promise<boolean> {
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
   * Return cumulative cache statistics for monitoring and diagnostics.
   */
  getCacheStats(): { hits: number; misses: number; size: number; missRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.states.size,
      missRate: total > 0 ? this.cacheMisses / total : 0,
    };
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
