// ─── Assess Stack Composite Action Tests ────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execSync for gh CLI calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { VcsProvider, CiStatus, ReviewStatus, PrComment } from '../vcs/provider.js';

// ─── Mock event store ────────────────────────────────────────────────────────

const mockAppend = vi.fn();
const mockQuery = vi.fn();

import type { EventStore } from '../event-store/store.js';
import { handleAssessStack, resolveCommentWindow } from './assess-stack.js';

const mockEventStore = {
  append: mockAppend,
  query: mockQuery,
} as unknown as EventStore;
import type { ReviewAdapterRegistry, ProviderAdapter, ReviewerKind } from '../review/types.js';
import { coderabbitAdapter } from '../review/providers/coderabbit.js';

const STATE_DIR = '/tmp/test-assess-stack';

// ─── DR-2 token-economy helpers ─────────────────────────────────────────────

// Coarse token estimate (~4 chars/token) over the serialized result. The audit
// measured assess_stack at 153,844 tokens on a 3-PR stack; DR-2's budget is
// ≤5,000 tokens for a comment-heavy (≥25-comment) single-PR fixture.
function estimateTokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

// A realistically large review comment whose UNIQUE tail marker sits well beyond
// COMMENT_BODY_LIMIT (200), so it survives ONLY in an undeduped full-body copy.
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

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

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

  // ─── Provider-Identity Gate (#1612/#1613) ─────────────────────────────────
  // assess_stack must NOT short-circuit for non-GitHub providers: every
  // provider call it makes is supported for GitLab/ADO or already fail-soft, so
  // the harvest proceeds and their PR/MR comments surface as action items.

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

      // Proceeds: success with a real assessment payload, not a skip stub.
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
      // The harvest actually ran against the non-GitHub provider.
      expect(provider.getPrComments).toHaveBeenCalledWith('42');
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
        mockEventStore,
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

    // DR-3 (#1595): the loop's iteration count is the COUNT of
    // `shepherd.iteration` events (the single event-sourced authority,
    // `countShepherdIterations`), NOT any `iteration` value stamped in a payload.
    // Five events with arbitrary / non-monotonic / duplicate payload `iteration`
    // values still report count 5 and escalate at maxIterations — proving the
    // loop never reads the payload value, so it can never disagree with the view.
    it('IterationCounter_SingleEventSourcedAuthority', async () => {
      const garbagePayloads = [99, 99, 1, 0, -3]; // duplicate, non-monotonic, garbage
      const iterationEvents = garbagePayloads.map((iteration, i) => ({
        type: 'shepherd.iteration',
        streamId: 'test-feature',
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        data: { prUrl: 'https://github.com/test/42', iteration, action: 'fix', outcome: 'retry' },
      }));
      // Only the `shepherd.iteration` query returns the events; every other
      // query (started/completed) is empty so the count is purely the event tally.
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
      // The count is exactly the number of events (5), independent of the
      // garbage/duplicate/non-monotonic payload `iteration` values.
      expect(data.status.iterationCount).toBe(garbagePayloads.length);
      // …and the bound (5) is reached by that count, so the loop escalates.
      expect(data.recommendation).toBe('escalate');
    });

    // DR-3 (#1595): the loop's escalation bound is config-resolvable via the
    // shared escalation policy. With `escalation.maxIterations: 3` injected, the
    // count reaches the bound at 3 events (where the default 5 would not yet
    // escalate). Same single counter, smaller resolved bound.
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
      // 3 events hit the config bound of 3 (the default 5 would say fix-and-resubmit).
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
        mockEventStore,
        provider,
      );

      const approvalCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'shepherd.approval_requested',
      );
      expect(approvalCalls).toHaveLength(0);
    });

    // DR-3 (#1595): hitting the auto-fix bound emits a STRUCTURED escalation
    // (NOT a hang — INV-10). The handler records reason + counts, then RETURNS
    // its normal terminal result with `recommendation:'escalate'`; it does not
    // loop or wait. Re-assessing at the same iteration count reuses the same
    // idempotency key, so the store dedups (no double-emit).
    it('BoundHit_EmitsStructuredEscalation_NotHang', async () => {
      // Seed N = default-maxIterations (5) `shepherd.iteration` events so the
      // single event-sourced counter reaches the bound, plus failing CI so there
      // are findings to fix — `computeRecommendation` returns 'escalate'.
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

      // (b) The handler RETURNS a terminal result with recommendation:'escalate'
      // — it returned (did not hang).
      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('escalate');

      // (a) A structured shepherd.escalated event is appended with the data.
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

      // (c) Idempotency — re-assessing at the same count reuses the same key, so
      // the store dedups (no double-emit). Assert the key is stable across calls.
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
        mockEventStore,
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
    it('QueryPrComments_LongCommentBody_TruncatedNoFullBodyCopy', async () => {
      // DR-2: the untruncated body is no longer retained on the comment. Only
      // the truncated `body` display copy survives — the dead `fullBody` field
      // is gone.
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
      // The dead field must be absent — not merely undefined.
      expect('fullBody' in comment).toBe(false);
      expect((comment.body as string).length).toBeLessThanOrEqual(204);
      // The untruncated 500-char body appears NOWHERE in the serialized result.
      expect(JSON.stringify(result.data).includes(longBody)).toBe(false);
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

  // ─── Adapter Parse Error Handling (#1161) ─────────────────────────────────

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

  // ─── Unified PR-Feedback Feed (DR-7, #1592 task 012) ──────────────────────
  // assess_stack consumes the widened, aggregated PrComment[] generically:
  // every source (issue-comment | review-inline | review-summary) and threaded
  // replies flow through the same harvest path with no source/workflowType
  // branch (INV-6). Tri-state `resolved` is honored: only resolved === true is
  // filtered out; absent (unknown) stays surfaced (absent ≠ false).

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
            // resolved absent → unknown → surfaced
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
            parentId: 1, // a reply — must NOT be dropped
            // resolved absent → unknown → surfaced
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
      // Threading is carried through for observability without branching.
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
            // resolved absent → unknown → surfaced
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

    it('AssessStack_ResolvedComment_NotSurfaced', async () => {
      // Pins absent ≠ resolved: an explicitly-resolved comment is excluded from
      // comment-reply action items, while an absent-`resolved` comment is kept.
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
            resolved: true, // explicitly resolved → filtered out
          },
          {
            id: 11,
            author: 'bob',
            body: 'Unknown-resolution thread — still needs attention',
            createdAt: '2026-01-01T00:00:00Z',
            source: 'review-inline',
            path: 'src/b.ts',
            line: 2,
            // resolved absent → unknown → surfaced
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
      // Only the absent-resolved comment is surfaced as an action item.
      expect(commentReplies).toHaveLength(1);
      expect(commentReplies[0].file).toBe('src/b.ts');

      const surfacedBodies = data.status.prs[0].unresolvedComments.map((c) => c.body);
      expect(surfacedBodies).toContain('Unknown-resolution thread — still needs attention');
      expect(surfacedBodies).not.toContain('Resolved thread — already handled');
    });

    it('AssessStack_HarvestLoop_NoWorkflowTypeBranch', async () => {
      // INV-6: the harvest path must consume comments generically — no
      // source-specific or workflowType-specific branch. Two assertions:
      //  (1) the assess-stack source carries no `workflowType` token at all;
      //  (2) behavior is identical regardless of comment `source` — every
      //      surface yields a comment-reply action item via the same path.
      const fs = await import('node:fs');
      const path = await import('node:url');
      const srcPath = path.fileURLToPath(new URL('./assess-stack.ts', import.meta.url));
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

  // ─── Multi-Provider Comment Surfacing (#1612/#1613, INV-6) ────────────────
  // assess_stack surfaces GitLab/ADO PR/MR comments as `comment-reply` action
  // items through the SAME provider-branch-free harvest path it uses for
  // GitHub. The mock providers differ only by `name`; the harvest reads
  // `getPrComments` generically, so identical comment payloads must yield
  // identical action items regardless of provider name.

  describe('multi-provider comment surfacing', () => {
    // A mix of resolved (filtered) and unresolved (surfaced) comments, reused
    // across the GitLab and ADO cases so the only variable is provider `name`.
    const mixedComments = (): PrComment[] => [
      {
        id: 1,
        author: 'alice',
        body: 'Please address this finding',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-inline',
        path: 'src/a.ts',
        line: 12,
        // resolved absent → unknown → surfaced
      },
      {
        id: 2,
        author: 'bob',
        body: 'Already handled in a prior push',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-inline',
        path: 'src/b.ts',
        line: 34,
        resolved: true, // explicitly resolved → filtered out
      },
      {
        id: 3,
        author: 'carol',
        body: 'Overall needs another pass on validation',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-summary',
        state: 'COMMENTED',
        // resolved absent → unknown → surfaced
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
      // Did NOT short-circuit for the non-GitHub provider.
      expect(data.skipped).toBeUndefined();
      expect(provider.getPrComments).toHaveBeenCalledWith('42');

      // The two unresolved comments surface as comment-reply items; the
      // explicitly-resolved one is filtered out.
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

    it('AssessStack_HarvestLoop_NoProviderBranch', async () => {
      // INV-6: the harvest path must NOT condition on provider name. Given the
      // SAME comment payload from a GitLab vs an ADO provider, the produced
      // comment-reply action items must be byte-for-byte identical.
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

      // Identical action items prove the harvest does not branch on provider.
      expect(gitlabItems).toHaveLength(2);
      expect(adoItems).toEqual(gitlabItems);
    });
  });

  // ─── DR-2: minimal types / token economy ──────────────────────────────────

  describe('DR-2 token economy', () => {
    it('assessStack_CommentHeavyStack_StaysUnderBudget', async () => {
      // The audit's #1 offender: a comment-heavy PR returned 153,844 tokens
      // because each ~2KB comment body was serialized up to 4× (fullBody +
      // two raw copies + truncated body). DR-2 caps + dedupes so a PR with 25
      // large unresolved comments stays ≤5,000 tokens total.
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

      // Perceivability: the default window caps the body-carrying list but the
      // full count stays visible so nothing is silently dropped.
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: unknown[]; commentPage: { total: number; hasMore: boolean } }> };
      };
      expect(data.status.prs[0].commentPage.total).toBe(25);
      expect(data.status.prs[0].commentPage.hasMore).toBe(true);
      expect(data.status.prs[0].unresolvedComments.length).toBeLessThan(25);
    });

    it('assessStack_UnresolvedComments_EachCommentSerializedOnce', async () => {
      // No comment body may be serialized more than once. Each fixture body has
      // a unique tail marker BEYOND the 200-char truncation limit, so it can
      // only appear via a full-body copy (the removed fullBody / raw fields).
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
        // The untruncated tail marker appears NOWHERE — no full-body copy exists.
        expect(serialized.includes(`_TAIL_MARKER_${c.id}_`)).toBe(false);
      }
      // The single truncated display copy appears exactly once per comment.
      for (const rc of rendered) {
        const occurrences = serialized.split(rc.body).length - 1;
        expect(occurrences).toBe(1);
      }
    });

    it('assessStack_PagedComments_EveryActionableReferenceReachable', async () => {
      // Shepherd-loop consumers page through the capped list and must reach
      // every unresolved actionable comment reference across pages.
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
        // Every actionable comment reference on this page resolves to a comment
        // present on the SAME page's unresolvedComments — no dangling reference.
        for (const ref of refs) {
          expect(ref.pr).toBe(42);
          expect(idsOnPage.has(ref.commentId)).toBe(true);
          reached.add(ref.commentId);
        }
      });

      // The union across all pages reaches every unresolved comment (1..25).
      expect([...reached].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
    });

    it('assessStack_AdapterConsumption_UnaffectedByFullBodyRemoval', async () => {
      // Deadness-precondition characterization: provider adapters parse the raw
      // VcsPrComment UPSTREAM of the result build (reading `comment.body`, never
      // a `fullBody` field — VcsPrComment has none). Removing the dead result
      // `fullBody` therefore cannot affect classification.
      const rawComment = {
        id: 7,
        author: 'coderabbitai[bot]',
        body: '_:warning: Potential issue_\n\nNull dereference on line 5.',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'review-inline' as const,
        path: 'src/auth.ts',
        line: 5,
      };

      // Direct upstream parse: the adapter derives everything from the raw body.
      const parsed = coderabbitAdapter.parse(rawComment);
      expect(parsed).not.toBeNull();
      expect(parsed?.normalizedSeverity).toBe('HIGH');
      expect(parsed?.description).toContain('Potential issue');
      expect(parsed?.file).toBe('src/auth.ts');

      // End-to-end: the same upstream parse flows into the top-level action item
      // even though the result no longer carries a fullBody copy.
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

    // Regression (CodeRabbit): a fractional limit floors to 0 and would slice an
    // EMPTY page, hiding every comment. It must fall back to the default.
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
