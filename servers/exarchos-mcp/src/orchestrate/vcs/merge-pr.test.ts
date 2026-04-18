import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleMergePr } from './merge-pr.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn().mockResolvedValue({ merged: true, sha: 'abc123' }),
    addComment: vi.fn(),
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
      append: vi.fn().mockResolvedValue({ sequence: 1, type: 'pr.merged', timestamp: new Date().toISOString() }),
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleMergePr', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleMergePr_SquashStrategy_CallsProviderMergePr', async () => {
    const args = { prId: '42', strategy: 'squash' as const };

    await handleMergePr(args, ctx);

    expect(mockProvider.mergePr).toHaveBeenCalledWith('42', 'squash');
  });

  it('handleMergePr_Success_ReturnsSuccessWithData', async () => {
    const args = { prId: '42', strategy: 'squash' as const };

    const result = await handleMergePr(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ merged: true, sha: 'abc123' });
  });

  it('handleMergePr_RebaseStrategy_PassedToProvider', async () => {
    const args = { prId: '99', strategy: 'rebase' as const };

    await handleMergePr(args, ctx);

    expect(mockProvider.mergePr).toHaveBeenCalledWith('99', 'rebase');
  });

  it('handleMergePr_Success_EmitsPrMergedEvent', async () => {
    const args = { prId: '42', strategy: 'squash' as const };

    await handleMergePr(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'pr.merged',
      data: {
        provider: 'github',
        prId: '42',
        strategy: 'squash',
        merged: true,
        sha: 'abc123',
      },
    });
  });

  it('handleMergePr_MergeFailed_ReturnsSuccessWithUnmergedData', async () => {
    vi.mocked(mockProvider.mergePr).mockResolvedValue({ merged: false, error: 'Conflicts' });

    const args = { prId: '42', strategy: 'merge' as const };

    const result = await handleMergePr(args, ctx);

    // Still success (the operation completed), but merged=false
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ merged: false, error: 'Conflicts' });
  });

  it('handleMergePr_MergeFailed_DoesNotEmitEvent', async () => {
    vi.mocked(mockProvider.mergePr).mockResolvedValue({ merged: false, error: 'Conflicts' });

    const args = { prId: '42', strategy: 'merge' as const };

    await handleMergePr(args, ctx);

    expect(ctx.eventStore.append).not.toHaveBeenCalled();
  });

  it('handleMergePr_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.mergePr).mockRejectedValue(new Error('API timeout'));

    const args = { prId: '42', strategy: 'squash' as const };

    const result = await handleMergePr(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('API timeout');
  });
});
