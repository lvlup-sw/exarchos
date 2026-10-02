/**
 * Tests for `handleWorkflowDeterminism`. These cases test the provider verdict, so the file stubs the phase-gate runner down to its provider call.
 * `gate-runner.test.ts` covers the runner against a real store. `unrunbooked-gate-evidence-dispatch.test.ts` covers the evidence over real dispatch.
 * Like the real helper, the `requireGateEvent` stub appends through `mockEmitGateEvent` and withholds the success result when that append throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);
/** Outside a dispatch scope, no operation exists for a retry to collapse onto. The real helper returns `undefined`, and the mock does the same. */
const mockSameOperationGateKey = vi.fn<(gateName: string) => string | undefined>(
  () => undefined,
);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
  sameOperationGateKey: (gateName: string) => mockSameOperationGateKey(gateName),
  requireGateEvent: async (
    store: unknown,
    streamId: string,
    gateName: string,
    layer: string,
    passed: boolean,
    carrier: { data?: unknown },
    details?: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    try {
      await mockEmitGateEvent(store, streamId, gateName, layer, passed, details, idempotencyKey);
      return undefined;
    } catch (err) {
      return {
        success: false,
        data: carrier.data,
        error: {
          code: 'GATE_EVENT_UNRECORDED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
}));

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

vi.mock('../../../../src/verbs/pure/workflow-determinism.js', () => ({
  checkWorkflowDeterminism: vi.fn(),
}));

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

describe('handleWorkflowDeterminism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('handleWorkflowDeterminism_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

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

  describe('gate event append failure', () => {
    /** The gate verdict stays readable on `data`. The handler withholds only the success result. */
    it('WorkflowDeterminism_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });
      mockEmitGateEvent.mockRejectedValueOnce(new Error('store unavailable'));

      const args = { featureId: 'feat-1' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
      const data = result.data as { passed: boolean; findingCount: number };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
    });
  });
});
