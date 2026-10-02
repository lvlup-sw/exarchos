// Tests for `handleAssessStack`. They use a mock VcsProvider.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';
import type { VcsProvider, CiStatus, ReviewStatus, PrComment } from '../../../../src/vcs/provider.js';

const mockAppend = vi.fn();
const mockQuery = vi.fn();

import type { EventStore } from '../../../../src/events/store.js';
import { handleAssessStack, resolveCommentWindow } from '../../../../src/verbs/vcs/assess-stack.js';

const mockEventStore = {
  append: mockAppend,
  query: mockQuery,
} as unknown as EventStore;
import type { ReviewAdapterRegistry, ProviderAdapter, ReviewerKind } from '../../../../src/review/types.js';
import { coderabbitAdapter } from '../../../../src/review/providers/coderabbit.js';

const STATE_DIR = '/tmp/test-assess-stack';

/** A coarse token estimate over the serialized result, at about four characters for each token. */
function estimateTokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

/**
 * A large review comment with a unique tail marker past the 200-character body
 * limit. Only an untruncated copy of the body holds the marker.
 */
function heavyComment(id: number): PrComment {
  const head = `HEAD_${id}_`;
  const filler = 'x'.repeat(2000);
  const tail = `_TAIL_MARKER_${id}_`;
  return {
    id,
    author: `human-reviewer-${id}`,
    body: `${head}${filler}${tail}`,
    createdAt: '2026-01-01T00:00:00Z',
    source: 'issue-comment',
  } as PrComment;
}

/** A mock provider. With `prState`, `listPrs` returns PR 42 in that state, for merge detection. */
function createMockProvider(overrides: {
  name?: VcsProvider['name'];
  checkCi?: CiStatus;
  reviewStatus?: ReviewStatus;
  prComments?: PrComment[];
  prState?: string;
} = {}): VcsProvider {
  const defaultCi: CiStatus = { status: 'pass', checks: [] };
  const defaultReview: ReviewStatus = { state: 'pending', reviewers: [] };

  return {
    name: overrides.name ?? 'github',
    createPr: vi.fn(),
    checkCi: vi.fn<(prId: string) => Promise<CiStatus>>().mockResolvedValue(overrides.checkCi ?? defaultCi),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn<(prId: string) => Promise<ReviewStatus>>().mockResolvedValue(overrides.reviewStatus ?? defaultReview),
    listPrs: vi.fn().mockResolvedValue([
      ...(overrides.prState ? [{
        number: 42,
        url: '',
        title: '',
        headRefName: '',
        baseRefName: '',
        state: overrides.prState,
      }] : []),
    ]),
    getPrComments: vi.fn<(prId: string) => Promise<PrComment[]>>().mockResolvedValue(overrides.prComments ?? []),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

describe('handleAssessStack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppend.mockResolvedValue({
      streamId: 'test-feature',
      sequence: 1,
      type: 'ci.status',
      timestamp: new Date().toISOString(),
    });
    mockQuery.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('AssessStack_MissingFeatureId_ReturnsInvalidInput', async () => {
      const args = { featureId: '', prNumbers: [1] };
      const result = await handleAssessStack(args, STATE_DIR, mockEventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('AssessStack_MissingPrNumbers_ReturnsInvalidInput', async () => {
      const args = { featureId: 'test-feature', prNumbers: [] };
      const result = await handleAssessStack(args, STATE_DIR, mockEventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('prNumbers');
    });
  });

  /**
   * The handler does not stop for a provider that is not GitHub. Each provider
   * call works on GitLab and ADO or fails soft, so the comments still become
   * action items.
   */
  describe('non-GitHub provider gating', () => {
    it('AssessStack_NonGitHubProvider_ProceedsNotSkipped', async () => {
      const provider = createMockProvider({
        name: 'gitlab',
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 1,
            author: 'alice',
            body: 'Please address this',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'issue-comment',
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        skipped?: boolean;
        status?: unknown;
        actionItems?: unknown[];
        recommendation?: string;
      };
      expect(data.skipped).toBeUndefined();
      expect(data.status).toBeDefined();
      expect(data.recommendation).toBeDefined();
      expect(provider.getPrComments).toHaveBeenCalledWith('42');
    });
  });

  describe('VcsProvider usage', () => {
    it('AssessStack_UsesProviderCheckCi_ForCiStatus', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'pass',
          checks: [
            { name: 'ci/build', status: 'pass' },
            { name: 'ci/test', status: 'pass' },
          ],
        },
        reviewStatus: { state: 'approved', reviewers: [{ login: 'reviewer1', state: 'approved' }] },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      expect(provider.checkCi).toHaveBeenCalledWith('42');
    });

    it('AssessStack_UsesProviderGetReviewStatus_ForReviews', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        reviewStatus: {
          state: 'approved',
          reviewers: [{ login: 'reviewer1', state: 'approved' }],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      expect(provider.getReviewStatus).toHaveBeenCalledWith('42');
    });

    it('AssessStack_UsesProviderGetPrComments_ForComments', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 1, author: 'alice', body: 'Please fix this', createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      expect(provider.getPrComments).toHaveBeenCalledWith('42');
    });
  });

  describe('happy path', () => {
    it('AssessStack_ValidInput_ReturnsShepherdStatus', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'pass',
          checks: [
            { name: 'ci/build', status: 'pass' },
            { name: 'ci/test', status: 'pass' },
          ],
        },
        reviewStatus: {
          state: 'approved',
          reviewers: [{ login: 'reviewer1', state: 'approved' }],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: Record<string, unknown>;
        actionItems: unknown[];
        recommendation: string;
      };
      expect(data.status).toBeDefined();
      expect(data.actionItems).toBeDefined();
      expect(data.recommendation).toBeDefined();
    });
  });

  describe('CI failure handling', () => {
    it('AssessStack_CiFailing_IncludesActionItem', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'fail',
          checks: [
            { name: 'ci/build', status: 'fail' },
            { name: 'ci/test', status: 'pass' },
          ],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string; pr: number; description: string; severity: string }>;
      };
      const ciFixItems = data.actionItems.filter(item => item.type === 'ci-fix');
      expect(ciFixItems.length).toBeGreaterThan(0);
      expect(ciFixItems[0].pr).toBe(42);
      expect(ciFixItems[0].severity).toBe('critical');
    });
  });

  describe('comment handling', () => {
    it('AssessStack_UnresolvedComments_IncludesActionItems', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 1, author: 'alice', body: 'Please fix this logic', createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string; pr: number }>;
      };
      const commentItems = data.actionItems.filter(item => item.type === 'comment-reply');
      expect(commentItems.length).toBeGreaterThan(0);
      expect(commentItems[0].pr).toBe(42);
    });
  });

  describe('comment body truncation', () => {
    it('AssessStack_LongCommentBody_TruncatedTo200Chars', async () => {
      const longBody = 'x'.repeat(500);
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 1, author: 'alice', body: longBody, createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      const commentBody = data.status.prs[0].unresolvedComments[0].body;
      expect(commentBody.length).toBeLessThanOrEqual(203);
      expect(commentBody.endsWith('...')).toBe(true);
    });

    it('AssessStack_ShortCommentBody_NotTruncated', async () => {
      const shortBody = 'This is a short comment';
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 1, author: 'alice', body: shortBody, createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      const commentBody = data.status.prs[0].unresolvedComments[0].body;
      expect(commentBody).toBe(shortBody);
    });
  });

  describe('recommendation logic', () => {
    it('AssessStack_AllPassing_RecommendsApproval', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'pass',
          checks: [
            { name: 'ci/build', status: 'pass' },
            { name: 'ci/test', status: 'pass' },
          ],
        },
        reviewStatus: {
          state: 'approved',
          reviewers: [{ login: 'reviewer1', state: 'approved' }],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('request-approval');
    });

    it('AssessStack_BlockingIssues_RecommendsFixAndResubmit', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'fail',
          checks: [{ name: 'ci/build', status: 'fail' }],
        },
        reviewStatus: {
          state: 'changes_requested',
          reviewers: [{ login: 'reviewer1', state: 'changes_requested' }],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('fix-and-resubmit');
    });

    it('AssessStack_PendingCi_RecommendsWait', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'pending',
          checks: [{ name: 'ci/build', status: 'pending' }],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('wait');
    });

    it('AssessStack_MaxIterations_RecommendsEscalate', async () => {
      const iterationEvents = Array.from({ length: 5 }, (_, i) => ({
        type: 'shepherd.iteration',
        streamId: 'test-feature',
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        data: { prUrl: 'https://github.com/test/42', iteration: i + 1, action: 'fix', outcome: 'retry' },
      }));
      mockQuery.mockResolvedValue(iterationEvents);

      const provider = createMockProvider({
        checkCi: {
          status: 'fail',
          checks: [{ name: 'ci/build', status: 'fail' }],
        },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('escalate');
    });

    /**
     * The iteration count is the number of `shepherd.iteration` events, from
     * `countShepherdIterations`. The payload `iteration` values are wrong on
     * purpose. The count must ignore them and still reach the bound of 5.
     */
    it('IterationCounter_SingleEventSourcedAuthority', async () => {
      const garbagePayloads = [99, 99, 1, 0, -3];
      const iterationEvents = garbagePayloads.map((iteration, i) => ({
        type: 'shepherd.iteration',
        streamId: 'test-feature',
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        data: { prUrl: 'https://github.com/test/42', iteration, action: 'fix', outcome: 'retry' },
      }));
      mockQuery.mockImplementation(async (_streamId: string, opts?: { type?: string }) =>
        opts?.type === 'shepherd.iteration' ? iterationEvents : [],
      );

      const provider = createMockProvider({
        checkCi: { status: 'fail', checks: [{ name: 'ci/build', status: 'fail' }] },
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        recommendation: string;
        status: { iterationCount: number };
      };
      expect(data.status.iterationCount).toBe(garbagePayloads.length);
      expect(data.recommendation).toBe('escalate');
    });

    /**
     * `escalation.maxIterations: 3` in the config lowers the bound. Three
     * events then escalate, where the default bound of 5 gives
     * fix-and-resubmit.
     */
    it('IterationBound_ConfigResolvable_LowersEscalationThreshold', async () => {
      const iterationEvents = Array.from({ length: 3 }, (_, i) => ({
        type: 'shepherd.iteration',
        streamId: 'test-feature',
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        data: { prUrl: 'https://github.com/test/42', iteration: i + 1, action: 'fix', outcome: 'retry' },
      }));
      mockQuery.mockImplementation(async (_streamId: string, opts?: { type?: string }) =>
        opts?.type === 'shepherd.iteration' ? iterationEvents : [],
      );

      const provider = createMockProvider({
        checkCi: { status: 'fail', checks: [{ name: 'ci/build', status: 'fail' }] },
      });

      const result = await handleAssessStack(
        {
          featureId: 'test-feature',
          prNumbers: [42],
          projectConfig: { escalation: { maxIterations: 3 } } as never,
        },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('escalate');
    });
  });

  describe('shepherd lifecycle events', () => {
    it('HandleAssessStack_FirstInvocation_EmitsShepherdStarted', async () => {
      mockQuery.mockResolvedValue([]);

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const shepherdStartedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.started',
      );
      expect(shepherdStartedCalls.length).toBe(1);
      expect(shepherdStartedCalls[0][0]).toBe('test-feature');
      const startedData = (shepherdStartedCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(startedData.featureId).toBe('test-feature');
      const idempotencyKey = (shepherdStartedCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(idempotencyKey).toBe('test-feature:shepherd.started');
    });

    it('HandleAssessStack_SubsequentInvocation_DoesNotReEmitShepherdStarted', async () => {
      mockQuery.mockImplementation(async (_streamId: string, opts?: { type?: string }) => {
        if (opts?.type === 'shepherd.started') {
          return [{
            type: 'shepherd.started',
            streamId: 'test-feature',
            sequence: 1,
            timestamp: new Date().toISOString(),
            data: { featureId: 'test-feature' },
          }];
        }
        if (opts?.type === 'shepherd.iteration') {
          return [];
        }
        return [];
      });

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const shepherdStartedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.started',
      );
      expect(shepherdStartedCalls.length).toBe(0);
    });

    it('HandleAssessStack_AllChecksPassing_EmitsApprovalRequested', async () => {
      mockQuery.mockResolvedValue([]);

      const provider = createMockProvider({
        checkCi: {
          status: 'pass',
          checks: [
            { name: 'ci/build', status: 'pass' },
            { name: 'ci/test', status: 'pass' },
          ],
        },
        reviewStatus: {
          state: 'approved',
          reviewers: [{ login: 'reviewer1', state: 'approved' }],
        },
        prState: 'OPEN',
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls.length).toBe(1);
      const approvalData = (approvalCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(approvalData.prUrl).toBeDefined();
      const idempotencyKey = (approvalCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(idempotencyKey).toBe('test-feature:shepherd.approval_requested:0');
    });

    it('HandleAssessStack_ChecksFailing_DoesNotEmitApprovalRequested', async () => {
      mockQuery.mockResolvedValue([]);

      const provider = createMockProvider({
        checkCi: {
          status: 'fail',
          checks: [{ name: 'ci/build', status: 'fail' }],
        },
        prState: 'OPEN',
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls.length).toBe(0);
    });

    /** A merged PR appends `shepherd.completed` once and no `shepherd.approval_requested`. */
    it('HandleAssessStack_PrMerged_EmitsShepherdCompleted', async () => {
      mockQuery.mockResolvedValue([]);

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prState: 'MERGED',
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const completedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.completed',
      );
      expect(completedCalls.length).toBe(1);
      const completedData = (completedCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(completedData.outcome).toBe('merged');
      const idempotencyKey = (completedCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(idempotencyKey).toBe('test-feature:shepherd.completed');

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls).toHaveLength(0);
    });

    it('HandleAssessStack_PriorCompleted_SkipsApprovalRequested', async () => {
      mockQuery.mockImplementation((_stream: string, filter?: { type: string }) => {
        if (filter?.type === 'shepherd.completed') {
          return Promise.resolve([{ type: 'shepherd.completed', data: { prUrl: 'https://github.com/test/42', outcome: 'merged' } }]);
        }
        return Promise.resolve([]);
      });

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        reviewStatus: {
          state: 'approved',
          reviewers: [{ login: 'reviewer1', state: 'approved' }],
        },
        prState: 'OPEN',
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls).toHaveLength(0);
    });

    /**
     * At the auto-fix bound, the handler appends one `shepherd.escalated` event
     * with the reason and the counts. Then it returns its normal result with
     * `recommendation: 'escalate'` and does not wait. A second assessment at
     * the same count uses the same idempotency key, so the store keeps one row.
     */
    it('BoundHit_EmitsStructuredEscalation_NotHang', async () => {
      const iterationEvents = Array.from({ length: 5 }, (_, i) => ({
        type: 'shepherd.iteration',
        streamId: 'test-feature',
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        data: { prUrl: 'https://github.com/test/42', iteration: i + 1, action: 'fix', outcome: 'retry' },
      }));
      mockQuery.mockImplementation(async (_streamId: string, opts?: { type?: string }) =>
        opts?.type === 'shepherd.iteration' ? iterationEvents : [],
      );

      const provider = createMockProvider({
        checkCi: { status: 'fail', checks: [{ name: 'ci/build', status: 'fail' }] },
        prState: 'OPEN',
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42, 43] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('escalate');

      const escalatedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.escalated',
      );
      expect(escalatedCalls.length).toBe(1);
      expect(escalatedCalls[0][0]).toBe('test-feature');
      const escalatedData = (escalatedCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(escalatedData.featureId).toBe('test-feature');
      expect(escalatedData.prNumbers).toEqual([42, 43]);
      expect(escalatedData.iterationCount).toBe(5);
      expect(escalatedData.maxIterations).toBe(5);
      expect(escalatedData.reason).toBe('auto-fix bound (5) reached after 5 iterations');
      const firstKey = (escalatedCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(firstKey).toBe('test-feature:shepherd.escalated:5');

      mockAppend.mockClear();
      const result2 = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42, 43] },
        STATE_DIR,
        mockEventStore,
        provider,
      );
      const data2 = result2.data as { recommendation: string };
      expect(data2.recommendation).toBe('escalate');
      const escalatedCalls2 = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.escalated',
      );
      expect(escalatedCalls2.length).toBe(1);
      const secondKey = (escalatedCalls2[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(secondKey).toBe(firstKey);
    });
  });

  describe('event emission', () => {
    it('AssessStack_EmitsCiStatusEvents', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'pass',
          checks: [{ name: 'ci/build', status: 'pass' }],
        },
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const ciStatusCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'ci.status',
      );
      expect(ciStatusCalls.length).toBe(1);
      expect(ciStatusCalls[0][0]).toBe('test-feature');
      const eventData = (ciStatusCalls[0][1] as { data: { pr: number; status: string } }).data;
      expect(eventData.pr).toBe(42);
      expect(eventData.status).toBe('passing');
    });

    /**
     * Each CI check gets one `ci.check_observed` row, with an idempotency key
     * for the iteration and `skill: 'shepherd'`. No `gate.executed` row
     * appears, so CI checks stay apart from the gates that this repository runs.
     */
    it('AssessStack_EmitsCiCheckObservedEvents', async () => {
      const provider = createMockProvider({
        checkCi: {
          status: 'fail',
          checks: [
            { name: 'ci/build', status: 'pass' },
            { name: 'ci/test', status: 'fail' },
          ],
        },
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const checkCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'ci.check_observed',
      );
      expect(checkCalls.length).toBe(2);

      const gateExecutedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'gate.executed',
      );
      expect(gateExecutedCalls).toEqual([]);

      const checkIdempotencyKey = (checkCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(checkIdempotencyKey).toMatch(/iter-\d+$/);

      const firstCheck = (checkCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(firstCheck.check).toBe('ci/build');
      expect(firstCheck.pr).toBe(42);
      expect(firstCheck.passed).toBe(true);
      expect(firstCheck.skill).toBe('shepherd');

      const secondCheck = (checkCalls[1][1] as { data: Record<string, unknown> }).data;
      expect(secondCheck.check).toBe('ci/test');
      expect(secondCheck.passed).toBe(false);
    });
  });

  describe('provider.unknown-tier event emission', () => {
    it('AssessStack_CoderabbitUnknownTier_EmitsUnknownTierEvent', async () => {
      mockAppend.mockClear();
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 777,
            author: 'coderabbitai[bot]',
            body: '_:rocket: Brand new tier_\n\nLooks like something CodeRabbit ships in a future version.',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const unknownTierCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'provider.unknown-tier',
      );
      expect(unknownTierCalls.length).toBe(1);
      const data = (unknownTierCalls[0][1] as { data: { reviewer: string; commentId: number } }).data;
      expect(data.reviewer).toBe('coderabbit');
      expect(data.commentId).toBe(777);
    });

    it('AssessStack_CoderabbitUnknownTier_EventCarriesRawTier', async () => {
      mockAppend.mockClear();
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 778,
            author: 'coderabbitai[bot]',
            body: '_:rocket: Brand new tier_\n\nUnrecognised marker.',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const unknownTierCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'provider.unknown-tier',
      );
      expect(unknownTierCalls.length).toBe(1);
      const data = (unknownTierCalls[0][1] as { data: { reviewer: string; commentId: number; rawTier?: string } }).data;
      expect(data.rawTier).toBe('_:rocket: Brand new tier_');
    });

    it('AssessStack_RecognizedTier_DoesNotEmitUnknownTierEvent', async () => {
      mockAppend.mockClear();
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 1,
            author: 'coderabbitai[bot]',
            body: '_:warning: Potential issue_\n\nThis is a recognized tier.',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const unknownTierCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'provider.unknown-tier',
      );
      expect(unknownTierCalls.length).toBe(0);
    });
  });

  describe('classifyActionItems severity threading', () => {
    it('ClassifyActionItems_HighSeverityComment_RetainsHighNormalizedSeverity', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 1,
            author: 'coderabbitai[bot]',
            body: '_:warning: Potential issue_\n\nNull pointer.',
            createdAt: '2026-01-01T00:00:00Z',
            path: 'src/x.ts',
            line: 5,
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const data = result.data as {
        actionItems: Array<{ type: string; normalizedSeverity?: string; reviewer?: string; file?: string }>;
      };
      const commentReply = data.actionItems.find((i) => i.type === 'comment-reply');
      expect(commentReply).toBeDefined();
      expect(commentReply?.normalizedSeverity).toBe('HIGH');
      expect(commentReply?.reviewer).toBe('coderabbit');
      expect(commentReply?.file).toBe('src/x.ts');
    });
  });

  describe('adapter dispatch via registry', () => {
    it('QueryPrComments_CoderabbitComment_PopulatesNormalizedSeverity', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 999,
            author: 'coderabbitai[bot]',
            body: '_:warning: Potential issue_\n\nMissing null check on line 42.',
            createdAt: '2026-01-01T00:00:00Z',
            path: 'src/auth.ts',
            line: 42,
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ actionItem?: Record<string, unknown> }> }> };
      };
      const comment = data.status.prs[0].unresolvedComments[0];
      expect(comment.actionItem).toBeDefined();
      expect(comment.actionItem?.reviewer).toBe('coderabbit');
      expect(comment.actionItem?.normalizedSeverity).toBe('HIGH');
      expect(comment.actionItem?.file).toBe('src/auth.ts');
      expect(comment.actionItem?.line).toBe(42);
    });

    it('QueryPrComments_HumanComment_PopulatesNormalizedMedium', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 1,
            author: 'alice',
            body: 'Could you rename this variable?',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ actionItem?: Record<string, unknown> }> }> };
      };
      const comment = data.status.prs[0].unresolvedComments[0];
      expect(comment.actionItem?.reviewer).toBe('human');
      expect(comment.actionItem?.normalizedSeverity).toBe('MEDIUM');
    });

    it('QueryPrComments_UnknownBot_RoutesToUnknownAdapter', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 7,
            author: 'mystery-scanner[bot]',
            body: 'something happened',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ actionItem?: Record<string, unknown> }> }> };
      };
      const comment = data.status.prs[0].unresolvedComments[0];
      expect(comment.actionItem?.reviewer).toBe('unknown');
      expect(comment.actionItem?.normalizedSeverity).toBe('MEDIUM');
    });
  });

  describe('comment body economy (DR-2)', () => {
    /**
     * The result keeps only the truncated `body` of a comment. It has no
     * `fullBody` field, and the 500-character body appears nowhere in it.
     */
    it('QueryPrComments_LongCommentBody_TruncatedNoFullBodyCopy', async () => {
      const longBody = 'A'.repeat(500);
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 1, author: 'reviewer', body: longBody, createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<Record<string, unknown>> }> };
      };
      const comment = data.status.prs[0].unresolvedComments[0];
      expect('fullBody' in comment).toBe(false);
      expect((comment.body as string).length).toBeLessThanOrEqual(204);
      expect(JSON.stringify(result.data).includes(longBody)).toBe(false);
    });
  });

  describe('ActionItem with reviewer-context fields', () => {
    it('ActionItem_WithReviewerFields_TypeChecks', async () => {
      const { ActionItem: _ActionItem } = await import('../../../../src/verbs/vcs/assess-stack.js') as unknown as {
        ActionItem: never;
      };
      void _ActionItem;
      const item = {
        type: 'comment-reply' as const,
        pr: 42,
        description: 'CodeRabbit critical finding',
        severity: 'critical' as const,
        file: 'src/foo.ts',
        line: 10,
        reviewer: 'coderabbit' as const,
        threadId: 'thread-123',
        raw: { id: 999 },
        normalizedSeverity: 'HIGH' as const,
      } satisfies import('../../../../src/verbs/vcs/assess-stack.js').ActionItem;
      expect(item.file).toBe('src/foo.ts');
      expect(item.normalizedSeverity).toBe('HIGH');
      expect(item.reviewer).toBe('coderabbit');
    });
  });

  /**
   * An adapter that throws does not stop the batch. The handler appends
   * `provider.parse-error` and keeps the comment.
   */
  describe('adapter parse-error batch safety', () => {
    function makeRegistry(opts: {
      throwingAuthor: string;
      throwMessage: string;
    }): ReviewAdapterRegistry {
      const throwingAdapter: ProviderAdapter = {
        kind: 'coderabbit',
        parse: () => {
          throw new Error(opts.throwMessage);
        },
      };
      const passthroughAdapter: ProviderAdapter = {
        kind: 'unknown',
        parse: (c) => ({
          type: 'comment-reply',
          pr: 0,
          description: c.body.slice(0, 100),
          severity: 'major',
          reviewer: 'unknown',
          threadId: String(c.id),
          raw: c,
          normalizedSeverity: 'MEDIUM',
        }),
      };
      const byKind = new Map<ReviewerKind, ProviderAdapter>([
        ['coderabbit', throwingAdapter],
        ['unknown', passthroughAdapter],
      ]);
      return {
        forReviewer: (k) => byKind.get(k),
        list: () => [throwingAdapter, passthroughAdapter],
      };
    }

    it('AssessStack_AdapterThrows_EmitsProviderParseError', async () => {
      const registry = makeRegistry({ throwingAuthor: 'coderabbitai[bot]', throwMessage: 'bad body' });
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 99, author: 'coderabbitai[bot]', body: 'explodes', createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
        registry,
      );

      const parseErrCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'provider.parse-error',
      );
      expect(parseErrCalls.length).toBe(1);
      const data = (parseErrCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(data.reviewer).toBe('coderabbit');
      expect(data.commentId).toBe(99);
      expect(data.errorMessage).toContain('bad body');
      const idemKey = (parseErrCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(idemKey).toBe('test-feature:provider.parse-error:42:99');
    });

    it('AssessStack_AdapterThrowsOnOne_BatchContinuesForOthers', async () => {
      const registry = makeRegistry({ throwingAuthor: 'coderabbitai[bot]', throwMessage: 'boom' });
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          { id: 1, author: 'coderabbitai[bot]', body: 'explodes', createdAt: '2026-01-01T00:00:00Z' },
          { id: 2, author: 'mystery-reviewer', body: 'survives', createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
        registry,
      );

      expect(result.success).toBe(true);
      const status = (result.data as { status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> } }).status;
      const bodies = status.prs[0].unresolvedComments.map((c) => c.body);
      expect(bodies).toContain('survives');
      expect(bodies).toContain('explodes');
    });
  });

  /**
   * Each comment source and each threaded reply goes through one harvest path,
   * with no branch on the source or the workflow type. Only `resolved === true`
   * removes a comment. An absent `resolved` is unknown, so the comment stays.
   */
  describe('unified PR-feedback feed consumption', () => {
    it('AssessStack_InlineReviewComment_BecomesActionItem', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 1,
            author: 'alice',
            body: 'This branch is unreachable',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'review-inline',
            path: 'src/handler.ts',
            line: 88,
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string; pr: number; file?: string; line?: number }>;
      };
      const commentReply = data.actionItems.find((i) => i.type === 'comment-reply');
      expect(commentReply).toBeDefined();
      expect(commentReply?.pr).toBe(42);
      expect(commentReply?.file).toBe('src/handler.ts');
      expect(commentReply?.line).toBe(88);
    });

    it('AssessStack_ThreadedReply_Surfaced', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 2,
            author: 'bob',
            body: 'Replying to the earlier thread — still not addressed',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'review-inline',
            path: 'src/handler.ts',
            line: 88,
            parentId: 1,
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string; pr: number }>;
        status: { prs: Array<{ unresolvedComments: Array<{ parentId?: number }> }> };
      };
      const commentReply = data.actionItems.find((i) => i.type === 'comment-reply');
      expect(commentReply).toBeDefined();
      expect(data.status.prs[0].unresolvedComments[0].parentId).toBe(1);
    });

    it('AssessStack_ReviewSummaryBody_Surfaced', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 3,
            author: 'carol',
            body: 'Overall this needs another pass on error handling.',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'review-summary',
            state: 'COMMENTED',
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string }>;
        status: { prs: Array<{ unresolvedComments: Array<{ source?: string }> }> };
      };
      const commentReply = data.actionItems.find((i) => i.type === 'comment-reply');
      expect(commentReply).toBeDefined();
      expect(data.status.prs[0].unresolvedComments[0].source).toBe('review-summary');
    });

    /** A comment with `resolved: true` gives no action item. A comment without `resolved` stays. */
    it('AssessStack_ResolvedComment_NotSurfaced', async () => {
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [
          {
            id: 10,
            author: 'alice',
            body: 'Resolved thread — already handled',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'review-inline',
            path: 'src/a.ts',
            line: 1,
            resolved: true,
          },
          {
            id: 11,
            author: 'bob',
            body: 'Unknown-resolution thread — still needs attention',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'review-inline',
            path: 'src/b.ts',
            line: 2,
          },
        ],
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string; file?: string }>;
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      const commentReplies = data.actionItems.filter((i) => i.type === 'comment-reply');
      expect(commentReplies).toHaveLength(1);
      expect(commentReplies[0].file).toBe('src/b.ts');

      const surfacedBodies = data.status.prs[0].unresolvedComments.map((c) => c.body);
      expect(surfacedBodies).toContain('Unknown-resolution thread — still needs attention');
      expect(surfacedBodies).not.toContain('Resolved thread — already handled');
    });

    /**
     * The assess-stack source has no `workflowType` token. Each comment source
     * gives one `comment-reply` item through the same path.
     */
    it('AssessStack_HarvestLoop_NoWorkflowTypeBranch', async () => {
      const fs = await import('node:fs');
      const path = await import('node:url');
      const srcPath = path.fileURLToPath(new URL('../../../../src/verbs/vcs/assess-stack.ts', import.meta.url));
      const src = fs.readFileSync(srcPath, 'utf8');
      expect(src).not.toMatch(/workflowType/);

      const mkProvider = (source: PrComment['source']): VcsProvider =>
        createMockProvider({
          checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
          prComments: [
            {
              id: 1,
              author: 'alice',
              body: 'needs attention',
              createdAt: '2026-01-01T00:00:00Z',
              source,
              ...(source === 'review-inline' ? { path: 'src/x.ts', line: 3 } : {}),
            },
          ],
        });

      const sources: PrComment['source'][] = ['issue-comment', 'review-inline', 'review-summary'];
      for (const source of sources) {
        const result = await handleAssessStack(
          { featureId: 'test-feature', prNumbers: [42] },
          STATE_DIR,
          mockEventStore,
          mkProvider(source),
        );
        expect(result.success).toBe(true);
        const data = result.data as { actionItems: Array<{ type: string }> };
        const commentReplies = data.actionItems.filter((i) => i.type === 'comment-reply');
        expect(commentReplies).toHaveLength(1);
      }
    });
  });

  /**
   * GitLab and ADO comments become `comment-reply` items through the same
   * harvest path as GitHub comments. Each case uses the same two unresolved
   * comments and one resolved comment, so only the provider `name` changes.
   */
  describe('multi-provider comment surfacing', () => {
    const mixedComments = (): PrComment[] => [
      {
        id: 1,
        author: 'alice',
        body: 'Please address this finding',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-inline',
        path: 'src/a.ts',
        line: 12,
      },
      {
        id: 2,
        author: 'bob',
        body: 'Already handled in a prior push',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-inline',
        path: 'src/b.ts',
        line: 34,
        resolved: true,
      },
      {
        id: 3,
        author: 'carol',
        body: 'Overall needs another pass on validation',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-summary',
        state: 'COMMENTED',
      },
    ];

    it('AssessStack_SurfacesGitLabComments_AsCommentReply', async () => {
      const provider = createMockProvider({
        name: 'gitlab',
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: mixedComments(),
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        skipped?: boolean;
        actionItems: Array<{ type: string; pr: number; file?: string }>;
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      expect(data.skipped).toBeUndefined();
      expect(provider.getPrComments).toHaveBeenCalledWith('42');

      const commentReplies = data.actionItems.filter((i) => i.type === 'comment-reply');
      expect(commentReplies).toHaveLength(2);
      expect(commentReplies.every((i) => i.pr === 42)).toBe(true);
      expect(commentReplies.some((i) => i.file === 'src/a.ts')).toBe(true);

      const surfacedBodies = data.status.prs[0].unresolvedComments.map((c) => c.body);
      expect(surfacedBodies).toContain('Please address this finding');
      expect(surfacedBodies).toContain('Overall needs another pass on validation');
      expect(surfacedBodies).not.toContain('Already handled in a prior push');
    });

    it('AssessStack_SurfacesAdoComments_AsCommentReply', async () => {
      const provider = createMockProvider({
        name: 'azure-devops',
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: mixedComments(),
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        skipped?: boolean;
        actionItems: Array<{ type: string; pr: number; file?: string }>;
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      expect(data.skipped).toBeUndefined();
      expect(provider.getPrComments).toHaveBeenCalledWith('42');

      const commentReplies = data.actionItems.filter((i) => i.type === 'comment-reply');
      expect(commentReplies).toHaveLength(2);
      expect(commentReplies.every((i) => i.pr === 42)).toBe(true);
      expect(commentReplies.some((i) => i.file === 'src/a.ts')).toBe(true);

      const surfacedBodies = data.status.prs[0].unresolvedComments.map((c) => c.body);
      expect(surfacedBodies).toContain('Please address this finding');
      expect(surfacedBodies).toContain('Overall needs another pass on validation');
      expect(surfacedBodies).not.toContain('Already handled in a prior push');
    });

    /** The same comments from a GitLab and an ADO provider must give equal `comment-reply` items. */
    it('AssessStack_HarvestLoop_NoProviderBranch', async () => {
      const runFor = async (name: VcsProvider['name']) => {
        const provider = createMockProvider({
          name,
          checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
          prComments: mixedComments(),
        });
        const result = await handleAssessStack(
          { featureId: 'test-feature', prNumbers: [42] },
          STATE_DIR,
          mockEventStore,
          provider,
        );
        expect(result.success).toBe(true);
        const data = result.data as { actionItems: Array<{ type: string }> };
        return data.actionItems.filter((i) => i.type === 'comment-reply');
      };

      const gitlabItems = await runFor('gitlab');
      const adoItems = await runFor('azure-devops');

      expect(gitlabItems).toHaveLength(2);
      expect(adoItems).toEqual(gitlabItems);
    });
  });

  describe('DR-2 token economy', () => {
    /**
     * One PR with 25 heavy unresolved comments must stay at or below 5,000
     * estimated tokens. The default window cuts the list, but `commentPage`
     * keeps the full total.
     */
    it('assessStack_CommentHeavyStack_StaysUnderBudget', async () => {
      const comments = Array.from({ length: 25 }, (_, i) => heavyComment(i + 1));
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: comments,
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const tokens = estimateTokens(result.data);
      expect(tokens).toBeLessThanOrEqual(5000);

      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: unknown[]; commentPage: { total: number; hasMore: boolean } }> };
      };
      expect(data.status.prs[0].commentPage.total).toBe(25);
      expect(data.status.prs[0].commentPage.hasMore).toBe(true);
      expect(data.status.prs[0].unresolvedComments.length).toBeLessThan(25);
    });

    /**
     * Each tail marker sits past the 200-character limit, so only a full-body
     * copy can hold it. No marker must appear, and each truncated body must
     * appear once.
     */
    it('assessStack_UnresolvedComments_EachCommentSerializedOnce', async () => {
      const comments = [heavyComment(1), heavyComment(2), heavyComment(3)];
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: comments,
      });

      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );

      expect(result.success).toBe(true);
      const serialized = JSON.stringify(result.data);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      const rendered = data.status.prs[0].unresolvedComments;
      expect(rendered).toHaveLength(3);

      for (const c of comments) {
        expect(serialized.includes(`_TAIL_MARKER_${c.id}_`)).toBe(false);
      }
      for (const rc of rendered) {
        const occurrences = serialized.split(rc.body).length - 1;
        expect(occurrences).toBe(1);
      }
    });

    /**
     * With pages of 10, each `comment-reply` reference must point to a comment
     * on the same page. Together the pages must reach all 25 comments.
     */
    it('assessStack_PagedComments_EveryActionableReferenceReachable', async () => {
      const comments = Array.from({ length: 25 }, (_, i) => heavyComment(i + 1));
      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: comments,
      });

      type CommentRefLike = { pr: number; commentId: number };
      type PagedData = {
        actionItems: Array<{ type: string; raw?: unknown }>;
        status: {
          prs: Array<{
            unresolvedComments: Array<{ id: number }>;
            commentPage: { total: number; offset: number; limit: number; hasMore: boolean };
          }>;
        };
      };

      const pageAt = async (offset: number): Promise<PagedData> => {
        const result = await handleAssessStack(
          { featureId: 'test-feature', prNumbers: [42], limit: 10, offset },
          STATE_DIR,
          mockEventStore,
          provider,
        );
        expect(result.success).toBe(true);
        return result.data as PagedData;
      };

      const reached = new Set<number>();
      const pages = [await pageAt(0), await pageAt(10), await pageAt(20)];

      pages.forEach((page, idx) => {
        const pr = page.status.prs[0];
        expect(pr.commentPage.total).toBe(25);
        expect(pr.commentPage.limit).toBe(10);
        const expectedLen = idx < 2 ? 10 : 5;
        expect(pr.unresolvedComments).toHaveLength(expectedLen);
        expect(pr.commentPage.hasMore).toBe(idx < 2);

        const idsOnPage = new Set(pr.unresolvedComments.map((c) => c.id));
        const refs = page.actionItems
          .filter((i) => i.type === 'comment-reply')
          .map((i) => i.raw as CommentRefLike);
        for (const ref of refs) {
          expect(ref.pr).toBe(42);
          expect(idsOnPage.has(ref.commentId)).toBe(true);
          reached.add(ref.commentId);
        }
      });

      expect([...reached].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
    });

    /**
     * Adapters parse the raw provider comment before the result build and read
     * `comment.body`. The provider comment has no `fullBody` field, so the
     * classification does not need a full-body copy in the result.
     */
    it('assessStack_AdapterConsumption_UnaffectedByFullBodyRemoval', async () => {
      const rawComment = {
        id: 7,
        author: 'coderabbitai[bot]',
        body: '_:warning: Potential issue_\n\nNull dereference on line 5.',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-inline' as const,
        path: 'src/auth.ts',
        line: 5,
      };

      const parsed = coderabbitAdapter.parse(rawComment);
      expect(parsed).not.toBeNull();
      expect(parsed?.normalizedSeverity).toBe('HIGH');
      expect(parsed?.description).toContain('Potential issue');
      expect(parsed?.file).toBe('src/auth.ts');

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prComments: [rawComment],
      });
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
        mockEventStore,
        provider,
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        actionItems: Array<{ type: string; normalizedSeverity?: string; reviewer?: string }>;
      };
      const commentReply = data.actionItems.find((i) => i.type === 'comment-reply');
      expect(commentReply?.normalizedSeverity).toBe('HIGH');
      expect(commentReply?.reviewer).toBe('coderabbit');
    });
  });

  describe('resolveCommentWindow — pagination edge cases', () => {
    it('resolveCommentWindow_MissingInputs_DefaultsToFullFirstPage', () => {
      expect(resolveCommentWindow(undefined, undefined)).toEqual({ limit: 20, offset: 0 });
    });

    it('resolveCommentWindow_ValidInts_PassThrough', () => {
      expect(resolveCommentWindow(10, 5)).toEqual({ limit: 10, offset: 5 });
    });

    /**
     * A fractional limit below 1 floors to 0, which gives an empty page. It must
     * fall back to the default of 20.
     */
    it('resolveCommentWindow_FractionalLimit_FallsBackToDefaultNotEmpty', () => {
      expect(resolveCommentWindow(0.5).limit).toBe(20);
      expect(resolveCommentWindow(0.9).limit).toBe(20);
    });

    it('resolveCommentWindow_ZeroOrNegativeLimit_FallsBackToDefault', () => {
      expect(resolveCommentWindow(0).limit).toBe(20);
      expect(resolveCommentWindow(-5).limit).toBe(20);
    });

    it('resolveCommentWindow_HugeLimit_ClampsToMax', () => {
      expect(resolveCommentWindow(1_000_000).limit).toBe(100);
    });

    it('resolveCommentWindow_FractionalOrNegativeOffset_FloorsAtZero', () => {
      expect(resolveCommentWindow(10, 0.5).offset).toBe(0);
      expect(resolveCommentWindow(10, -3).offset).toBe(0);
      expect(resolveCommentWindow(10, 2.9).offset).toBe(2);
    });
  });
});
