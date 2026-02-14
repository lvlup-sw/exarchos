import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  resetMaterializerCache,
} from './tools.js';

describe('Singleton Cache', () => {
  beforeEach(() => {
    resetMaterializerCache();
  });

  describe('cache synchronization', () => {
    it('should return same instances for same stateDir', () => {
      const mat1 = getOrCreateMaterializer('/tmp/dir-A');
      const mat2 = getOrCreateMaterializer('/tmp/dir-A');
      expect(mat1).toBe(mat2);

      const store1 = getOrCreateEventStore('/tmp/dir-A');
      const store2 = getOrCreateEventStore('/tmp/dir-A');
      expect(store1).toBe(store2);
    });

    it('should create new instances when stateDir changes', () => {
      const matA = getOrCreateMaterializer('/tmp/dir-A');
      const matB = getOrCreateMaterializer('/tmp/dir-B');
      expect(matA).not.toBe(matB);

      const storeA = getOrCreateEventStore('/tmp/dir-A');
      const storeB = getOrCreateEventStore('/tmp/dir-B');
      expect(storeA).not.toBe(storeB);
    });

    it('should invalidate EventStore cache when Materializer stateDir changes', () => {
      // Step 1: Populate both caches with dir-A
      const matA = getOrCreateMaterializer('/tmp/dir-A');
      const storeA = getOrCreateEventStore('/tmp/dir-A');

      // Step 2: Change stateDir via materializer
      const matB = getOrCreateMaterializer('/tmp/dir-B');
      expect(matB).not.toBe(matA);

      // Step 3: EventStore should NOT return dir-A's instance
      // BUG: Before fix, cachedStateDir === "dir-B" but cachedEventStore
      // still points to dir-A's EventStore, so it returns the stale instance.
      const storeB = getOrCreateEventStore('/tmp/dir-B');
      expect(storeB).not.toBe(storeA);
    });

    it('should invalidate Materializer cache when EventStore stateDir changes', () => {
      // Step 1: Populate both caches with dir-A
      const matA = getOrCreateMaterializer('/tmp/dir-A');
      const storeA = getOrCreateEventStore('/tmp/dir-A');

      // Step 2: Change stateDir via event store
      const storeB = getOrCreateEventStore('/tmp/dir-B');
      expect(storeB).not.toBe(storeA);

      // Step 3: Materializer should NOT return dir-A's instance
      const matB = getOrCreateMaterializer('/tmp/dir-B');
      expect(matB).not.toBe(matA);
    });
  });
});
