// Tests for `handleOperationalResilience`. They test the verdict of the provider, so the
// phase-gate runner is a stub that calls only the provider. `gate-runner.test.ts` tests the runner
// against a real store. `unrunbooked-gate-evidence-dispatch.test.ts` tests the evidence over real
// dispatch.
// The `requireGateEvent` stub appends through the mocked `emitGateEvent` and withholds the carrier
// when the append throws, like the real helper.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);
/**
 * Outside a dispatch scope a retry has no operation to collapse onto, so the real helper returns
 * `undefined`.
 */
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

vi.mock('../../../../src/verbs/pure/operational-resilience.js', () => ({
  checkOperationalResilience: vi.fn(),
}));

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

describe('handleOperationalResilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('handleOperationalResilience_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

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
        undefined,
      );
    });
  });

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

  describe('gate event append failure', () => {
    it('OperationalResilience_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
      mockGetDiff.mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });
      mockEmitGateEvent.mockRejectedValueOnce(new Error('store unavailable'));

      const args = { featureId: 'feat-1' };
      const result = await handleOperationalResilience(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
      const data = result.data as { passed: boolean; findingCount: number };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
    });
  });
});
