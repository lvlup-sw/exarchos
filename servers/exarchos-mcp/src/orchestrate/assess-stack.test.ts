// ─── Assess Stack Composite Action Tests ────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execSync for gh CLI calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { VcsProvider, CiStatus, ReviewStatus, PrComment } from '../vcs/provider.js';

// ─── Mock event store ────────────────────────────────────────────────────────

const mockAppend = vi.fn();
const mockQuery = vi.fn();

vi.mock('../event-store/store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({
    append: mockAppend,
    query: mockQuery,
  })),
}));

import { handleAssessStack } from './assess-stack.js';

const STATE_DIR = '/tmp/test-assess-stack';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  checkCi?: CiStatus;
  reviewStatus?: ReviewStatus;
  prComments?: PrComment[];
  prState?: string;
} = {}): VcsProvider {
  const defaultCi: CiStatus = { status: 'pass', checks: [] };
  const defaultReview: ReviewStatus = { state: 'pending', reviewers: [] };

  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn<(prId: string) => Promise<CiStatus>>().mockResolvedValue(overrides.checkCi ?? defaultCi),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn<(prId: string) => Promise<ReviewStatus>>().mockResolvedValue(overrides.reviewStatus ?? defaultReview),
    listPrs: vi.fn().mockResolvedValue([
      // Mock listPrs to return PR state for merge detection
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

// ─── Tests ───────────────────────────────────────────────────────────────────

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

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('AssessStack_MissingFeatureId_ReturnsInvalidInput', async () => {
      const args = { featureId: '', prNumbers: [1] };
      const result = await handleAssessStack(args, STATE_DIR);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('AssessStack_MissingPrNumbers_ReturnsInvalidInput', async () => {
      const args = { featureId: 'test-feature', prNumbers: [] };
      const result = await handleAssessStack(args, STATE_DIR);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('prNumbers');
    });
  });

  // ─── VcsProvider Integration ──────────────────────────────────────────────

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
        provider,
      );

      expect(result.success).toBe(true);
      expect(provider.getPrComments).toHaveBeenCalledWith('42');
    });
  });

  // ─── Happy Path ──────────────────────────────────────────────────────────

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

  // ─── CI Failure ──────────────────────────────────────────────────────────

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

  // ─── Unresolved Comments ─────────────────────────────────────────────────

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

  // ─── Comment Truncation (#965) ──────────────────────────────────────────

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
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      const commentBody = data.status.prs[0].unresolvedComments[0].body;
      expect(commentBody.length).toBeLessThanOrEqual(203); // 200 + '...'
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

  // ─── Recommendation Logic ───────────────────────────────────────────────

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
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('escalate');
    });
  });

  // ─── Shepherd Lifecycle Events ──────────────────────────────────────────

  describe('shepherd lifecycle events', () => {
    it('HandleAssessStack_FirstInvocation_EmitsShepherdStarted', async () => {
      mockQuery.mockResolvedValue([]);

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
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
        provider,
      );

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls.length).toBe(0);
    });

    it('HandleAssessStack_PrMerged_EmitsShepherdCompleted', async () => {
      mockQuery.mockResolvedValue([]);

      const provider = createMockProvider({
        checkCi: { status: 'pass', checks: [{ name: 'ci/build', status: 'pass' }] },
        prState: 'MERGED',
      });

      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
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

      // Assert — shepherd.approval_requested must NOT be emitted for merged PRs
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
        provider,
      );

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls).toHaveLength(0);
    });
  });

  // ─── Event Emission ──────────────────────────────────────────────────────

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

    it('AssessStack_EmitsGateExecutedEvents', async () => {
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
        provider,
      );

      const gateExecutedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'gate.executed',
      );
      expect(gateExecutedCalls.length).toBe(2);

      const gateIdempotencyKey = (gateExecutedCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(gateIdempotencyKey).toMatch(/iter-\d+$/);

      const firstGate = (gateExecutedCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(firstGate.gateName).toBe('ci/build');
      expect((firstGate.details as Record<string, unknown>).skill).toBe('shepherd');
      expect((firstGate.details as Record<string, unknown>).gate).toBe('ci/build');

      const secondGate = (gateExecutedCalls[1][1] as { data: Record<string, unknown> }).data;
      expect(secondGate.gateName).toBe('ci/test');
      expect(secondGate.passed).toBe(false);
    });
  });

  describe('comment body retention', () => {
    it('QueryPrComments_LongCommentBody_RetainsFullBody', async () => {
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
        provider,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ body: string; fullBody: string }> }> };
      };
      const comment = data.status.prs[0].unresolvedComments[0];
      expect(comment.fullBody).toBe(longBody);
      expect(comment.fullBody.length).toBe(500);
      expect(comment.body.length).toBeLessThanOrEqual(204);
    });
  });

  describe('ActionItem with reviewer-context fields', () => {
    it('ActionItem_WithReviewerFields_TypeChecks', async () => {
      const { ActionItem: _ActionItem } = await import('./assess-stack.js') as unknown as {
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
      } satisfies import('./assess-stack.js').ActionItem;
      expect(item.file).toBe('src/foo.ts');
      expect(item.normalizedSeverity).toBe('HIGH');
      expect(item.reviewer).toBe('coderabbit');
    });
  });
});
