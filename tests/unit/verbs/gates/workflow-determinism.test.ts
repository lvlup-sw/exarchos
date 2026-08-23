// ─── Workflow Determinism Action Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

// ─── Mock gate-utils (getDiff + emitGateEvent) ─────────────────────────────

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
}));

// ─── Mock pure TS workflow-determinism module ───────────────────────────────

vi.mock('../../../../src/verbs/pure/workflow-determinism.js', () => ({
  checkWorkflowDeterminism: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { checkWorkflowDeterminism } from '../../../../src/verbs/pure/workflow-determinism.js';
import { handleWorkflowDeterminism } from '../../../../src/verbs/gates/workflow-determinism.js';

const STATE_DIR = '/tmp/test-workflow-determinism';

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

describe('handleWorkflowDeterminism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleWorkflowDeterminism_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Clean Code ────────────────────────────────────────────────────────

  describe('clean code', () => {
    it('handleWorkflowDeterminism_CleanCode_ReturnsPassed', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; findingCount: number; report: string };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: PASS');
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleWorkflowDeterminism_Findings_ReturnsFailWithCount', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.test.ts b/foo.test.ts\n');
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'findings',
        findingCount: 3,
        findings: [
          '- **HIGH** `src/handler.test.ts:3` — Test focus/skip modifier: `describe.only(...)`',
          '- **LOW** `src/handler.test.ts:5` — Debug artifact in test file: `console.log(...)`',
          '- **MEDIUM** `src/util.test.ts:10` — Non-deterministic time without fake timers: `Date.now()`',
        ],
        passedChecks: 1,
        totalChecks: 4,
        report: '**Result: FINDINGS** (3 findings detected)',
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; findingCount: number; report: string };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(3);
      expect(data.report).toContain('FINDINGS');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleWorkflowDeterminism_EmitsGateEvent_WithD5Dimension', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1', baseBranch: BASE };
      await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitGateEvent).toHaveBeenCalledWith(
        mockStore,
        'feat-1',
        'workflow-determinism',
        'quality',
        true,
        { dimension: 'D5', phase: 'review', findingCount: 0 },
      );
    });
  });

  // ─── Git Diff Failure (fail-closed) ───────────────────────────────────────

  describe('git diff failure', () => {
    it('handleWorkflowDeterminism_GitDiffFails_ReturnsError', async () => {
      mockGetDiff.mockReturnValue(null);

      const args = { featureId: 'feat-1', baseBranch: BASE };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkWorkflowDeterminism).not.toHaveBeenCalled();
    });
  });

  // ─── Base-branch resolution ──────────────────────────────────────────────

  describe('base branch', () => {
    it('handleWorkflowDeterminism_UnresolvedBase_IsInconclusive_NotPass', async () => {
      const result = await handleWorkflowDeterminism(
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
      expect(gateName).toBe('workflow-determinism');
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
