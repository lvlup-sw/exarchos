import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

// Mock the factory before importing the handler
vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleCreatePr } from './create-pr.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ url: 'https://github.com/repo/pull/42', number: 42 }),
    checkCi: vi.fn(),
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

function makeMockCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1, type: 'pr.created', timestamp: new Date().toISOString() }),
    } as unknown as EventStore,
    enableTelemetry: false,
    ...overrides,
  };
}

describe('handleCreatePr', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockReturnValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleCreatePr_ValidArgs_CallsProviderCreatePr', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Implements VCS MCP actions',
      base: 'main',
      head: 'feature/vcs-actions',
    };

    await handleCreatePr(args, ctx);

    expect(mockProvider.createPr).toHaveBeenCalledWith({
      title: 'feat: add VCS actions',
      body: 'Implements VCS MCP actions',
      baseBranch: 'main',
      headBranch: 'feature/vcs-actions',
      draft: undefined,
      labels: undefined,
    });
  });

  it('handleCreatePr_ValidArgs_ReturnsSuccessWithData', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Implements VCS MCP actions',
      base: 'main',
      head: 'feature/vcs-actions',
    };

    const result = await handleCreatePr(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ url: 'https://github.com/repo/pull/42', number: 42 });
  });

  it('handleCreatePr_DraftAndLabels_PassedToProvider', async () => {
    const args = {
      title: 'feat: WIP',
      body: 'Draft PR',
      base: 'main',
      head: 'feature/wip',
      draft: true,
      labels: ['enhancement', 'wip'],
    };

    await handleCreatePr(args, ctx);

    expect(mockProvider.createPr).toHaveBeenCalledWith({
      title: 'feat: WIP',
      body: 'Draft PR',
      baseBranch: 'main',
      headBranch: 'feature/wip',
      draft: true,
      labels: ['enhancement', 'wip'],
    });
  });

  it('handleCreatePr_Success_EmitsPrCreatedEvent', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Body',
      base: 'main',
      head: 'feature/vcs',
    };

    await handleCreatePr(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'pr.created',
      data: {
        provider: 'github',
        prNumber: 42,
        url: 'https://github.com/repo/pull/42',
        base: 'main',
        head: 'feature/vcs',
      },
    });
  });

  it('handleCreatePr_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.createPr).mockRejectedValue(new Error('Network error'));

    const args = {
      title: 'feat: broken',
      body: 'Body',
      base: 'main',
      head: 'feature/broken',
    };

    const result = await handleCreatePr(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Network error');
  });
});
