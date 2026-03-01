// ─── Review Verdict Action Tests ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process ──────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => ({}),
}));

import { execSync } from 'node:child_process';
import { handleReviewVerdict } from './review-verdict.js';

const STATE_DIR = '/tmp/test-review-verdict';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleReviewVerdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleReviewVerdict_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '', high: 0, medium: 0, low: 0 };

      // Act
      const result = await handleReviewVerdict(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Approved ────────────────────────────────────────────────────────────

  describe('approved verdict', () => {
    it('handleReviewVerdict_NoHighFindings_ReturnsApproved', async () => {
      // Arrange
      const stdout = 'Review verdict: APPROVED\nNo high-severity findings.';
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1', high: 0, medium: 1, low: 3 };

      // Act
      const result = await handleReviewVerdict(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        high: number;
        medium: number;
        low: number;
        report: string;
      };
      expect(data.verdict).toBe('APPROVED');
      expect(data.high).toBe(0);
      expect(data.medium).toBe(1);
      expect(data.low).toBe(3);
      expect(data.report).toContain('APPROVED');
    });
  });

  // ─── Needs Fixes ─────────────────────────────────────────────────────────

  describe('needs fixes verdict', () => {
    it('handleReviewVerdict_HighFindings_ReturnsNeedsFixes', async () => {
      // Arrange
      const stdout = 'Review verdict: NEEDS_FIXES\n2 high-severity findings.';
      const error = new Error('script failed') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 1;
      error.stdout = Buffer.from(stdout);
      error.stderr = Buffer.from('');
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = { featureId: 'feat-1', high: 2, medium: 1, low: 0 };

      // Act
      const result = await handleReviewVerdict(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        high: number;
        medium: number;
        low: number;
        report: string;
      };
      expect(data.verdict).toBe('NEEDS_FIXES');
      expect(data.high).toBe(2);
      expect(data.medium).toBe(1);
      expect(data.low).toBe(0);
      expect(data.report).toContain('NEEDS_FIXES');
    });
  });

  // ─── Blocked ─────────────────────────────────────────────────────────────

  describe('blocked verdict', () => {
    it('handleReviewVerdict_BlockedReason_ReturnsBlocked', async () => {
      // Arrange
      const stdout = 'Review verdict: BLOCKED\nReason: security-audit-pending';
      const error = new Error('script failed') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 2;
      error.stdout = Buffer.from(stdout);
      error.stderr = Buffer.from('');
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = {
        featureId: 'feat-1',
        high: 0,
        medium: 0,
        low: 0,
        blockedReason: 'security-audit-pending',
      };

      // Act
      const result = await handleReviewVerdict(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        high: number;
        medium: number;
        low: number;
        report: string;
      };
      expect(data.verdict).toBe('BLOCKED');
      expect(data.report).toContain('BLOCKED');
    });
  });

  // ─── Summary Gate Event ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleReviewVerdict_EmitsSummaryGateEvent', async () => {
      // Arrange
      const stdout = 'Review verdict: APPROVED';
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1', high: 0, medium: 2, low: 1 };

      // Act
      await handleReviewVerdict(args, STATE_DIR);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('review-verdict');
      expect(event.data.layer).toBe('review');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        verdict: 'APPROVED',
        phase: 'review',
        high: 0,
        medium: 2,
        low: 1,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleReviewVerdict_PerDimensionEvents_IncludePhaseInDetails', async () => {
      // Arrange
      const stdout = 'Review verdict: APPROVED';
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = {
        featureId: 'feat-1',
        high: 0,
        medium: 0,
        low: 0,
        dimensionResults: {
          D1: { passed: true, findingCount: 0 },
        },
      };

      // Act
      await handleReviewVerdict(args, STATE_DIR);

      // Assert — per-dimension event includes phase
      const perDimCall = mockStore.append.mock.calls[0];
      const perDimEvent = perDimCall[1] as {
        type: string;
        data: { details: Record<string, unknown> };
      };
      expect(perDimEvent.data.details.phase).toBe('review');
    });

    it('handleReviewVerdict_SummaryEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      const stdout = 'Review verdict: APPROVED';
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1', high: 0, medium: 0, low: 0 };

      // Act
      await handleReviewVerdict(args, STATE_DIR);

      // Assert — summary event includes phase
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const summaryCall = mockStore.append.mock.calls[0];
      const summaryEvent = summaryCall[1] as {
        type: string;
        data: { details: Record<string, unknown> };
      };
      expect(summaryEvent.data.details.phase).toBe('review');
    });
  });

  // ─── Per-Dimension Gate Events ──────────────────────────────────────────

  describe('per-dimension gate events', () => {
    it('handleReviewVerdict_WithDimensionResults_EmitsPerDimensionEvents', async () => {
      // Arrange
      const stdout = 'Review verdict: APPROVED';
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = {
        featureId: 'feat-1',
        high: 0,
        medium: 1,
        low: 2,
        dimensionResults: {
          D1: { passed: true, findingCount: 0 },
          D2: { passed: false, findingCount: 3 },
        },
      };

      // Act
      await handleReviewVerdict(args, STATE_DIR);

      // Assert — 2 per-dimension + 1 summary = 3 total
      expect(mockStore.append).toHaveBeenCalledTimes(3);

      // D1 dimension event
      const d1Call = mockStore.append.mock.calls[0];
      expect(d1Call[0]).toBe('feat-1');
      const d1Event = d1Call[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(d1Event.type).toBe('gate.executed');
      expect(d1Event.data.gateName).toBe('review-D1');
      expect(d1Event.data.layer).toBe('review');
      expect(d1Event.data.passed).toBe(true);
      expect(d1Event.data.details).toEqual({
        dimension: 'D1',
        phase: 'review',
        findingCount: 0,
      });

      // D2 dimension event
      const d2Call = mockStore.append.mock.calls[1];
      expect(d2Call[0]).toBe('feat-1');
      const d2Event = d2Call[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(d2Event.type).toBe('gate.executed');
      expect(d2Event.data.gateName).toBe('review-D2');
      expect(d2Event.data.layer).toBe('review');
      expect(d2Event.data.passed).toBe(false);
      expect(d2Event.data.details).toEqual({
        dimension: 'D2',
        phase: 'review',
        findingCount: 3,
      });

      // Summary event
      const summaryCall = mockStore.append.mock.calls[2];
      expect(summaryCall[0]).toBe('feat-1');
      const summaryEvent = summaryCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(summaryEvent.type).toBe('gate.executed');
      expect(summaryEvent.data.gateName).toBe('review-verdict');
      expect(summaryEvent.data.layer).toBe('review');
      expect(summaryEvent.data.passed).toBe(true);
      expect(summaryEvent.data.details).toEqual({
        verdict: 'APPROVED',
        phase: 'review',
        high: 0,
        medium: 1,
        low: 2,
      });
    });
  });
});
