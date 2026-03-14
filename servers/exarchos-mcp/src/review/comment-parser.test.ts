import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';

// ─── Test Helper ────────────────────────────────────────────────────────────

function createMockEventStore(): { append: ReturnType<typeof vi.fn> } {
  return {
    append: vi.fn().mockResolvedValue({}),
  };
}

// ─── parseReviewComments Tests ──────────────────────────────────────────────

describe('parseReviewComments', () => {
  it('parseReviewComments_CodeRabbitFormat_ExtractsFilePathAndSeverity', async () => {
    const { parseReviewComments } = await import('./comment-parser.js');

    const comments = [
      {
        body: '[bug] SQL injection vulnerability in auth module',
        path: 'src/auth/login.ts',
        line: 42,
        author: 'coderabbitai',
      },
    ];

    const findings = parseReviewComments(comments);

    expect(findings).toHaveLength(1);
    expect(findings[0].filePath).toBe('src/auth/login.ts');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].message).toBe('[bug] SQL injection vulnerability in auth module');
  });

  it('parseReviewComments_MultipleComments_ReturnsAllFindings', async () => {
    const { parseReviewComments } = await import('./comment-parser.js');

    const comments = [
      {
        body: '[bug] Missing null check',
        path: 'src/utils.ts',
        line: 10,
        author: 'coderabbitai',
      },
      {
        body: '[suggestion] Consider extracting helper',
        path: 'src/format.ts',
        line: 25,
        author: 'coderabbitai',
      },
      {
        body: '[warning] Potential race condition',
        path: 'src/store.ts',
        line: 50,
        author: 'coderabbitai',
      },
    ];

    const findings = parseReviewComments(comments);

    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe('critical');
    expect(findings[1].severity).toBe('minor');
    expect(findings[2].severity).toBe('major');
  });

  it('parseReviewComments_EmptyComments_ReturnsEmptyArray', async () => {
    const { parseReviewComments } = await import('./comment-parser.js');

    const findings = parseReviewComments([]);
    expect(findings).toEqual([]);
  });

  it('parseReviewComments_MissingSeverity_DefaultsToInfo', async () => {
    const { parseReviewComments } = await import('./comment-parser.js');

    const comments = [
      {
        body: 'This looks fine but could use some cleanup',
        path: 'src/index.ts',
        line: 5,
        author: 'reviewer',
      },
    ];

    const findings = parseReviewComments(comments);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('suggestion');
  });
});

// ─── emitParsedFindings Tests ───────────────────────────────────────────────

describe('emitParsedFindings', () => {
  let mockEventStore: ReturnType<typeof createMockEventStore>;

  beforeEach(() => {
    mockEventStore = createMockEventStore();
  });

  it('emitParsedFindings_HighSeverity_TriggersEscalation', async () => {
    const { emitParsedFindings } = await import('./comment-parser.js');

    const findings = [
      {
        pr: 42,
        source: 'coderabbit' as const,
        severity: 'critical' as const,
        filePath: 'src/auth.ts',
        message: 'SQL injection',
      },
    ];

    await emitParsedFindings(
      findings,
      'test-stream',
      mockEventStore as unknown as EventStore,
      'high',
    );

    // Should call append at least twice: once for finding, once for escalation
    expect(mockEventStore.append.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Verify the review.finding event
    const findingCall = mockEventStore.append.mock.calls.find(
      (c: unknown[]) => (c[1] as { type: string }).type === 'review.finding',
    );
    expect(findingCall).toBeDefined();

    // Verify the review.escalated event
    const escalatedCall = mockEventStore.append.mock.calls.find(
      (c: unknown[]) => (c[1] as { type: string }).type === 'review.escalated',
    );
    expect(escalatedCall).toBeDefined();
  });

  it('emitParsedFindings_LowSeverity_EmitsFindingOnly', async () => {
    const { emitParsedFindings } = await import('./comment-parser.js');

    const findings = [
      {
        pr: 42,
        source: 'coderabbit' as const,
        severity: 'suggestion' as const,
        filePath: 'src/utils.ts',
        message: 'Consider renaming',
      },
    ];

    await emitParsedFindings(
      findings,
      'test-stream',
      mockEventStore as unknown as EventStore,
      'high',
    );

    // Should only emit finding events, no escalation
    const findingCalls = mockEventStore.append.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type: string }).type === 'review.finding',
    );
    const escalatedCalls = mockEventStore.append.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type: string }).type === 'review.escalated',
    );

    expect(findingCalls).toHaveLength(1);
    expect(escalatedCalls).toHaveLength(0);
  });
});
