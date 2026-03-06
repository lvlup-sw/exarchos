// ─── Assess Stack Composite Action Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process for gh CLI calls ─────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockAppend = vi.fn();
const mockQuery = vi.fn();

vi.mock('../event-store/store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({
    append: mockAppend,
    query: mockQuery,
  })),
}));

import { execSync } from 'node:child_process';
import { handleAssessStack } from './assess-stack.js';

const STATE_DIR = '/tmp/test-assess-stack';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeChecksOutput(checks: Array<{ name: string; status: string; url?: string }>): string {
  return JSON.stringify(checks.map(c => ({
    name: c.name,
    state: c.status === 'pass' ? 'SUCCESS' : c.status === 'fail' ? 'FAILURE' : 'PENDING',
    targetUrl: c.url ?? '',
  })));
}

function makeReviewsOutput(reviews: Array<{ state: string; author: string }>): string {
  return JSON.stringify(reviews);
}

function makeCommentsOutput(comments: Array<{ body: string; isResolved: boolean }>): string {
  return JSON.stringify(comments);
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
      // Arrange
      const args = { featureId: '', prNumbers: [1] };

      // Act
      const result = await handleAssessStack(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('AssessStack_MissingPrNumbers_ReturnsInvalidInput', async () => {
      // Arrange
      const args = { featureId: 'test-feature', prNumbers: [] };

      // Act
      const result = await handleAssessStack(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('prNumbers');
    });
  });

  // ─── Happy Path ──────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('AssessStack_ValidInput_ReturnsShepherdStatus', async () => {
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'pass' },
        { name: 'ci/test', status: 'pass' },
      ]);
      const reviewsOutput = makeReviewsOutput([
        { state: 'APPROVED', author: 'reviewer1' },
      ]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
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
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'fail' },
        { name: 'ci/test', status: 'pass' },
      ]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
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
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'pass' },
      ]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([
        { body: 'Please fix this logic', isResolved: false },
      ]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
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
      // Arrange
      const longBody = 'x'.repeat(500);
      const checksOutput = makeChecksOutput([{ name: 'ci/build', status: 'pass' }]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([
        { body: longBody, isResolved: false },
      ]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        status: { prs: Array<{ unresolvedComments: Array<{ body: string }> }> };
      };
      const commentBody = data.status.prs[0].unresolvedComments[0].body;
      expect(commentBody.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(commentBody.endsWith('...')).toBe(true);
    });

    it('AssessStack_ShortCommentBody_NotTruncated', async () => {
      // Arrange
      const shortBody = 'This is a short comment';
      const checksOutput = makeChecksOutput([{ name: 'ci/build', status: 'pass' }]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([
        { body: shortBody, isResolved: false },
      ]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
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
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'pass' },
        { name: 'ci/test', status: 'pass' },
      ]);
      const reviewsOutput = makeReviewsOutput([
        { state: 'APPROVED', author: 'reviewer1' },
      ]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('request-approval');
    });

    it('AssessStack_BlockingIssues_RecommendsFixAndResubmit', async () => {
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'fail' },
      ]);
      const reviewsOutput = makeReviewsOutput([
        { state: 'CHANGES_REQUESTED', author: 'reviewer1' },
      ]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('fix-and-resubmit');
    });

    it('AssessStack_PendingCi_RecommendsWait', async () => {
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'pending' },
      ]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('wait');
    });

    it('AssessStack_MaxIterations_RecommendsEscalate', async () => {
      // Arrange — simulate max iterations via prior shepherd.iteration events
      const iterationEvents = Array.from({ length: 5 }, (_, i) => ({
        type: 'shepherd.iteration',
        streamId: 'test-feature',
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        data: { prUrl: 'https://github.com/test/42', iteration: i + 1, action: 'fix', outcome: 'retry' },
      }));
      mockQuery.mockResolvedValue(iterationEvents);

      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'fail' },
      ]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      const result = await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { recommendation: string };
      expect(data.recommendation).toBe('escalate');
    });
  });

  // ─── Event Emission ──────────────────────────────────────────────────────

  describe('event emission', () => {
    it('AssessStack_EmitsCiStatusEvents', async () => {
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'pass' },
      ]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert — ci.status event emitted per PR with schema-mapped value
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
      // Arrange
      const checksOutput = makeChecksOutput([
        { name: 'ci/build', status: 'pass' },
        { name: 'ci/test', status: 'fail' },
      ]);
      const reviewsOutput = makeReviewsOutput([]);
      const commentsOutput = makeCommentsOutput([]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('checks')) return Buffer.from(checksOutput);
        if (cmdStr.includes('reviews')) return Buffer.from(reviewsOutput);
        if (cmdStr.includes('comments')) return Buffer.from(commentsOutput);
        return Buffer.from('[]');
      });

      // Act
      await handleAssessStack(
        { featureId: 'test-feature', prNumbers: [42] },
        STATE_DIR,
      );

      // Assert — gate.executed events emitted per CI check (flywheel integration)
      const gateExecutedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'gate.executed',
      );
      expect(gateExecutedCalls.length).toBe(2);

      // Verify deterministic idempotency keys (iter-based, not Date.now)
      const gateIdempotencyKey = (gateExecutedCalls[0][2] as { idempotencyKey: string })?.idempotencyKey;
      expect(gateIdempotencyKey).toMatch(/iter-\d+$/);

      // Verify flywheel metadata
      const firstGate = (gateExecutedCalls[0][1] as { data: Record<string, unknown> }).data;
      expect(firstGate.gateName).toBe('ci/build');
      expect((firstGate.details as Record<string, unknown>).skill).toBe('shepherd');
      expect((firstGate.details as Record<string, unknown>).gate).toBe('ci/build');

      const secondGate = (gateExecutedCalls[1][1] as { data: Record<string, unknown> }).data;
      expect(secondGate.gateName).toBe('ci/test');
      expect(secondGate.passed).toBe(false);
    });
  });
});
