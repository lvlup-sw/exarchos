import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitReviewFindings, emitReviewEscalated } from './findings.js';
import type { EventStore } from '../event-store/store.js';
import type { ReviewFinding, ReviewEscalated } from '../event-store/schemas.js';
import { ReviewFindingData, ReviewEscalatedData } from '../event-store/schemas.js';

// ─── Test Helper ────────────────────────────────────────────────────────────

function createMockEventStore(): { append: ReturnType<typeof vi.fn> } {
  return {
    append: vi.fn().mockResolvedValue({}),
  };
}

// ─── emitReviewFindings Tests ───────────────────────────────────────────────

describe('emitReviewFindings', () => {
  let mockEventStore: ReturnType<typeof createMockEventStore>;

  beforeEach(() => {
    mockEventStore = createMockEventStore();
  });

  it('EmitReviewFinding_WithFinding_EmitsCorrectEvent', async () => {
    const findings: ReviewFinding[] = [
      {
        pr: 42,
        source: 'coderabbit',
        severity: 'critical',
        filePath: 'src/auth/login.ts',
        lineRange: [10, 25],
        message: 'SQL injection vulnerability detected',
        rule: 'security/sql-injection',
      },
    ];

    await emitReviewFindings(
      findings,
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = mockEventStore.append.mock.calls[0];
    expect(streamId).toBe('test-stream');
    expect(event.type).toBe('review.finding');
    expect(event.data.pr).toBe(42);
    expect(event.data.source).toBe('coderabbit');
    expect(event.data.severity).toBe('critical');
    expect(event.data.filePath).toBe('src/auth/login.ts');
    expect(event.data.lineRange).toEqual([10, 25]);
    expect(event.data.message).toBe('SQL injection vulnerability detected');
    expect(event.data.rule).toBe('security/sql-injection');

    // Validate against schema
    const parseResult = ReviewFindingData.safeParse(event.data);
    expect(parseResult.success).toBe(true);
  });

  it('EmitReviewFinding_MultipleFindingsEachGetsEvent', async () => {
    const findings: ReviewFinding[] = [
      {
        pr: 42,
        source: 'coderabbit',
        severity: 'critical',
        filePath: 'src/auth/login.ts',
        message: 'SQL injection',
      },
      {
        pr: 42,
        source: 'self-hosted',
        severity: 'minor',
        filePath: 'src/utils/format.ts',
        message: 'Unused import',
      },
    ];

    await emitReviewFindings(
      findings,
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).toHaveBeenCalledTimes(2);
    expect(mockEventStore.append.mock.calls[0][1].data.severity).toBe('critical');
    expect(mockEventStore.append.mock.calls[1][1].data.severity).toBe('minor');
  });

  it('EmitReviewFinding_EmptyFindings_NoEvents', async () => {
    await emitReviewFindings(
      [],
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).not.toHaveBeenCalled();
  });

  it('EmitReviewFinding_OptionalFieldsOmitted_EmitsCorrectEvent', async () => {
    const findings: ReviewFinding[] = [
      {
        pr: 100,
        source: 'self-hosted',
        severity: 'suggestion',
        filePath: 'src/utils.ts',
        message: 'Consider extracting helper',
        // lineRange and rule omitted
      },
    ];

    await emitReviewFindings(
      findings,
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).toHaveBeenCalledTimes(1);
    const [, event] = mockEventStore.append.mock.calls[0];
    expect(event.data.lineRange).toBeUndefined();
    expect(event.data.rule).toBeUndefined();

    const parseResult = ReviewFindingData.safeParse(event.data);
    expect(parseResult.success).toBe(true);
  });

  it('EmitReviewFinding_AppendFailure_DoesNotThrow', async () => {
    mockEventStore.append.mockRejectedValue(new Error('append failed'));

    const findings: ReviewFinding[] = [
      {
        pr: 42,
        source: 'coderabbit',
        severity: 'major',
        filePath: 'src/auth.ts',
        message: 'Missing auth check',
      },
    ];

    // Should not throw even when append fails
    await expect(
      emitReviewFindings(findings, 'test-stream', mockEventStore as unknown as EventStore),
    ).resolves.not.toThrow();
  });
});

// ─── emitReviewEscalated Tests ──────────────────────────────────────────────

describe('emitReviewEscalated', () => {
  let mockEventStore: ReturnType<typeof createMockEventStore>;

  beforeEach(() => {
    mockEventStore = createMockEventStore();
  });

  it('EmitReviewEscalated_HighRisk_EmitsEvent', async () => {
    const escalation: ReviewEscalated = {
      pr: 42,
      reason: 'Critical security finding requires human review',
      originalScore: 0.85,
      triggeringFinding: 'SQL injection vulnerability in auth module',
    };

    await emitReviewEscalated(
      escalation,
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = mockEventStore.append.mock.calls[0];
    expect(streamId).toBe('test-stream');
    expect(event.type).toBe('review.escalated');
    expect(event.data.pr).toBe(42);
    expect(event.data.reason).toBe('Critical security finding requires human review');
    expect(event.data.originalScore).toBe(0.85);
    expect(event.data.triggeringFinding).toBe('SQL injection vulnerability in auth module');

    // Validate against schema
    const parseResult = ReviewEscalatedData.safeParse(event.data);
    expect(parseResult.success).toBe(true);
  });

  it('EmitReviewEscalated_AppendFailure_DoesNotThrow', async () => {
    mockEventStore.append.mockRejectedValue(new Error('append failed'));

    const escalation: ReviewEscalated = {
      pr: 42,
      reason: 'Critical finding',
      originalScore: 0.9,
      triggeringFinding: 'Auth bypass detected',
    };

    await expect(
      emitReviewEscalated(escalation, 'test-stream', mockEventStore as unknown as EventStore),
    ).resolves.not.toThrow();
  });
});
