import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer, type ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

/** Simple counter projection for testing. */
const counterProjection: ViewProjection<number> = {
  init: () => 0,
  apply: (view: number, _event: WorkflowEvent) => view + 1,
};

/** Create a minimal WorkflowEvent with a given sequence number. */
function makeEvent(sequence: number, streamId = 'stream-1'): WorkflowEvent {
  return {
    streamId,
    sequence,
    timestamp: new Date().toISOString(),
    type: 'workflow.started',
    schemaVersion: '1.0',
    data: {},
  } as WorkflowEvent;
}

// ─── LRU Eviction Tests ───────────────────────────────────────────────────

describe('ViewMaterializer LRU Eviction', () => {
  const VIEW_NAME = 'counter';

  describe('materialize_ExceedsMaxCacheSize_EvictsLeastRecentlyUsed', () => {
    it('should evict the least recently used entry when cache exceeds maxCacheEntries', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 3 });
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize 4 different streams — cache limit is 3
      materializer.materialize('stream-a', VIEW_NAME, [makeEvent(1, 'stream-a')]);
      materializer.materialize('stream-b', VIEW_NAME, [makeEvent(1, 'stream-b')]);
      materializer.materialize('stream-c', VIEW_NAME, [makeEvent(1, 'stream-c')]);
      materializer.materialize('stream-d', VIEW_NAME, [makeEvent(1, 'stream-d')]);

      // stream-a should have been evicted (LRU — first inserted, never re-accessed)
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeUndefined();

      // stream-b, stream-c, stream-d should still be present
      expect(materializer.getState('stream-b', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-d', VIEW_NAME)).toBeDefined();
    });
  });

  describe('materialize_WithinMaxCacheSize_KeepsAllEntries', () => {
    it('should keep all entries when cache is within maxCacheEntries limit', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 5 });
      materializer.register(VIEW_NAME, counterProjection);

      materializer.materialize('stream-a', VIEW_NAME, [makeEvent(1, 'stream-a')]);
      materializer.materialize('stream-b', VIEW_NAME, [makeEvent(1, 'stream-b')]);
      materializer.materialize('stream-c', VIEW_NAME, [makeEvent(1, 'stream-c')]);

      // All 3 should be present (cache limit is 5)
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-b', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeDefined();
    });
  });

  describe('materialize_AfterEviction_ReinitializesFromProjection', () => {
    it('should rebuild view from scratch when re-materializing an evicted entry', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 2 });
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize stream-a with 2 events (counter = 2)
      materializer.materialize('stream-a', VIEW_NAME, [
        makeEvent(1, 'stream-a'),
        makeEvent(2, 'stream-a'),
      ]);

      // Fill cache to evict stream-a
      materializer.materialize('stream-b', VIEW_NAME, [makeEvent(1, 'stream-b')]);
      materializer.materialize('stream-c', VIEW_NAME, [makeEvent(1, 'stream-c')]);

      // stream-a should be evicted
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeUndefined();

      // Re-materialize stream-a with same events — should rebuild from init()
      const result = materializer.materialize<number>('stream-a', VIEW_NAME, [
        makeEvent(1, 'stream-a'),
        makeEvent(2, 'stream-a'),
      ]);

      // Counter should be 2 (rebuilt from scratch: init=0, +1, +1)
      expect(result).toBe(2);
      expect(materializer.getState<number>('stream-a', VIEW_NAME)?.view).toBe(2);
    });
  });

  describe('materialize_AccessRefreshesLRUOrder', () => {
    it('should evict the correct entry based on LRU order after access refresh', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 3 });
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize A, B, C (in that insertion order)
      materializer.materialize('stream-a', VIEW_NAME, [makeEvent(1, 'stream-a')]);
      materializer.materialize('stream-b', VIEW_NAME, [makeEvent(1, 'stream-b')]);
      materializer.materialize('stream-c', VIEW_NAME, [makeEvent(1, 'stream-c')]);

      // Re-access A by materializing with a new event — this should move A to most-recent
      materializer.materialize('stream-a', VIEW_NAME, [
        makeEvent(1, 'stream-a'),
        makeEvent(2, 'stream-a'),
      ]);

      // Now add D — should evict B (the actual LRU), not A
      materializer.materialize('stream-d', VIEW_NAME, [makeEvent(1, 'stream-d')]);

      // B should be evicted (LRU after A was refreshed)
      expect(materializer.getState('stream-b', VIEW_NAME)).toBeUndefined();

      // A, C, D should still be present
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-d', VIEW_NAME)).toBeDefined();
    });
  });

  describe('getState_AccessRefreshesLRUOrder', () => {
    it('should refresh LRU order when getState is called', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 3 });
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize A, B, C
      materializer.materialize('stream-a', VIEW_NAME, [makeEvent(1, 'stream-a')]);
      materializer.materialize('stream-b', VIEW_NAME, [makeEvent(1, 'stream-b')]);
      materializer.materialize('stream-c', VIEW_NAME, [makeEvent(1, 'stream-c')]);

      // Read A via getState — should refresh its LRU position
      materializer.getState('stream-a', VIEW_NAME);

      // Add D — should evict B (not A, since A was just accessed)
      materializer.materialize('stream-d', VIEW_NAME, [makeEvent(1, 'stream-d')]);

      expect(materializer.getState('stream-b', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-d', VIEW_NAME)).toBeDefined();
    });
  });

  describe('loadState_ExceedsCacheCap_EvictsToWithinLimit', () => {
    it('should evict entries when loadState exceeds cache cap', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 2 });
      materializer.register(VIEW_NAME, counterProjection);

      // Load 4 states via loadState — cache limit is 2
      materializer.loadState('stream-a', VIEW_NAME, 1, 1);
      materializer.loadState('stream-b', VIEW_NAME, 2, 1);
      materializer.loadState('stream-c', VIEW_NAME, 3, 1);
      materializer.loadState('stream-d', VIEW_NAME, 4, 1);

      // Only 2 entries should remain (the most recently loaded)
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-b', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-d', VIEW_NAME)).toBeDefined();
    });
  });

  describe('loadFromSnapshot_ExceedsCacheCap_EvictsToWithinLimit', () => {
    it('should evict entries when loadFromSnapshot exceeds cache cap', async () => {
      const mockSnapshotStore = {
        save: async () => {},
        load: async (_streamId: string, _viewName: string) => ({
          view: 42,
          highWaterMark: 10,
        }),
        delete: async () => {},
      };
      const materializer = new ViewMaterializer({
        maxCacheEntries: 2,
        snapshotStore: mockSnapshotStore,
      });
      materializer.register(VIEW_NAME, counterProjection);

      // Load 3 snapshots — cache limit is 2
      await materializer.loadFromSnapshot('stream-a', VIEW_NAME);
      await materializer.loadFromSnapshot('stream-b', VIEW_NAME);
      await materializer.loadFromSnapshot('stream-c', VIEW_NAME);

      // Only 2 entries should remain
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-b', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeDefined();
    });
  });

  describe('evictIfNeeded_DrainsMultipleExcessEntries', () => {
    it('should drain all excess entries with while loop, not just one', () => {
      const materializer = new ViewMaterializer({ maxCacheEntries: 2 });
      materializer.register(VIEW_NAME, counterProjection);

      // Pre-load 4 entries via loadState (bypasses eviction in current code)
      materializer.loadState('stream-a', VIEW_NAME, 1, 1);
      materializer.loadState('stream-b', VIEW_NAME, 2, 1);
      materializer.loadState('stream-c', VIEW_NAME, 3, 1);
      materializer.loadState('stream-d', VIEW_NAME, 4, 1);

      // Now materialize a 5th — this triggers evictIfNeeded via materialize
      // With an `if` (single eviction), cache would still be 4 after removing 1 = 4
      // With a `while` loop, it should drain down to maxCacheEntries = 2
      materializer.materialize('stream-e', VIEW_NAME, [makeEvent(1, 'stream-e')]);

      // Only the 2 most recent should remain: stream-d (LRU refreshed last via loadState)
      // and stream-e (just materialized). All others should be evicted.
      expect(materializer.getState('stream-a', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-b', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-c', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-d', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-e', VIEW_NAME)).toBeDefined();
    });
  });

  describe('materialize_DefaultMaxCacheEntries_Is100', () => {
    it('should default to 100 max cache entries when not specified', () => {
      const materializer = new ViewMaterializer();
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize 101 streams — cache limit should be 100
      for (let i = 1; i <= 101; i++) {
        materializer.materialize(`stream-${i}`, VIEW_NAME, [
          makeEvent(1, `stream-${i}`),
        ]);
      }

      // stream-1 should have been evicted (LRU) when stream-101 was added
      expect(materializer.getState('stream-1', VIEW_NAME)).toBeUndefined();

      // stream-2 through stream-101 should still be present
      expect(materializer.getState('stream-2', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-101', VIEW_NAME)).toBeDefined();
    });
  });
});

// ─── T29-T30: Configurable LRU Cache via Env Var ────────────────────────────

describe('ViewMaterializer Configurable Cache', () => {
  const VIEW_NAME = 'counter';

  it('ViewMaterializer_RespectsEnvVar_MaxCacheEntries', () => {
    process.env.EXARCHOS_MAX_CACHE_ENTRIES = '5';
    try {
      const materializer = new ViewMaterializer();
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize 6 streams — cache limit should be 5
      for (let i = 1; i <= 6; i++) {
        materializer.materialize(`stream-${i}`, VIEW_NAME, [
          makeEvent(1, `stream-${i}`),
        ]);
      }

      // stream-1 should have been evicted
      expect(materializer.getState('stream-1', VIEW_NAME)).toBeUndefined();

      // stream-2 through stream-6 should still be present
      expect(materializer.getState('stream-2', VIEW_NAME)).toBeDefined();
      expect(materializer.getState('stream-6', VIEW_NAME)).toBeDefined();
    } finally {
      delete process.env.EXARCHOS_MAX_CACHE_ENTRIES;
    }
  });

  it('ViewMaterializer_DefaultsTo100_WhenNoEnvVar', () => {
    delete process.env.EXARCHOS_MAX_CACHE_ENTRIES;
    const materializer = new ViewMaterializer();
    materializer.register(VIEW_NAME, counterProjection);

    // Materialize 101 streams — cache limit should be 100 (default)
    for (let i = 1; i <= 101; i++) {
      materializer.materialize(`stream-${i}`, VIEW_NAME, [
        makeEvent(1, `stream-${i}`),
      ]);
    }

    // stream-1 should be evicted at 100 limit
    expect(materializer.getState('stream-1', VIEW_NAME)).toBeUndefined();
    expect(materializer.getState('stream-2', VIEW_NAME)).toBeDefined();
    expect(materializer.getState('stream-101', VIEW_NAME)).toBeDefined();
  });

  it('ViewMaterializer_InvalidEnvVar_FallsBackToDefault', () => {
    process.env.EXARCHOS_MAX_CACHE_ENTRIES = 'abc';
    try {
      const materializer = new ViewMaterializer();
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize 101 streams — should use default 100
      for (let i = 1; i <= 101; i++) {
        materializer.materialize(`stream-${i}`, VIEW_NAME, [
          makeEvent(1, `stream-${i}`),
        ]);
      }

      // stream-1 evicted at default 100 limit
      expect(materializer.getState('stream-1', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-2', VIEW_NAME)).toBeDefined();
    } finally {
      delete process.env.EXARCHOS_MAX_CACHE_ENTRIES;
    }
  });

  it('ViewMaterializer_ZeroEnvVar_FallsBackToDefault', () => {
    process.env.EXARCHOS_MAX_CACHE_ENTRIES = '0';
    try {
      const materializer = new ViewMaterializer();
      materializer.register(VIEW_NAME, counterProjection);

      // Materialize 101 streams — should use default 100
      for (let i = 1; i <= 101; i++) {
        materializer.materialize(`stream-${i}`, VIEW_NAME, [
          makeEvent(1, `stream-${i}`),
        ]);
      }

      // stream-1 evicted at default 100 limit
      expect(materializer.getState('stream-1', VIEW_NAME)).toBeUndefined();
      expect(materializer.getState('stream-2', VIEW_NAME)).toBeDefined();
    } finally {
      delete process.env.EXARCHOS_MAX_CACHE_ENTRIES;
    }
  });
});
