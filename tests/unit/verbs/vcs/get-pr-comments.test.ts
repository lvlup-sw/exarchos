import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrComment } from '../../../../src/vcs/provider.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleGetPrComments } from '../../../../src/verbs/vcs/get-pr-comments.js';

const sampleComments: PrComment[] = [
  { id: 1, author: 'alice', body: 'LGTM', createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, author: 'bob', body: 'Needs changes', createdAt: '2026-01-02T00:00:00Z', path: 'src/main.ts', line: 42 },
];

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn().mockResolvedValue(sampleComments),
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

describe('handleGetPrComments', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleGetPrComments_ValidPrId_CallsProviderGetPrComments', async () => {
    const args = { prId: '42' };

    await handleGetPrComments(args, ctx);

    expect(mockProvider.getPrComments).toHaveBeenCalledWith('42');
  });

  /**
   * The handler returns a `{ comments, page }` window. Both fixture comments fit
   * the default window, newest first, so no page remains and no notice shows.
   */
  it('handleGetPrComments_ValidPrId_ReturnsSuccessWithComments', async () => {
    const args = { prId: '42' };

    const result = await handleGetPrComments(args, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { comments: unknown[]; page: unknown; notice?: string };
    expect(data.comments).toEqual([sampleComments[1], sampleComments[0]]);
    expect(data.page).toEqual({ total: 2, offset: 0, limit: 20, hasMore: false });
    expect(data.notice).toBeUndefined();
    expect(result.next_actions).toBeUndefined();
  });

  /**
   * A provider with `getPrCommentsPage` gets the limit, offset and fields
   * unchanged, and the handler does not read the full feed. When more pages
   * remain, the next-page command keeps `--fields`. Without `--fields`, page 2
   * returns full comments.
   */
  it('handleGetPrComments_ThreadsWindowOpts_ToProvider', async () => {
    const page = {
      comments: [{ id: 5, author: 'z' }],
      page: { total: 3, offset: 0, limit: 2, hasMore: true },
      notice: 'Showing 1 of 3 comments (newest first).',
    };
    const getPrCommentsPage = vi.fn().mockResolvedValue(page);
    mockProvider = makeMockProvider({ getPrCommentsPage });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const result = await handleGetPrComments(
      { prId: '42', limit: 2, offset: 0, fields: ['id', 'author'] },
      ctx,
    );

    expect(getPrCommentsPage).toHaveBeenCalledWith('42', {
      limit: 2,
      offset: 0,
      fields: ['id', 'author'],
    });
    expect(mockProvider.getPrComments).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(page);
    expect(result.next_actions).toHaveLength(1);
    expect(result.next_actions?.[0]?.verb).toBe('get_pr_comments');
    expect(result.next_actions?.[0]?.hint).toBe(
      'get_pr_comments --pr 42 --offset 2 --limit 2 --fields id,author',
    );
  });

  /** Without a field list in the request, the next-page command has no `--fields`. */
  it('handleGetPrComments_NoFields_OmitsFieldsFromContinuation', async () => {
    const page = {
      comments: [{ id: 5, author: 'z', body: 'b', createdAt: 't', source: 'issue-comment' }],
      page: { total: 3, offset: 0, limit: 2, hasMore: true },
    };
    const getPrCommentsPage = vi.fn().mockResolvedValue(page);
    mockProvider = makeMockProvider({ getPrCommentsPage });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const result = await handleGetPrComments({ prId: '42', limit: 2 }, ctx);

    expect(result.next_actions?.[0]?.hint).toBe(
      'get_pr_comments --pr 42 --offset 2 --limit 2',
    );
  });

  it('handleGetPrComments_ReadOnly_DoesNotEmitEvent', async () => {
    const args = { prId: '42' };

    await handleGetPrComments(args, ctx);

    expect(ctx.eventStore.append).not.toHaveBeenCalled();
  });

  it('handleGetPrComments_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.getPrComments).mockRejectedValue(new Error('PR not found'));

    const args = { prId: '999' };

    const result = await handleGetPrComments(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('PR not found');
  });
});
