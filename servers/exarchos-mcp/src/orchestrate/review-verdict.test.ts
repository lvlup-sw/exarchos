// ─── Review Verdict Action Tests ─────────────────────────────────────────────
//
// Tests for the pure TypeScript review verdict implementation.
// No bash script dependency — computes verdict and generates report in TS.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { handleReviewVerdict, computeVerdict, generateVerdictReport } from './review-verdict.js';

const STATE_DIR = '/tmp/test-review-verdict';

// ─── Tests: computeVerdict (pure function) ──────────────────────────────────

describe('computeVerdict', () => {
  it('computeVerdict_ZeroFindings_ReturnsApproved', () => {
    expect(computeVerdict({ high: 0, medium: 0, low: 0 })).toBe('APPROVED');
  });

  it('computeVerdict_OnlyMediumAndLow_ReturnsApproved', () => {
    expect(computeVerdict({ high: 0, medium: 5, low: 10 })).toBe('APPROVED');
  });

  it('computeVerdict_HighFindingsPresent_ReturnsNeedsFixes', () => {
    expect(computeVerdict({ high: 1, medium: 0, low: 0 })).toBe('NEEDS_FIXES');
  });

  it('computeVerdict_HighAndMedium_ReturnsNeedsFixes', () => {
    expect(computeVerdict({ high: 3, medium: 2, low: 1 })).toBe('NEEDS_FIXES');
  });

  it('computeVerdict_BlockedReason_ReturnsBlocked', () => {
    expect(computeVerdict({ high: 0, medium: 0, low: 0, blockedReason: 'Architecture redesign needed' })).toBe('BLOCKED');
  });

  it('computeVerdict_BlockedTakesPriorityOverHigh_ReturnsBlocked', () => {
    expect(computeVerdict({ high: 5, medium: 3, low: 1, blockedReason: 'Critical issue' })).toBe('BLOCKED');
  });
});

// ─── Tests: generateVerdictReport (pure function) ───────────────────────────

describe('generateVerdictReport', () => {
  it('generateVerdictReport_Approved_ContainsApprovedHeading', () => {
    const report = generateVerdictReport('APPROVED', { high: 0, medium: 1, low: 2 });
    expect(report).toContain('## Review Verdict: APPROVED');
    expect(report).toContain('No HIGH-severity findings');
    expect(report).toContain('0 high, 1 medium, 2 low');
  });

  it('generateVerdictReport_NeedsFixes_ContainsNeedsFixesHeading', () => {
    const report = generateVerdictReport('NEEDS_FIXES', { high: 2, medium: 1, low: 0 });
    expect(report).toContain('## Review Verdict: NEEDS_FIXES');
    expect(report).toContain('2 HIGH-severity findings');
    expect(report).toContain('2 high, 1 medium, 0 low');
  });

  it('generateVerdictReport_Blocked_ContainsBlockedHeading', () => {
    const report = generateVerdictReport('BLOCKED', { high: 0, medium: 0, low: 0, blockedReason: 'Security audit pending' });
    expect(report).toContain('## Review Verdict: BLOCKED');
    expect(report).toContain('Security audit pending');
  });
});

// ─── Tests: handleReviewVerdict (handler integration) ───────────────────────

describe('handleReviewVerdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleReviewVerdict_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '', high: 0, medium: 0, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('handleReviewVerdict_NegativeHigh_ReturnsError', async () => {
      const args = { featureId: 'feat-1', high: -1, medium: 0, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });

    it('handleReviewVerdict_NonFiniteHigh_ReturnsError', async () => {
      const args = { featureId: 'feat-1', high: NaN, medium: 0, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });

    it('handleReviewVerdict_InfinityMedium_ReturnsError', async () => {
      const args = { featureId: 'feat-1', high: 0, medium: Infinity, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });
  });

  // ─── Approved ────────────────────────────────────────────────────────────

  describe('approved verdict', () => {
    it('handleReviewVerdict_NoHighFindings_ReturnsApproved', async () => {
      const args = { featureId: 'feat-1', high: 0, medium: 1, low: 3 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

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

    it('handleReviewVerdict_ZeroFindings_ReturnsApproved', async () => {
      const args = { featureId: 'feat-1', high: 0, medium: 0, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { verdict: string };
      expect(data.verdict).toBe('APPROVED');
    });
  });

  // ─── Needs Fixes ─────────────────────────────────────────────────────────

  describe('needs fixes verdict', () => {
    it('handleReviewVerdict_HighFindings_ReturnsNeedsFixes', async () => {
      const args = { featureId: 'feat-1', high: 2, medium: 1, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

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

    it('handleReviewVerdict_SingleHighFinding_ReturnsNeedsFixes', async () => {
      const args = { featureId: 'feat-1', high: 1, medium: 0, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { verdict: string };
      expect(data.verdict).toBe('NEEDS_FIXES');
    });
  });

  // ─── Blocked ─────────────────────────────────────────────────────────────

  describe('blocked verdict', () => {
    it('handleReviewVerdict_BlockedReason_ReturnsBlocked', async () => {
      const args = {
        featureId: 'feat-1',
        high: 0,
        medium: 0,
        low: 0,
        blockedReason: 'security-audit-pending',
      };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        report: string;
      };
      expect(data.verdict).toBe('BLOCKED');
      expect(data.report).toContain('BLOCKED');
      expect(data.report).toContain('security-audit-pending');
    });

    it('handleReviewVerdict_BlockedWithHighFindings_ReturnsBlocked', async () => {
      const args = {
        featureId: 'feat-1',
        high: 5,
        medium: 0,
        low: 0,
        blockedReason: 'Critical flaw',
      };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { verdict: string };
      expect(data.verdict).toBe('BLOCKED');
    });
  });

  // ─── Report Format ──────────────────────────────────────────────────────

  describe('report format', () => {
    it('handleReviewVerdict_Report_ContainsMarkdownHeading', async () => {
      const args = { featureId: 'feat-1', high: 0, medium: 1, low: 2 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      const data = result.data as { report: string };
      expect(data.report).toContain('## Review Verdict:');
    });

    it('handleReviewVerdict_NeedsFixes_ReportContainsRoutingInstruction', async () => {
      const args = { featureId: 'feat-1', high: 2, medium: 0, low: 0 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      const data = result.data as { report: string };
      expect(data.report).toMatch(/delegate.*fixes/i);
    });

    it('handleReviewVerdict_Report_ContainsFindingSummary', async () => {
      const args = { featureId: 'feat-1', high: 1, medium: 2, low: 3 };
      const result = await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      const data = result.data as { report: string };
      expect(data.report).toContain('1 high, 2 medium, 3 low');
    });
  });

  // ─── Summary Gate Event ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleReviewVerdict_EmitsSummaryGateEvent', async () => {
      const args = { featureId: 'feat-1', high: 0, medium: 2, low: 1 };
      await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

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

    it('handleReviewVerdict_NeedsFixes_EmitsFailedGateEvent', async () => {
      const args = { featureId: 'feat-1', high: 3, medium: 0, low: 0 };
      await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.data.passed).toBe(false);
      expect(event.data.details.verdict).toBe('NEEDS_FIXES');
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleReviewVerdict_PerDimensionEvents_IncludePhaseInDetails', async () => {
      const args = {
        featureId: 'feat-1',
        high: 0,
        medium: 0,
        low: 0,
        dimensionResults: {
          D1: { passed: true, findingCount: 0 },
        },
      };
      await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      // Per-dimension event includes phase
      const perDimCall = mockStore.append.mock.calls[0];
      const perDimEvent = perDimCall[1] as {
        type: string;
        data: { details: Record<string, unknown> };
      };
      expect(perDimEvent.data.details.phase).toBe('review');
    });

    it('handleReviewVerdict_SummaryEvent_IncludesPhaseInDetails', async () => {
      const args = { featureId: 'feat-1', high: 0, medium: 0, low: 0 };
      await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const summaryCall = mockStore.append.mock.calls[0];
      const summaryEvent = summaryCall[1] as {
        type: string;
        data: { details: Record<string, unknown> };
      };
      expect(summaryEvent.data.details.phase).toBe('review');
    });
  });

  // ─── Plugin Findings ───────────────────────────────────────────────────

  describe('plugin findings', () => {
    it('HandleReviewVerdict_PluginFindings_MergesCountsIntoVerdict', async () => {
      const result = await handleReviewVerdict({
        featureId: 'test-plugin-merge',
        high: 0,
        medium: 1,
        low: 0,
        pluginFindings: [
          { source: 'catalog', severity: 'HIGH', message: 'Empty catch block' },
          { source: 'catalog', severity: 'MEDIUM', message: 'TODO found' },
        ],
      }, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(true);
      expect((result as { data: { high: number } }).data.high).toBe(1); // 0 native + 1 plugin HIGH
      expect((result as { data: { medium: number } }).data.medium).toBe(2); // 1 native + 1 plugin MEDIUM
      expect((result as { data: { verdict: string } }).data.verdict).toBe('NEEDS_FIXES');
    });

    it('HandleReviewVerdict_PluginHighFinding_EscalatesApprovedToNeedsFixes', async () => {
      const result = await handleReviewVerdict({
        featureId: 'test-plugin-escalate',
        high: 0,
        medium: 0,
        low: 0,
        pluginFindings: [
          { source: 'axiom', severity: 'HIGH', dimension: 'DIM-2', file: 'src/foo.ts', line: 42, message: 'Swallowed error' },
        ],
      }, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(true);
      expect((result as { data: { verdict: string } }).data.verdict).toBe('NEEDS_FIXES');
    });

    it('HandleReviewVerdict_PluginMediumOnly_DoesNotEscalate', async () => {
      const result = await handleReviewVerdict({
        featureId: 'test-plugin-medium',
        high: 0,
        medium: 0,
        low: 0,
        pluginFindings: [
          { source: 'catalog', severity: 'MEDIUM', message: 'Non-null assertion' },
        ],
      }, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(true);
      expect((result as { data: { verdict: string } }).data.verdict).toBe('APPROVED');
      expect((result as { data: { medium: number } }).data.medium).toBe(1);
    });

    it('HandleReviewVerdict_EmptyPluginFindings_NoEffect', async () => {
      const result = await handleReviewVerdict({
        featureId: 'test-plugin-empty',
        high: 0,
        medium: 2,
        low: 1,
        pluginFindings: [],
      }, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(true);
      expect((result as { data: { high: number } }).data.high).toBe(0);
      expect((result as { data: { medium: number } }).data.medium).toBe(2);
      expect((result as { data: { low: number } }).data.low).toBe(1);
      expect((result as { data: { verdict: string } }).data.verdict).toBe('APPROVED');
    });

    it('HandleReviewVerdict_NoPluginFindings_BackwardsCompatible', async () => {
      // Existing behavior — no pluginFindings param at all
      const result = await handleReviewVerdict({
        featureId: 'test-no-plugin',
        high: 1,
        medium: 0,
        low: 0,
      }, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(true);
      expect((result as { data: { verdict: string } }).data.verdict).toBe('NEEDS_FIXES');
    });
  });

  // ─── Per-Dimension Gate Events ──────────────────────────────────────────

  describe('per-dimension gate events', () => {
    it('handleReviewVerdict_WithDimensionResults_EmitsPerDimensionEvents', async () => {
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
      await handleReviewVerdict(args, STATE_DIR, mockStore as unknown as EventStore);

      // 2 per-dimension + 1 summary = 3 total
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
