// ─── Operational Resilience Action Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

// ─── Mock gate-utils (getDiff + emitGateEvent) ─────────────────────────────

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
}));

// ─── Mock pure TS operational-resilience module ─────────────────────────────

vi.mock('../../../../src/verbs/pure/operational-resilience.js', () => ({
  checkOperationalResilience: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { checkOperationalResilience } from '../../../../src/verbs/pure/operational-resilience.js';
import { handleOperationalResilience } from '../../../../src/verbs/gates/operational-resilience.js';

const STATE_DIR = '/tmp/test-operational-resilience';

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

describe('handleOperationalResilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleOperationalResilience_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Clean Code ────────────────────────────────────────────────────────

  describe('clean code', () => {
    it('handleOperationalResilience_CleanCode_ReturnsPassed', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; findingCount: number; report: string };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: PASS');
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleOperationalResilience_Findings_ReturnsFailWithCount', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: false,
        findingCount: 3,
        findings: [
          { severity: 'HIGH', message: '`src/handler.ts` — Empty catch block detected' },
          { severity: 'MEDIUM', message: '`src/service.ts` — console.log in source file' },
          { severity: 'MEDIUM', message: '`src/retry.ts` — Unbounded retry loop' },
        ],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; findingCount: number; report: string };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(3);
      expect(data.report).toContain('FINDINGS');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleOperationalResilience_EmitsGateEvent_WithD4Dimension', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitGateEvent).toHaveBeenCalledWith(
        mockStore,
        'feat-1',
        'operational-resilience',
        'quality',
        true,
        { dimension: 'D4', phase: 'review', findingCount: 0 },
      );
    });
  });

  // ─── Git Diff Failure (fail-closed) ───────────────────────────────────────

  describe('git diff failure', () => {
    it('handleOperationalResilience_GitDiffFails_ReturnsError', async () => {
      mockGetDiff.mockReturnValue(null);

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkOperationalResilience).not.toHaveBeenCalled();
    });
  });

  // ─── Base-branch resolution ──────────────────────────────────────────────

  describe('base branch', () => {
    it('handleOperationalResilience_UnresolvedBase_IsInconclusive_NotPass', async () => {
      const result = await handleOperationalResilience(
        { featureId: 'feat-1', repoRoot: NO_REPO },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; skipped?: boolean; discriminant?: string };
      expect(data.passed).toBe(false);
      expect(data.skipped).toBe(true);
      expect(data.discriminant).toBe('base-branch-unresolved');
      expect(mockGetDiff).not.toHaveBeenCalled();

      // Indeterminate is a verdict, and this action declares `gate.executed`
      // UNCONDITIONALLY. A success carrier without it is the drift the
      // post-dispatch emission verifier reports — and it leaves the durable log
      // unable to tell an unscoped run from one that never happened.
      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      const [, streamId, gateName, layer, passed, details] = mockEmitGateEvent.mock.calls[0]!;
      expect(streamId).toBe('feat-1');
      expect(gateName).toBe('operational-resilience');
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
  });
});
