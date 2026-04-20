// ─── Shepherd → Classifier Integration Smoke Test (Issue #1159 T25) ─────────
//
// End-to-end: a mocked PR with comments from CodeRabbit (Critical),
// Sentry (Medium), and a human (nit) flows through assess_stack →
// the adapter registry → classify_review_items, and the classifier's
// per-group recommendations match the per-reviewer severity routing.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import type { VcsProvider, CiStatus, ReviewStatus, PrComment } from '../../vcs/provider.js';
import { handleAssessStack } from '../../orchestrate/assess-stack.js';
import { handleClassifyReviewItems } from '../../orchestrate/classify-review-items.js';
import type { ActionItem } from '../../review/types.js';

const mockAppend = vi.fn();
const mockQuery = vi.fn().mockResolvedValue([]);

vi.mock('../../event-store/store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({
    append: mockAppend,
    query: mockQuery,
  })),
}));

const STATE_DIR = '/tmp/test-shepherd-classifier-integration';

function mockProvider(comments: PrComment[]): VcsProvider {
  const ci: CiStatus = {
    status: 'pass',
    checks: [{ name: 'ci/build', status: 'pass' }],
  };
  const review: ReviewStatus = { state: 'pending', reviewers: [] };
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn().mockResolvedValue(ci),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn().mockResolvedValue(review),
    listPrs: vi.fn().mockResolvedValue([]),
    getPrComments: vi.fn().mockResolvedValue(comments),
    getRepository: vi.fn(),
    getPrChecks: vi.fn(),
    setAutoMerge: vi.fn(),
  } as unknown as VcsProvider;
}

describe('shepherd → classifier integration (#1159)', () => {
  it('ShepherdIteration_MixedSeverityComments_RoutesPerClassifier', async () => {
    const comments: PrComment[] = [
      // CodeRabbit Critical → HIGH → delegate-fixer
      {
        id: 1,
        author: 'coderabbitai[bot]',
        body: '_:warning: Potential issue_\n\nNull dereference risk in auth path.',
        createdAt: '2026-01-01T00:00:00Z',
        path: 'src/auth.ts',
        line: 42,
      },
      // Sentry Medium → MEDIUM → direct
      {
        id: 2,
        author: 'sentry-io[bot]',
        body: 'Severity: MEDIUM\n\nProbable type coercion in handler.',
        createdAt: '2026-01-01T00:00:00Z',
        path: 'src/handler.ts',
        line: 17,
      },
      // Human nit → MEDIUM → direct
      {
        id: 3,
        author: 'alice',
        body: 'Could you rename this variable for clarity?',
        createdAt: '2026-01-01T00:00:00Z',
        path: 'src/util.ts',
        line: 5,
      },
    ];

    const assessResult = await handleAssessStack(
      { featureId: 'feat-integration', prNumbers: [42] },
      STATE_DIR,
      mockProvider(comments),
    );

    expect(assessResult.success).toBe(true);
    const assessData = assessResult.data as { actionItems: ActionItem[] };
    const commentReplyItems = assessData.actionItems.filter((i) => i.type === 'comment-reply');
    expect(commentReplyItems).toHaveLength(3);

    const classifyResult = await handleClassifyReviewItems({
      featureId: 'feat-integration',
      actionItems: commentReplyItems,
    });

    expect(classifyResult.success).toBe(true);
    const result = classifyResult.data as {
      groups: Array<{ file: string | null; recommendation: string; severity: string }>;
      summary: { totalItems: number; directCount: number; delegateCount: number };
    };

    expect(result.summary.totalItems).toBe(3);
    expect(result.groups).toHaveLength(3);

    const byFile = new Map(result.groups.map((g) => [g.file, g]));

    const authGroup = byFile.get('src/auth.ts');
    expect(authGroup?.severity).toBe('HIGH');
    expect(authGroup?.recommendation).toBe('delegate-fixer');

    const handlerGroup = byFile.get('src/handler.ts');
    expect(handlerGroup?.severity).toBe('MEDIUM');
    expect(handlerGroup?.recommendation).toBe('direct');

    const utilGroup = byFile.get('src/util.ts');
    expect(utilGroup?.severity).toBe('MEDIUM');
    expect(utilGroup?.recommendation).toBe('direct');
  });
});
