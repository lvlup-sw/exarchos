// ─── Workflow Determinism Action Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

// ─── Mock gate-utils (getDiff + emitGateEvent) ─────────────────────────────

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);
// Outside a dispatch scope there is no operation for a retry to collapse onto,
// so the real helper answers `undefined` — the mock says the same thing.
const mockSameOperationGateKey = vi.fn<(gateName: string) => string | undefined>(
  () => undefined,
);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
  sameOperationGateKey: (gateName: string) => mockSameOperationGateKey(gateName),
}));

// The gate now records durable evidence through the shared phase-gate runner
// before any success carrier escapes. These cases are about the PROVIDER's
// verdict, so the runner is stubbed down to its provider call — the same seam
// every other migrated gate's unit test stubs. What the runner itself
// guarantees is proven against a real store in `gate-runner.test.ts`, and the
// evidence a caller actually gets is proven over real dispatch in
// `unrunbooked-gate-evidence-dispatch.test.ts`.
vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
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

      const args = { featureId: 'feat-1' };
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

      const args = { featureId: 'feat-1' };
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

      const args = { featureId: 'feat-1' };
      await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitGateEvent).toHaveBeenCalledWith(
        mockStore,
        'feat-1',
        'workflow-determinism',
        'quality',
        true,
        { dimension: 'D5', phase: 'review', findingCount: 0 },
        undefined,
      );
    });
  });

  // ─── Git Diff Failure (fail-closed) ───────────────────────────────────────

  describe('git diff failure', () => {
    it('handleWorkflowDeterminism_GitDiffFails_ReturnsError', async () => {
      mockGetDiff.mockReturnValue(null);

      const args = { featureId: 'feat-1' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkWorkflowDeterminism).not.toHaveBeenCalled();
    });
  });
});
