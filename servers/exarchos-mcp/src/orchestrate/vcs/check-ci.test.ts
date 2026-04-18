import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleCheckCi } from './check-ci.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn().mockResolvedValue({
      status: 'pass',
      checks: [
        { name: 'build', status: 'pass', url: 'https://ci.example.com/1' },
        { name: 'test', status: 'pass', url: 'https://ci.example.com/2' },
      ],
    }),
    mergePr: vi.fn(),
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
      append: vi.fn(),
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleCheckCi', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleCheckCi_ValidPrId_CallsProviderCheckCi', async () => {
    const args = { prId: '42' };

    await handleCheckCi(args, ctx);

    expect(mockProvider.checkCi).toHaveBeenCalledWith('42');
  });

  it('handleCheckCi_Pass_ReturnsSuccessWithStatus', async () => {
    const args = { prId: '42' };

    const result = await handleCheckCi(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      status: 'pass',
      checks: [
        { name: 'build', status: 'pass', url: 'https://ci.example.com/1' },
        { name: 'test', status: 'pass', url: 'https://ci.example.com/2' },
      ],
    });
  });

  it('handleCheckCi_ReadOnly_DoesNotEmitEvent', async () => {
    const args = { prId: '42' };

    await handleCheckCi(args, ctx);

    expect(ctx.eventStore.append).not.toHaveBeenCalled();
  });

  it('handleCheckCi_Pending_ReturnsSuccessWithPendingStatus', async () => {
    vi.mocked(mockProvider.checkCi).mockResolvedValue({
      status: 'pending',
      checks: [{ name: 'build', status: 'pending' }],
    });

    const args = { prId: '99' };

    const result = await handleCheckCi(args, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe('pending');
  });

  it('handleCheckCi_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.checkCi).mockRejectedValue(new Error('Not found'));

    const args = { prId: '999' };

    const result = await handleCheckCi(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Not found');
  });
});
