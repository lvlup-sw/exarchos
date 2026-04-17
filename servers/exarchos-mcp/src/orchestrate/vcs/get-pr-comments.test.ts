import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrComment } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleGetPrComments } from './get-pr-comments.js';

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
    vi.mocked(createVcsProvider).mockReturnValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleGetPrComments_ValidPrId_CallsProviderGetPrComments', async () => {
    const args = { prId: '42' };

    await handleGetPrComments(args, ctx);

    expect(mockProvider.getPrComments).toHaveBeenCalledWith('42');
  });

  it('handleGetPrComments_ValidPrId_ReturnsSuccessWithComments', async () => {
    const args = { prId: '42' };

    const result = await handleGetPrComments(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(sampleComments);
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
