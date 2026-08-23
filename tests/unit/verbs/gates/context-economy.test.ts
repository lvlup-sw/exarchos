// ─── Context Economy Action Tests ───────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

// ─── Mock gate-utils (getDiff + emitGateEvent) ─────────────────────────────

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
}));

// ─── Mock pure TS context-economy module ────────────────────────────────────

vi.mock('../../../../src/verbs/pure/context-economy.js', () => ({
  checkContextEconomy: vi.fn(),
}));

// ─── Mock event store and materializer ───────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

const mockTelemetryState = {
  tools: {} as Record<string, unknown>,
  sessionStart: '2026-01-01T00:00:00.000Z',
  totalInvocations: 0,
  totalTokens: 0,
  windowSize: 1000,
};

const mockMaterializer = {
  materialize: vi.fn(() => mockTelemetryState),
  getState: vi.fn(() => null),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

// #1855 — the gate folds its view to the stream's durable tail through
// `foldToTail` rather than pairing `queryDeltaEvents` with a bare
// `materialize`. The fold is the seam a unit test of the VERDICT should stub:
// what the fold itself guarantees is covered against a real store in
// `tests/unit/projections/fold-at-tail.test.ts`.
// `foldToTail` guarantees the fold covers the stream's durable tail, and
// callers now bound their own evidence to the sequence it reports. These
// fixtures ARE the stream, so the stub reports a sequence at or past every
// fixture event; a lower one would assert a lag this file never sets up.
const AT_TAIL = Number.MAX_SAFE_INTEGER;

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: vi.fn(async () => ({ view: mockTelemetryState, sequence: AT_TAIL })),
}));

import { checkContextEconomy } from '../../../../src/verbs/pure/context-economy.js';
import { handleContextEconomy } from '../../../../src/verbs/gates/context-economy.js';

const STATE_DIR = '/tmp/test-context-economy';

/**
 * The tests below hand the gate an explicit base so they measure the gate, not
 * the machine: without one the handler DETECTS the repository's default branch,
 * and a checkout with no `origin/HEAD` (a CI clone, a fresh worktree) would send
 * every case down the inconclusive path. The detection path has its own case at
 * the bottom of each file.
 */
const BASE = 'main';

/** A path that is not a git repository, so detection cannot answer. */
const NO_REPO = '/exarchos-not-a-repository';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleContextEconomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleContextEconomy_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Clean Code ────────────────────────────────────────────────────────

  describe('clean code', () => {
    it('handleContextEconomy_CleanCode_ReturnsPassed', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: PASS');
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleContextEconomy_Findings_ReturnsFailWithCount', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: false,
        checksRun: 4,
        checksPassed: 2,
        findings: [
          { severity: 'MEDIUM', message: '`src/big-file.ts` — Source file exceeds 400 lines (520 lines)' },
          { severity: 'MEDIUM', message: 'Diff breadth: 35 files changed (threshold: 30)' },
        ],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(2);
      expect(data.report).toContain('FINDINGS');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleContextEconomy_EmitsGateEvent_WithD3Dimension', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitGateEvent).toHaveBeenCalledWith(
        mockStore,
        'feat-1',
        'context-economy',
        'quality',
        true,
        { dimension: 'D3', phase: 'review', findingCount: 0 },
      );
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleContextEconomy_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      const details = mockEmitGateEvent.mock.calls[0][5] as Record<string, unknown>;
      expect(details.phase).toBe('review');
    });
  });

  // ─── Git Diff Failure (fail-closed) ───────────────────────────────────────

  describe('git diff failure', () => {
    it('handleContextEconomy_GitDiffFails_ReturnsError', async () => {
      mockGetDiff.mockReturnValue(null);

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkContextEconomy).not.toHaveBeenCalled();
    });
  });

  // ─── Telemetry Integration ────────────────────────────────────────────────

  describe('telemetry integration', () => {
    it('handleContextEconomy_WithTelemetryData_IncludesRuntimeMetricsInResult', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      mockTelemetryState.tools = {
        'exarchos_workflow': {
          invocations: 5,
          errors: 0,
          totalDurationMs: 1000,
          totalBytes: 2000,
          totalTokens: 3000,
          p50DurationMs: 200,
          p95DurationMs: 400,
          p50Bytes: 400,
          p95Bytes: 800,
          p50Tokens: 600,
          p95Tokens: 1200,
          durations: [],
          sizes: [],
          tokenEstimates: [],
        },
        'exarchos_view': {
          invocations: 5,
          errors: 0,
          totalDurationMs: 500,
          totalBytes: 1000,
          totalTokens: 2000,
          p50DurationMs: 100,
          p95DurationMs: 200,
          p50Bytes: 200,
          p95Bytes: 400,
          p50Tokens: 400,
          p95Tokens: 800,
          durations: [],
          sizes: [],
          tokenEstimates: [],
        },
      };
      mockTelemetryState.totalTokens = 5000;
      mockTelemetryState.totalInvocations = 10;

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        runtimeMetrics: {
          sessionTokens: number;
          toolCount: number;
          totalInvocations: number;
        };
      };
      expect(data.runtimeMetrics).toBeDefined();
      expect(data.runtimeMetrics.sessionTokens).toBe(5000);
      expect(data.runtimeMetrics.toolCount).toBe(2);
      expect(data.runtimeMetrics.totalInvocations).toBe(10);
    });

    it('handleContextEconomy_WithoutTelemetryData_ReturnsZeroMetrics', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      mockTelemetryState.tools = {};
      mockTelemetryState.totalTokens = 0;
      mockTelemetryState.totalInvocations = 0;

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        runtimeMetrics: {
          sessionTokens: number;
          toolCount: number;
          totalInvocations: number;
        };
      };
      expect(data.runtimeMetrics).toBeDefined();
      expect(data.runtimeMetrics.sessionTokens).toBe(0);
      expect(data.runtimeMetrics.toolCount).toBe(0);
      expect(data.runtimeMetrics.totalInvocations).toBe(0);
    });
  });

  // ─── Base-branch resolution ──────────────────────────────────────────────

  describe('base branch', () => {
    it('handleContextEconomy_UnresolvedBase_IsInconclusive_NotPass', async () => {
      // No explicit base and no detectable default branch: there is no diff to
      // judge. The carrier says so instead of reporting a clean review of a
      // range that was never computed.
      const result = await handleContextEconomy(
        { featureId: 'feat-1', repoRoot: NO_REPO },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; skipped?: boolean; discriminant?: string };
      expect(data.passed).toBe(false);
      expect(data.skipped).toBe(true);
      expect(data.discriminant).toBe('base-branch-unresolved');
      // The diff was never attempted, so nothing was judged.
      expect(mockGetDiff).not.toHaveBeenCalled();

      // Indeterminate is a verdict, and this action declares `gate.executed`
      // UNCONDITIONALLY. A success carrier without it is the drift the
      // post-dispatch emission verifier reports — and it leaves the durable log
      // unable to tell an unscoped run from one that never happened.
      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      const [, streamId, gateName, layer, passed, details] = mockEmitGateEvent.mock.calls[0]!;
      expect(streamId).toBe('feat-1');
      expect(gateName).toBe('context-economy');
      expect(layer).toBe('quality');
      // Fail-closed on the wire, and the markers say WHY, so no reader takes it
      // for a gate that ran and found a fault.
      expect(passed).toBe(false);
      expect(details).toMatchObject({
        skipped: true,
        discriminant: 'base-branch-unresolved',
        findingCount: 0,
      });
    });

    it('handleContextEconomy_ExplicitBase_IsUsedVerbatim', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        findings: [],
        checksRun: 1,
        checksPassed: 1,
      });

      await handleContextEconomy(
        { featureId: 'feat-1', repoRoot: '/repo', baseBranch: 'release/2026.09' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(mockGetDiff).toHaveBeenCalledWith('/repo', 'release/2026.09');
    });
  });
});
