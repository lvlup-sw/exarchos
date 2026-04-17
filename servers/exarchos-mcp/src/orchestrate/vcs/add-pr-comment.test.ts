import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleAddPrComment } from './add-pr-comment.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
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
      append: vi.fn().mockResolvedValue({ sequence: 1 }),
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleAddPrComment', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockReturnValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleAddPrComment_ValidArgs_CallsProviderAddComment', async () => {
    const args = { prId: '42', body: 'Great work!' };

    await handleAddPrComment(args, ctx);

    expect(mockProvider.addComment).toHaveBeenCalledWith('42', 'Great work!');
  });

  it('handleAddPrComment_Success_ReturnsSuccessResult', async () => {
    const args = { prId: '42', body: 'LGTM' };

    const result = await handleAddPrComment(args, ctx);

    expect(result.success).toBe(true);
  });

  it('handleAddPrComment_Success_EmitsPrCommentedEvent', async () => {
    const args = { prId: '42', body: 'Review comment' };

    await handleAddPrComment(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'pr.commented',
      data: {
        provider: 'github',
        prId: '42',
      },
    });
  });

  it('handleAddPrComment_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.addComment).mockRejectedValue(new Error('Forbidden'));

    const args = { prId: '42', body: 'test' };

    const result = await handleAddPrComment(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Forbidden');
  });
});
