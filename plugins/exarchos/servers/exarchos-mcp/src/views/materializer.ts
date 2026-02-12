import type { WorkflowEvent } from '../event-store/schemas.js';
import type { SnapshotStore } from './snapshot-store.js';

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
}

// ─── Default Snapshot Interval ─────────────────────────────────────────────

const DEFAULT_SNAPSHOT_INTERVAL = 50;
const DEFAULT_MAX_CACHE_ENTRIES = 100;

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

  constructor(options?: MaterializerOptions) {
    this.snapshotStore = options?.snapshotStore;
    this.snapshotInterval = options?.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.maxCacheEntries = options?.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  /**
   * Register a named projection.
   */
  register<T>(viewName: string, projection: ViewProjection<T>): void {
    this.projections.set(viewName, projection as ViewProjection<unknown>);
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
    const maxSequence =
      newEvents.length > 0
        ? Math.max(...newEvents.map((e) => e.sequence))
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

    // Trigger snapshot if interval crossed
    if (this.snapshotStore && newEvents.length > 0) {
      const lastSnapHwm = this.lastSnapshotHwm.get(stateKey) ?? 0;
      if (maxSequence - lastSnapHwm >= this.snapshotInterval) {
        this.lastSnapshotHwm.set(stateKey, maxSequence);
        // Fire and forget - snapshot is async but we don't block materialization
        this.snapshotStore.save(streamId, viewName, currentView, maxSequence).catch((err) => {
          console.error(`Failed to save snapshot: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    return currentView;
  }

  /**
   * Load view state from a snapshot, if one exists.
   * Falls back to default init state if snapshot is missing or corrupt.
   */
  async loadFromSnapshot(streamId: string, viewName: string): Promise<boolean> {
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
