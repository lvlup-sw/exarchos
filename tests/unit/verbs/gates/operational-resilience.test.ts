// ─── Operational Resilience Action Tests ────────────────────────────────────

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
  // The handler now calls `requireGateEvent`, not `emitGateEvent`, directly.
  // This stub mirrors the real helper's semantics — append via the same
  // mocked `emitGateEvent`, withhold the carrier when the append throws — so
  // a test controls the failure through `mockEmitGateEvent` exactly as before.
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
        undefined,
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

  // ─── Gate Event Append Failure ─────────────────────────────────────────────

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
