// ─── Operational Resilience Action Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock gate-utils (getDiff + emitGateEvent) ─────────────────────────────

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('./gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
}));

// ─── Mock pure TS operational-resilience module ─────────────────────────────

vi.mock('./pure/operational-resilience.js', () => ({
  checkOperationalResilience: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { checkOperationalResilience } from './pure/operational-resilience.js';
import { handleOperationalResilience } from './operational-resilience.js';

const STATE_DIR = '/tmp/test-operational-resilience';

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

      const args = { featureId: 'feat-1' };
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

      const args = { featureId: 'feat-1' };
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

      const args = { featureId: 'feat-1' };
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

      const args = { featureId: 'feat-1' };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkOperationalResilience).not.toHaveBeenCalled();
    });
  });
});
