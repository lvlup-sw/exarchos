import { describe, it, expect } from 'vitest';
import { createInMemoryResolver } from '../runtime/capabilities/resolver.js';
import { handleRootsListChanged } from './notifications.js';

describe('handleRootsListChanged (#1290)', () => {
  it('Notifications_RootsListChanged_InvalidatesCache', () => {
    const resolver = createInMemoryResolver([]);
    resolver.setCachedRoots([{ uri: 'file:///a' }]);
    expect(resolver.getCachedRoots()).toBeDefined();

    handleRootsListChanged(resolver);

    expect(resolver.getCachedRoots()).toBeUndefined();
  });

  it('Notifications_RootsListChangedOnColdCache_IsNoOp', () => {
    const resolver = createInMemoryResolver([]);
    // Cold cache — invalidation should be safe.
    expect(() => handleRootsListChanged(resolver)).not.toThrow();
    expect(resolver.getCachedRoots()).toBeUndefined();
  });
});
