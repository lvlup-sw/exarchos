// ─── Prune Safeguards Tests ─────────────────────────────────────────────────
//
// Tests that defaultSafeguards().hasOpenPR uses VcsProvider.listPrs().

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrSummary, PrFilter } from '../vcs/provider.js';
import { defaultSafeguards } from './prune-safeguards.js';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  listPrs?: PrSummary[];
  listPrsError?: Error;
} = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: overrides.listPrsError
      ? vi.fn().mockRejectedValue(overrides.listPrsError)
      : vi.fn<(filter?: PrFilter) => Promise<PrSummary[]>>().mockResolvedValue(overrides.listPrs ?? []),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

describe('defaultSafeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasOpenPR', () => {
    it('hasOpenPR_WithOpenPR_ReturnsTrue', async () => {
      const provider = createMockProvider({
        listPrs: [
          { number: 42, url: '', title: 'Test PR', headRefName: 'feat/test', baseRefName: 'main', state: 'OPEN' },
        ],
      });

      const safeguards = defaultSafeguards(provider);
      const result = await safeguards.hasOpenPR('test-feature', 'feat/test');

      expect(result).toBe(true);
      expect(provider.listPrs).toHaveBeenCalledWith({ head: 'feat/test', state: 'open' });
    });

    it('hasOpenPR_NoOpenPR_ReturnsFalse', async () => {
      const provider = createMockProvider({ listPrs: [] });

      const safeguards = defaultSafeguards(provider);
      const result = await safeguards.hasOpenPR('test-feature', 'feat/test');

      expect(result).toBe(false);
    });

    it('hasOpenPR_ProviderError_ReturnsFalse', async () => {
      const provider = createMockProvider({
        listPrsError: new Error('gh not found'),
      });

      const safeguards = defaultSafeguards(provider);
      const result = await safeguards.hasOpenPR('test-feature', 'feat/test');

      expect(result).toBe(false);
    });

    it('hasOpenPR_UndefinedBranch_ReturnsFalse', async () => {
      const provider = createMockProvider();

      const safeguards = defaultSafeguards(provider);
      const result = await safeguards.hasOpenPR('test-feature', undefined);

      expect(result).toBe(false);
      expect(provider.listPrs).not.toHaveBeenCalled();
    });

    it('hasOpenPR_UnsafeBranchName_ReturnsFalse', async () => {
      const provider = createMockProvider();

      const safeguards = defaultSafeguards(provider);
      const result = await safeguards.hasOpenPR('test-feature', 'branch; rm -rf /');

      expect(result).toBe(false);
      expect(provider.listPrs).not.toHaveBeenCalled();
    });
  });
});
