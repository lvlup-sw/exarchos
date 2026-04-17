import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrSummary } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleListPrs } from './list-prs.js';

const samplePrs: PrSummary[] = [
  { number: 1, url: 'https://github.com/repo/pull/1', title: 'feat: one', headRefName: 'feat/one', baseRefName: 'main', state: 'open' },
  { number: 2, url: 'https://github.com/repo/pull/2', title: 'feat: two', headRefName: 'feat/two', baseRefName: 'main', state: 'open' },
];

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn().mockResolvedValue(samplePrs),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
    ...overrides,
  };
}

function makeMockCtx(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn(),
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleListPrs', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockReturnValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleListPrs_NoFilter_CallsProviderListPrs', async () => {
    const args = {};

    await handleListPrs(args, ctx);

    expect(mockProvider.listPrs).toHaveBeenCalledWith({
      state: undefined,
      head: undefined,
      base: undefined,
    });
  });

  it('handleListPrs_NoFilter_ReturnsSuccessWithData', async () => {
    const args = {};

    const result = await handleListPrs(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(samplePrs);
  });

  it('handleListPrs_WithFilter_PassesFilterToProvider', async () => {
    const args = { state: 'open' as const, head: 'feat/one', base: 'main' };

    await handleListPrs(args, ctx);

    expect(mockProvider.listPrs).toHaveBeenCalledWith({
      state: 'open',
      head: 'feat/one',
      base: 'main',
    });
  });

  it('handleListPrs_ReadOnly_DoesNotEmitEvent', async () => {
    const args = {};

    await handleListPrs(args, ctx);

    expect(ctx.eventStore.append).not.toHaveBeenCalled();
  });

  it('handleListPrs_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.listPrs).mockRejectedValue(new Error('Unauthorized'));

    const args = {};

    const result = await handleListPrs(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Unauthorized');
  });
});
