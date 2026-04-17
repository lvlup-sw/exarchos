import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleCreateIssue } from './create-issue.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn().mockResolvedValue({ number: 123, url: 'https://github.com/repo/issues/123' }),
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

describe('handleCreateIssue', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockReturnValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleCreateIssue_ValidArgs_CallsProviderCreateIssue', async () => {
    const args = { title: 'Bug: crash on load', body: 'Steps to reproduce...' };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug: crash on load',
      body: 'Steps to reproduce...',
      labels: undefined,
    });
  });

  it('handleCreateIssue_Success_ReturnsSuccessWithData', async () => {
    const args = { title: 'Bug: crash', body: 'Details' };

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ number: 123, url: 'https://github.com/repo/issues/123' });
  });

  it('handleCreateIssue_WithLabels_PassedToProvider', async () => {
    const args = { title: 'Bug', body: 'Details', labels: ['bug', 'priority-high'] };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug',
      body: 'Details',
      labels: ['bug', 'priority-high'],
    });
  });

  it('handleCreateIssue_Success_EmitsIssueCreatedEvent', async () => {
    const args = { title: 'Bug', body: 'Details' };

    await handleCreateIssue(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'issue.created',
      data: {
        provider: 'github',
        issueNumber: 123,
        url: 'https://github.com/repo/issues/123',
      },
    });
  });

  it('handleCreateIssue_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.createIssue).mockRejectedValue(new Error('Rate limited'));

    const args = { title: 'Bug', body: 'Details' };

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Rate limited');
  });
});
