import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrSummary } from '../../vcs/provider.js';
import type { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleListPrs, LIST_PRS_DEFAULT_LIMIT } from './list-prs.js';

const samplePrs: PrSummary[] = [
  { number: 1, url: 'https://github.com/repo/pull/1', title: 'feat: one', headRefName: 'feat/one', baseRefName: 'main', state: 'open' },
  { number: 2, url: 'https://github.com/repo/pull/2', title: 'feat: two', headRefName: 'feat/two', baseRefName: 'main', state: 'open' },
];

function makePr(n: number): PrSummary {
  return {
    number: n,
    url: `https://github.com/repo/pull/${n}`,
    title: `feat: pr ${n}`,
    headRefName: `feat/pr-${n}`,
    baseRefName: 'main',
    state: 'open',
  };
}

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
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
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
    // DR-3: the shim now returns a windowed `{ prs, page }` shape, newest-first
    // by PR number. Both sample PRs fit the default window (nothing remains).
    const data = result.data as { prs: PrSummary[]; page: unknown };
    expect(data.prs).toEqual([samplePrs[1], samplePrs[0]]);
    expect(data.page).toEqual({
      total: 2,
      offset: 0,
      limit: LIST_PRS_DEFAULT_LIMIT,
      hasMore: false,
    });
    expect(result.next_actions).toBeUndefined();
  });

  it('listPrs_NoLimit_ReturnsDefaultWindow', async () => {
    // 30 open PRs, no narrowing filter → default window caps at the newest 20
    // with page metadata + a narrow affordance steering to a filter.
    const many = Array.from({ length: 30 }, (_, i) => makePr(i + 1));
    vi.mocked(mockProvider.listPrs).mockResolvedValue(many);

    const result = await handleListPrs({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { prs: PrSummary[]; page: { total: number; offset: number; limit: number; hasMore: boolean } };
    expect(data.prs).toHaveLength(LIST_PRS_DEFAULT_LIMIT);
    expect(data.page).toEqual({
      total: 30,
      offset: 0,
      limit: LIST_PRS_DEFAULT_LIMIT,
      hasMore: true,
    });
    // Newest-first: PR #30 leads, #11 is the last of the window (#10..#1 hidden).
    expect(data.prs[0]?.number).toBe(30);
    expect(data.prs[LIST_PRS_DEFAULT_LIMIT - 1]?.number).toBe(11);
    expect(result.next_actions).toHaveLength(1);
    expect(result.next_actions?.[0]?.verb).toBe('list_prs');
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
