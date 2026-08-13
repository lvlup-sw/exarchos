import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VcsProvider, PrComment, RepoInfo } from '../../../../src/vcs/provider.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { ConcurrencyError } from '../../../../src/events/index.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleAddPrComment } from '../../../../src/verbs/vcs/add-pr-comment.js';

// ─── Shared mock factories ──────────────────────────────────────────────────

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
      getAppender: vi.fn().mockReturnValue({
        appendComputed: vi.fn().mockResolvedValue({ ok: true, kind: 'committed', sequences: [1], eventIds: ['eid-1'], timestamps: [new Date().toISOString()] }),
      }),
      ...eventStoreOverride,
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

// ─── Original handleAddPrComment unit tests (updated for two-event split) ──

describe('handleAddPrComment', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a getPrComments that returns the posted comment on the SECOND
    // call (Phase C verification scan). First call is the idempotency
    // pre-check and returns []. This mirrors the real eventual-consistency
    // expectation: by the time we re-query after addComment succeeds, the
    // comment is visible.
    let getCallCount = 0;
    mockProvider = makeMockProvider({
      getPrComments: vi.fn().mockImplementation(async () => {
        getCallCount += 1;
        if (getCallCount === 1) return [];
        // Verification scan — return a comment whose body will contain the marker
        // injected by the handler. We can't know the marker here, so return
        // a comment whose body contains a wildcard marker pattern; the handler
        // calls .includes(marker) which matches if the body contains it.
        // Capture the body actually sent via addComment.
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

    // addComment is still called; body now includes the operationId marker
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

  // ─── threadId routes through the provider-agnostic addReply (T9 / #1165) ───

  it('handleAddPrComment_ThreadId_RoutesThroughAddReplyNotAddComment', async () => {
    // With threadId present the body must go through addReply (the thread-aware
    // sibling), NOT addComment — that's the whole point of keeping shepherd's
    // per-thread reply step on the provider-agnostic surface (INV-2).
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
    // addReply called with the PR id, thread id, and marker-embedded body.
    expect(replyProvider.addReply).toHaveBeenCalledTimes(1);
    const [calledPrId, calledThreadId, calledBody] = vi.mocked(replyProvider.addReply).mock.calls[0];
    expect(calledPrId).toBe('42');
    expect(calledThreadId).toBe('201');
    expect(calledBody).toContain('Addressed in latest push.');
    // addComment must NOT be called on the reply path.
    expect(replyProvider.addComment).not.toHaveBeenCalled();
  });

  it('handleAddPrComment_ThreadId_EmitsExecutedWithReplyId', async () => {
    // The executed event carries the id addReply returned directly — no Phase-C
    // re-query, because addReply hands back the new reply's commentId.
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

    const appender = replyCtx.eventStore.getAppender();
    const [, , computeFn] = vi.mocked(appender.appendComputed).mock.calls[0];
    const events = await computeFn();
    expect(events[0].type).toBe('pr.comment.requested');
    expect((events[0].data as Record<string, unknown>).threadId).toBe(201);
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

  it('handleAddPrComment_Success_EmitsTwoEventSequence', async () => {
    const args = { prId: '42', body: 'Review comment' };

    await handleAddPrComment(args, ctx);

    // Phase A — pr.comment.requested must be committed via appendComputed
    const appender = ctx.eventStore.getAppender();
    expect(appender.appendComputed).toHaveBeenCalledTimes(1);
    const [streamId, , computeFn] = vi.mocked(appender.appendComputed).mock.calls[0];
    expect(streamId).toBe('vcs');
    // The compute function should produce a pr.comment.requested event
    const events = await computeFn();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('pr.comment.requested');

    // Phase C — pr.comment.executed must also be appended
    expect(ctx.eventStore.append).toHaveBeenCalledWith(
      'vcs',
      expect.objectContaining({ type: 'pr.comment.executed' }),
      expect.anything(),
    );
  });

  // ─── CodeRabbit #3224596442/#3224631230: verification miss must NOT write
  // a schema-violating pr.comment.executed (commentId: 0).
  // ─────────────────────────────────────────────────────────────────────────
  it('AddPrComment_PostSucceededButVerificationLookupMissed_ReturnsFailureAndDoesNotEmitExecuted', async () => {
    // Override getPrComments so BOTH the pre-check and the verification scan
    // return []. addComment succeeds (the post landed on GitHub) but we can't
    // verify it — the schema for pr.comment.executed requires commentId > 0,
    // so we surface the failure rather than writing commentId: 0.
    const failingProvider = makeMockProvider({
      getPrComments: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(failingProvider);
    const failCtx = makeMockCtx();

    const result = await handleAddPrComment({ prId: '42', body: 'verify-miss' }, failCtx);

    // The handler surfaces the failure rather than corrupting the event stream.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_VERIFICATION_FAILED');

    // Critical: pr.comment.executed was NOT emitted (would have been
    // schema-violating with commentId: 0).
    const appendCalls = vi.mocked(failCtx.eventStore.append).mock.calls;
    const executedAppend = appendCalls.find(
      (call) => (call[1] as { type: string }).type === 'pr.comment.executed',
    );
    expect(executedAppend).toBeUndefined();

    // The addComment side effect DID fire — the comment is posted with the
    // marker, so a subsequent invocation can recover via the idempotent scan.
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

// ─── B2.2 — Non-refire fixture (Task B2.2, RED first) ──────────────────────
//
// The two-event split's load-bearing property: the non-idempotent side
// effect (`addComment`) lives BETWEEN Phase A (`pr.comment.requested` append)
// and Phase C (`pr.comment.executed` append), but is NEVER inside a retry
// boundary. If Phase A's appendComputed throws ConcurrencyError, withStateRetry
// must catch it and retry Phase A. addComment must be called AT MOST ONCE
// across the entire retry cycle (not during Phase A retries).

describe('handleAddPrComment — B2.2 Phase-A retry non-refire', () => {
  const scratchRoots: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      scratchRoots.map((p) => fs.rm(p, { recursive: true, force: true })),
    );
    scratchRoots.length = 0;
  });

  it('AddPrComment_PhaseARetry_DoesNotRefireGhPrComment', async () => {
    // Arrange: set up a real-ish event store with a spied appendComputed that
    // throws ConcurrencyError on the first call, then succeeds.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-refire-'));
    scratchRoots.push(stateDir);

    // Build a mock eventStore whose appender's appendComputed fails once, then succeeds.
    let phaseAAttempts = 0;
    const appendComputedMock = vi.fn().mockImplementation(
      async (
        _streamId: string,
        _key: string,
        _compute: () => Promise<unknown[]>,
        _opts?: unknown,
      ) => {
        phaseAAttempts += 1;
        if (phaseAAttempts === 1) {
          // First attempt — synthesize a ConcurrencyError that withStateRetry catches.
          throw new ConcurrencyError({
            streamId: 'vcs',
            reducerId: 'add-pr-comment',
            expectedVersion: 0,
            actualVersion: 1,
          });
        }
        // Second attempt — succeed (return committed AppendResult shape).
        return {
          ok: true,
          kind: 'committed' as const,
          sequences: [1],
          eventIds: ['eid-1'],
          timestamps: [new Date().toISOString()],
        };
      },
    );

    const appendMock = vi.fn().mockResolvedValue({
      sequence: 2,
      type: 'pr.comment.executed',
      streamId: 'vcs',
      timestamp: new Date().toISOString(),
    });

    const mockCtx: DispatchContext = {
      stateDir,
      eventStore: {
        append: appendMock,
        getAppender: vi.fn().mockReturnValue({
          appendComputed: appendComputedMock,
        }),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    // getPrComments: empty on the pre-check, populated on the verification
    // scan after addComment runs. The handler's verification lookup MUST
    // succeed for it to emit pr.comment.executed (else returns
    // VCS_VERIFICATION_FAILED — see CodeRabbit #3224596442/#3224631230).
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

    // Act
    const result = await handleAddPrComment({ prId: '42', body: 'test body' }, mockCtx);

    // Assert — handler succeeded overall
    expect(result.success).toBe(true);

    // Assert — Phase A retried (withStateRetry engaged)
    expect(phaseAAttempts).toBeGreaterThanOrEqual(2);

    // Assert — addComment fired AT MOST ONCE (not re-fired during Phase A retries)
    expect(mockProvider.addComment).toHaveBeenCalledTimes(1);
  });
});

// ─── B2.3 — Idempotent side-effect check fixture (Task B2.3, RED first) ────
//
// INV-1 MEDIUM audit requirement: if pr.comment.requested was committed but
// execution was interrupted before pr.comment.executed, a retry invocation
// must detect the already-posted comment via operationId marker in the body
// and emit pr.comment.executed with the existing comment's data — WITHOUT
// calling addComment again.

describe('handleAddPrComment — B2.3 Idempotent operationId marker check', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('AddPrComment_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate', async () => {
    // Seed: a pr.comment.requested was already committed with operationId 'op-uuid-1234'
    const seededOperationId = '00000000-0000-4000-8000-000000001234';
    const existingCommentId = 99001;
    const markerInBody = `<!-- exarchos-op:${seededOperationId} -->`;

    // The idempotency check: getPrComments returns one comment whose body
    // contains the marker matching the seeded operationId.
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

    // Build a ctx whose appendComputed returns a cache-hit for the seeded
    // operationId (simulating that Phase A already committed).
    const appendComputedMock = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'cache-hit' as const,
      sequences: [1],
      eventIds: ['eid-seed'],
      timestamps: ['2026-05-12T00:00:00Z'],
      persistedEvents: [],
    });

    const appendMock = vi.fn().mockResolvedValue({
      sequence: 2,
      type: 'pr.comment.executed',
      streamId: 'vcs',
      timestamp: new Date().toISOString(),
    });

    // Provide the seeded operationId via DI so the handler uses the SAME
    // UUID that was committed in Phase A — not a freshly generated one.
    const mockCtx: DispatchContext = {
      stateDir: '/tmp/b2-idem-test',
      eventStore: {
        append: appendMock,
        getAppender: vi.fn().mockReturnValue({
          appendComputed: appendComputedMock,
        }),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    // Act — invoke handler with an injectable operationId matching the seed
    const result = await handleAddPrComment(
      { prId: '42', body: 'Automated review', operationId: seededOperationId },
      mockCtx,
    );

    // Assert — success
    expect(result.success).toBe(true);

    // Assert — addComment NOT called (idempotent path: comment already exists)
    expect(mockProvider.addComment).not.toHaveBeenCalled();

    // Assert — pr.comment.executed was emitted with the existing comment data
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

  it('AddPrComment_ReplyRecovery_UsesDiscussionAnchorNotIssueComment', async () => {
    // Reply crash-recovery: a pr.comment.requested for a THREAD REPLY (threadId set)
    // was committed, then execution was interrupted. On recovery the emitted URL must
    // use the #discussion_r anchor (review-inline thread), not #issuecomment-.
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

    const appendComputedMock = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'cache-hit' as const,
      sequences: [1],
      eventIds: ['eid-seed'],
      timestamps: ['2026-05-12T00:00:00Z'],
      persistedEvents: [],
    });
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
        getAppender: vi.fn().mockReturnValue({ appendComputed: appendComputedMock }),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const result = await handleAddPrComment(
      { prId: '42', body: 'Reply', threadId: '201', operationId: seededOperationId },
      mockCtx,
    );

    expect(result.success).toBe(true);
    // Recovery path: no new reply posted.
    expect(mockProvider.addReply).not.toHaveBeenCalled();
    const url = (appendMock.mock.calls[0]?.[1] as { data: { url: string } }).data.url;
    expect(url).toContain(`#discussion_r${existingCommentId}`);
    expect(url).not.toContain('#issuecomment-');
  });
});
