import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VcsProvider, PrComment, RepoInfo } from '../../../../src/vcs/provider.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { SqliteBusyExhaustedError } from '../../../../src/storage/sqlite/errors.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleAddPrComment } from '../../../../src/verbs/vcs/add-pr-comment.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    addReply: vi.fn().mockResolvedValue({ id: 778899 }),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn().mockResolvedValue([]),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn().mockResolvedValue({ nameWithOwner: 'owner/repo', defaultBranch: 'main' } satisfies RepoInfo),
    ...overrides,
  };
}

function makeMockCtx(eventStoreOverride?: Partial<EventStore>): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1, type: 'pr.comment.requested', streamId: 'vcs', timestamp: new Date().toISOString() }),
      ...eventStoreOverride,
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleAddPrComment', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  /**
   * The first `getPrComments` call is the marker pre-check and returns no
   * comments. Later calls return one comment with the last body that
   * `addComment` posted, so the verification scan finds it.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    let getCallCount = 0;
    mockProvider = makeMockProvider({
      getPrComments: vi.fn().mockImplementation(async () => {
        getCallCount += 1;
        if (getCallCount === 1) return [];
        const calls = vi.mocked(mockProvider.addComment).mock.calls;
        const lastBody = calls.length > 0 ? (calls[calls.length - 1][1] as string) : '';
        return [{
          id: 555,
          author: 'tester',
          body: lastBody,
          createdAt: new Date().toISOString(),
        }];
      }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleAddPrComment_ValidArgs_CallsProviderAddComment', async () => {
    const args = { prId: '42', body: 'Great work!' };

    await handleAddPrComment(args, ctx);

    expect(mockProvider.addComment).toHaveBeenCalledTimes(1);
    const [calledPrId, calledBody] = vi.mocked(mockProvider.addComment).mock.calls[0];
    expect(calledPrId).toBe('42');
    expect(calledBody).toContain('Great work!');
  });

  it('handleAddPrComment_Success_ReturnsSuccessResult', async () => {
    const args = { prId: '42', body: 'LGTM' };

    const result = await handleAddPrComment(args, ctx);

    expect(result.success).toBe(true);
  });

  /**
   * With a `threadId`, the body goes through the provider-agnostic `addReply`,
   * not `addComment`.
   */
  it('handleAddPrComment_ThreadId_RoutesThroughAddReplyNotAddComment', async () => {
    const replyProvider = makeMockProvider({
      addReply: vi.fn().mockResolvedValue({ id: 778899 }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(replyProvider);
    const replyCtx = makeMockCtx();

    const result = await handleAddPrComment(
      { prId: '42', body: 'Addressed in latest push.', threadId: '201' },
      replyCtx,
    );

    expect(result.success).toBe(true);
    expect(replyProvider.addReply).toHaveBeenCalledTimes(1);
    const [calledPrId, calledThreadId, calledBody] = vi.mocked(replyProvider.addReply).mock.calls[0];
    expect(calledPrId).toBe('42');
    expect(calledThreadId).toBe('201');
    expect(calledBody).toContain('Addressed in latest push.');
    expect(replyProvider.addComment).not.toHaveBeenCalled();
  });

  /**
   * The executed event carries the id that `addReply` returns. The reply path
   * does not query the comments again after the post.
   */
  it('handleAddPrComment_ThreadId_EmitsExecutedWithReplyId', async () => {
    const replyProvider = makeMockProvider({
      addReply: vi.fn().mockResolvedValue({ id: 778899 }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(replyProvider);
    const replyCtx = makeMockCtx();

    await handleAddPrComment(
      { prId: '42', body: 'reply body', threadId: '201' },
      replyCtx,
    );

    expect(replyCtx.eventStore.append).toHaveBeenCalledWith(
      'vcs',
      expect.objectContaining({
        type: 'pr.comment.executed',
        data: expect.objectContaining({ commentId: 778899 }),
      }),
      expect.anything(),
    );
  });

  it('handleAddPrComment_ThreadId_RecordsThreadIdInRequestedIntent', async () => {
    const replyProvider = makeMockProvider({
      addReply: vi.fn().mockResolvedValue({ id: 778899 }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(replyProvider);
    const replyCtx = makeMockCtx();

    await handleAddPrComment(
      { prId: '42', body: 'reply body', threadId: '201' },
      replyCtx,
    );

    const requestedCall = vi
      .mocked(replyCtx.eventStore.append)
      .mock.calls.find((call) => (call[1] as { type: string }).type === 'pr.comment.requested');
    expect(requestedCall).toBeDefined();
    const data = (requestedCall?.[1] as { data: Record<string, unknown> }).data;
    expect(data.threadId).toBe(201);
  });

  it('handleAddPrComment_InvalidThreadId_ReturnsInvalidInput', async () => {
    const result = await handleAddPrComment(
      { prId: '42', body: 'reply', threadId: '0' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(mockProvider.addReply).not.toHaveBeenCalled();
  });

  /**
   * The intent uses the plain `append`, so the row carries the ambient dispatch
   * operation id.
   */
  it('handleAddPrComment_Success_EmitsTwoEventSequence', async () => {
    const args = { prId: '42', body: 'Review comment' };

    await handleAddPrComment(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith(
      'vcs',
      expect.objectContaining({ type: 'pr.comment.requested' }),
      expect.anything(),
    );

    expect(ctx.eventStore.append).toHaveBeenCalledWith(
      'vcs',
      expect.objectContaining({ type: 'pr.comment.executed' }),
      expect.anything(),
    );
  });

  /**
   * The post succeeds, but the verification scan finds nothing. The schema of
   * `pr.comment.executed` requires a `commentId` above 0, so the handler fails
   * and writes no sentinel. The posted marker lets a later call recover.
   */
  it('AddPrComment_PostSucceededButVerificationLookupMissed_ReturnsFailureAndDoesNotEmitExecuted', async () => {
    const failingProvider = makeMockProvider({
      getPrComments: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(failingProvider);
    const failCtx = makeMockCtx();

    const result = await handleAddPrComment({ prId: '42', body: 'verify-miss' }, failCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_VERIFICATION_FAILED');

    const appendCalls = vi.mocked(failCtx.eventStore.append).mock.calls;
    const executedAppend = appendCalls.find(
      (call) => (call[1] as { type: string }).type === 'pr.comment.executed',
    );
    expect(executedAppend).toBeUndefined();

    expect(failingProvider.addComment).toHaveBeenCalledTimes(1);
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

/**
 * `addComment` runs between the intent append and the executed append, outside
 * the retry boundary. A retried intent append must not post the comment again.
 */
describe('handleAddPrComment — B2.2 Phase-A retry non-refire', () => {
  const scratchRoots: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      scratchRoots.map((p) => rmrfAsync(p)),
    );
    scratchRoots.length = 0;
  });

  /**
   * The first intent append throws `SqliteBusyExhaustedError`, the raw class that
   * `EventStore.append` raises on contention. A `ConcurrencyError` mock skips the
   * mapping in `translateStorageError`.
   */
  it('AddPrComment_PhaseARetry_DoesNotRefireGhPrComment', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-refire-'));
    scratchRoots.push(stateDir);

    let phaseAAttempts = 0;
    const appendMock = vi.fn().mockImplementation(
      async (_streamId: string, event: { type: string }, _opts?: unknown) => {
        if (event.type === 'pr.comment.requested') {
          phaseAAttempts += 1;
          if (phaseAAttempts === 1) {
            throw new SqliteBusyExhaustedError(5, new Error('SQLITE_BUSY'));
          }
        }
        return {
          sequence: 2,
          type: event.type,
          streamId: 'vcs',
          timestamp: new Date().toISOString(),
        };
      },
    );

    const mockCtx: DispatchContext = {
      stateDir,
      eventStore: {
        append: appendMock,
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    let getCallCount = 0;
    const mockProvider = makeMockProvider({
      getPrComments: vi.fn().mockImplementation(async () => {
        getCallCount += 1;
        if (getCallCount === 1) return [];
        const calls = vi.mocked(mockProvider.addComment).mock.calls;
        const lastBody = calls.length > 0 ? (calls[calls.length - 1][1] as string) : '';
        return [{
          id: 777,
          author: 'tester',
          body: lastBody,
          createdAt: new Date().toISOString(),
        }];
      }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const result = await handleAddPrComment({ prId: '42', body: 'test body' }, mockCtx);

    expect(result.success).toBe(true);

    expect(phaseAAttempts).toBeGreaterThanOrEqual(2);

    expect(mockProvider.addComment).toHaveBeenCalledTimes(1);
  });

  /**
   * Every intent append throws `SqliteBusyExhaustedError`. The handler must try
   * the append `MAX_STATE_RETRIES` times, then return `STORAGE_BUSY`, not a
   * generic `VCS_ERROR`.
   */
  it('AddPrComment_PhaseABusyBudgetExhausted_ReturnsStorageBusyNotGenericVcsError', async () => {
    const appendMock = vi.fn().mockImplementation(
      async (_streamId: string, event: { type: string }) => {
        if (event.type === 'pr.comment.requested') {
          throw new SqliteBusyExhaustedError(5, new Error('SQLITE_BUSY'));
        }
        return { sequence: 1, type: event.type, streamId: 'vcs', timestamp: new Date().toISOString() };
      },
    );
    const mockCtx: DispatchContext = {
      stateDir: '/tmp/b2-busy-exhausted',
      eventStore: { append: appendMock } as unknown as EventStore,
      enableTelemetry: false,
    };

    const result = await handleAddPrComment({ prId: '42', body: 'busy probe' }, mockCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STORAGE_BUSY');
    expect(appendMock).toHaveBeenCalledTimes(3);
  });
});

/**
 * If `pr.comment.requested` committed but the run stopped before
 * `pr.comment.executed`, a retry with the same `operationId` finds the marker
 * in the posted comment. It appends `pr.comment.executed` and posts nothing.
 */
describe('handleAddPrComment — B2.3 Idempotent operationId marker check', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The caller injects the committed `operationId`. The real store deduplicates
   * the intent by its idempotency key, so this mock append only resolves.
   */
  it('AddPrComment_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate', async () => {
    const seededOperationId = '00000000-0000-4000-8000-000000001234';
    const existingCommentId = 99001;
    const markerInBody = `<!-- exarchos-op:${seededOperationId} -->`;

    const existingComment: PrComment = {
      id: existingCommentId,
      author: 'bot',
      body: `Automated review\n\n${markerInBody}`,
      createdAt: '2026-05-12T00:00:00Z',
    };

    const mockProvider = makeMockProvider({
      getPrComments: vi.fn().mockResolvedValue([existingComment]),
      getRepository: vi.fn().mockResolvedValue({
        nameWithOwner: 'owner/repo',
        defaultBranch: 'main',
      } satisfies RepoInfo),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const appendMock = vi.fn().mockResolvedValue({
      sequence: 2,
      type: 'pr.comment.executed',
      streamId: 'vcs',
      timestamp: new Date().toISOString(),
    });

    const mockCtx: DispatchContext = {
      stateDir: '/tmp/b2-idem-test',
      eventStore: {
        append: appendMock,
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const result = await handleAddPrComment(
      { prId: '42', body: 'Automated review', operationId: seededOperationId },
      mockCtx,
    );

    expect(result.success).toBe(true);

    expect(mockProvider.addComment).not.toHaveBeenCalled();

    expect(appendMock).toHaveBeenCalledWith(
      'vcs',
      expect.objectContaining({
        type: 'pr.comment.executed',
        data: expect.objectContaining({
          operationId: seededOperationId,
          commentId: existingCommentId,
        }),
      }),
      expect.anything(),
    );
  });

  /**
   * On recovery of a thread reply, the executed URL uses the `#discussion_r`
   * anchor of the review thread, not `#issuecomment-`.
   */
  it('AddPrComment_ReplyRecovery_UsesDiscussionAnchorNotIssueComment', async () => {
    const seededOperationId = '00000000-0000-4000-8000-000000005678';
    const existingCommentId = 99002;
    const markerInBody = `<!-- exarchos-op:${seededOperationId} -->`;
    const existingComment: PrComment = {
      id: existingCommentId,
      author: 'bot',
      body: `Reply\n\n${markerInBody}`,
      createdAt: '2026-05-12T00:00:00Z',
    };

    const mockProvider = makeMockProvider({
      getPrComments: vi.fn().mockResolvedValue([existingComment]),
      getRepository: vi.fn().mockResolvedValue({
        nameWithOwner: 'owner/repo',
        defaultBranch: 'main',
      } satisfies RepoInfo),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const appendMock = vi.fn().mockResolvedValue({
      sequence: 2,
      type: 'pr.comment.executed',
      streamId: 'vcs',
      timestamp: new Date().toISOString(),
    });

    const mockCtx: DispatchContext = {
      stateDir: '/tmp/b2-idem-reply-test',
      eventStore: {
        append: appendMock,
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const result = await handleAddPrComment(
      { prId: '42', body: 'Reply', threadId: '201', operationId: seededOperationId },
      mockCtx,
    );

    expect(result.success).toBe(true);
    expect(mockProvider.addReply).not.toHaveBeenCalled();
    const executedCall = appendMock.mock.calls.find(
      (call) => (call[1] as { type: string }).type === 'pr.comment.executed',
    );
    const url = (executedCall?.[1] as { data: { url: string } }).data.url;
    expect(url).toContain(`#discussion_r${existingCommentId}`);
    expect(url).not.toContain('#issuecomment-');
  });
});
