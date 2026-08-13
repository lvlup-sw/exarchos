import { describe, it, expect } from 'vitest';
import type {
  ProviderAdapter,
  ReviewAdapterRegistry,
  ActionItem,
} from './types.js';
import type { PrComment as VcsPrComment } from '../vcs/provider.js';

describe('review types', () => {
  it('ProviderAdapter_StubImplementation_SatisfiesInterface', () => {
    const stub: ProviderAdapter = {
      kind: 'human',
      parse(_raw: VcsPrComment): ActionItem | null {
        return null;
      },
    };
    expect(stub.kind).toBe('human');
    expect(stub.parse({
      id: 1,
      author: 'someone',
      body: '',
      createdAt: '2026-01-01',
    })).toBeNull();
  });

  it('ReviewAdapterRegistry_StubImplementation_SatisfiesInterface', () => {
    const stubAdapter: ProviderAdapter = {
      kind: 'human',
      parse(): ActionItem | null {
        return null;
      },
    };
    const registry: ReviewAdapterRegistry = {
      forReviewer(kind) {
        return kind === 'human' ? stubAdapter : undefined;
      },
      list() {
        return [stubAdapter];
      },
    };
    expect(registry.forReviewer('human')).toBe(stubAdapter);
    expect(registry.forReviewer('coderabbit')).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });
});
