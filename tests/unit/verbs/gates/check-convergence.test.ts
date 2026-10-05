/**
 * Tests for `handleCheckConvergence`.
 *
 * The suite stubs the phase-gate runner down to its provider call, so the cases test only the provider verdict.
 * `gate-runner.test.ts` tests the runner against a real store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

let mockViewState: Record<string, unknown> = {};

const mockMaterializer = {
  materialize: vi.fn(() => mockViewState),
  getState: vi.fn(() => null),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

/**
 * Sequence that the `foldToTail` stub reports.
 * The fixtures are the whole stream, so the stub reports a sequence at or past every fixture event.
 * `tests/unit/projections/fold-at-tail.test.ts` tests the fold against a real store.
 */
const AT_TAIL = Number.MAX_SAFE_INTEGER;

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: vi.fn(async () => ({ view: mockViewState, sequence: AT_TAIL })),
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

import { handleCheckConvergence } from '../../../../src/verbs/gates/check-convergence.js';

const STATE_DIR = '/tmp/test-check-convergence';

describe('handleCheckConvergence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewState = {};
  });

  it('CheckConvergence_MissingFeatureId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckConvergence(
      {} as { featureId: string },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('CheckConvergence_AllDimensionsConverged_ReturnsPassed', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: true,
      uncheckedDimensions: [],
      dimensions: {
        D1: { dimension: 'D1', label: 'Design Completeness', gateResults: [{ gateName: 'tdd', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D2: { dimension: 'D2', label: 'Static Analysis', gateResults: [{ gateName: 'lint', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D3: { dimension: 'D3', label: 'Context Economy', gateResults: [{ gateName: 'context', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D4: { dimension: 'D4', label: 'Operational Resilience', gateResults: [{ gateName: 'resilience', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D5: { dimension: 'D5', label: 'Workflow Determinism', gateResults: [{ gateName: 'determinism', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
      },
    };

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: true,
      overallConverged: true,
      uncheckedDimensions: [],
    });
  });

  it('CheckConvergence_SomeDimensionsFailing_ReturnsNotPassed', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D3', 'D4', 'D5'],
      dimensions: {
        D1: { dimension: 'D1', label: 'Design Completeness', gateResults: [{ gateName: 'tdd', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D2: { dimension: 'D2', label: 'Static Analysis', gateResults: [{ gateName: 'lint', passed: false, timestamp: '2026-01-01' }], converged: false, lastChecked: '2026-01-01' },
      },
    };

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: false,
      overallConverged: false,
    });
    expect(result.data.uncheckedDimensions).toEqual(['D3', 'D4', 'D5']);
  });

  it('CheckConvergence_EmptyView_ReturnsNotPassed', async () => {
    mockViewState = {
      featureId: '',
      overallConverged: false,
      uncheckedDimensions: ['D1', 'D2', 'D3', 'D4', 'D5'],
      dimensions: {},
    };

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'cold-start' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: false,
      overallConverged: false,
    });
    expect(result.data.uncheckedDimensions).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
  });

  it('CheckConvergence_EmitsGateEvent_FireAndForget', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: true,
      uncheckedDimensions: [],
      dimensions: {
        D1: { dimension: 'D1', label: 'Design', gateResults: [{ gateName: 'tdd', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D2: { dimension: 'D2', label: 'Static', gateResults: [{ gateName: 'lint', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D3: { dimension: 'D3', label: 'Context', gateResults: [{ gateName: 'ctx', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D4: { dimension: 'D4', label: 'Resilience', gateResults: [{ gateName: 'ops', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D5: { dimension: 'D5', label: 'Determinism', gateResults: [{ gateName: 'det', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
      },
    };

    await handleCheckConvergence({ featureId: 'test-feature' }, STATE_DIR, mockStore as unknown as EventStore);

    expect(mockStore.append).toHaveBeenCalled();
  });

  it('CheckConvergence_EmitsGateEvent_IncludesPhaseInDetails', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: true,
      uncheckedDimensions: [],
      dimensions: {
        D1: { dimension: 'D1', label: 'Design', gateResults: [{ gateName: 'tdd', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D2: { dimension: 'D2', label: 'Static', gateResults: [{ gateName: 'lint', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D3: { dimension: 'D3', label: 'Context', gateResults: [{ gateName: 'ctx', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D4: { dimension: 'D4', label: 'Resilience', gateResults: [{ gateName: 'ops', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
        D5: { dimension: 'D5', label: 'Determinism', gateResults: [{ gateName: 'det', passed: true, timestamp: '2026-01-01' }], converged: true, lastChecked: '2026-01-01' },
      },
    };

    await handleCheckConvergence({ featureId: 'test-feature' }, STATE_DIR, mockStore as unknown as EventStore);

    expect(mockStore.append).toHaveBeenCalled();
    const appendCall = mockStore.append.mock.calls[0];
    const event = appendCall[1] as {
      type: string;
      data: { details: Record<string, unknown> };
    };
    expect(event.data.details.phase).toBe('meta');
  });

  /**
   * `convergence` always declares `gate.executed`.
   * When the append fails, the handler withholds the success carrier, but `data` still holds the verdict.
   */
  it('CheckConvergence_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D1', 'D2', 'D3', 'D4', 'D5'],
      dimensions: {},
    };

    mockStore.append.mockRejectedValueOnce(new Error('disk full'));

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  it('CheckConvergence_UsesWorkflowIdAsStreamId', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D1', 'D2', 'D3', 'D4', 'D5'],
      dimensions: {},
    };

    const { foldToTail } = await import('../../../../src/projections/fold-at-tail.js');

    await handleCheckConvergence(
      { featureId: 'test-feature', workflowId: 'custom-stream' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(foldToTail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'custom-stream',
      'convergence',
    );
  });

  /**
   * With `phase: 'review'`, only review-phase gate results count.
   * D3 has no such result, so it is unchecked. The failed delegate-phase gate in D2 does not count.
   */
  it('CheckConvergence_WithPhaseFilter_ReturnsOnlyMatchingGateResults', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: true,
      uncheckedDimensions: [],
      dimensions: {
        D1: {
          dimension: 'D1',
          label: 'Design Completeness',
          gateResults: [
            { gateName: 'tdd', passed: true, timestamp: '2026-01-01', phase: 'delegate' },
            { gateName: 'plan-coverage', passed: true, timestamp: '2026-01-02', phase: 'review' },
          ],
          converged: true,
          lastChecked: '2026-01-02',
        },
        D2: {
          dimension: 'D2',
          label: 'Static Analysis',
          gateResults: [
            { gateName: 'lint', passed: true, timestamp: '2026-01-01', phase: 'review' },
            { gateName: 'typecheck', passed: false, timestamp: '2026-01-02', phase: 'delegate' },
          ],
          converged: false,
          lastChecked: '2026-01-02',
        },
        D3: {
          dimension: 'D3',
          label: 'Context Economy',
          gateResults: [
            { gateName: 'context', passed: true, timestamp: '2026-01-01', phase: 'ideate' },
          ],
          converged: true,
          lastChecked: '2026-01-01',
        },
      },
    };

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature', phase: 'review' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data.dimensions.D1).toEqual({
      converged: true,
      gateCount: 1,
      lastChecked: '2026-01-02',
    });
    expect(result.data.dimensions.D2).toEqual({
      converged: true,
      gateCount: 1,
      lastChecked: '2026-01-02',
    });
    expect(result.data.dimensions.D3).toEqual({
      converged: false,
      gateCount: 0,
      lastChecked: '2026-01-01',
    });
    expect(result.data.uncheckedDimensions).toContain('D3');
    expect(result.data.overallConverged).toBe(false);
  });

  it('CheckConvergence_WithoutPhaseFilter_ReturnsAllResults', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D3', 'D4', 'D5'],
      dimensions: {
        D1: {
          dimension: 'D1',
          label: 'Design Completeness',
          gateResults: [
            { gateName: 'tdd', passed: true, timestamp: '2026-01-01', phase: 'delegate' },
            { gateName: 'plan-coverage', passed: true, timestamp: '2026-01-02', phase: 'review' },
          ],
          converged: true,
          lastChecked: '2026-01-02',
        },
        D2: {
          dimension: 'D2',
          label: 'Static Analysis',
          gateResults: [
            { gateName: 'lint', passed: true, timestamp: '2026-01-01', phase: 'review' },
            { gateName: 'typecheck', passed: false, timestamp: '2026-01-02', phase: 'delegate' },
          ],
          converged: false,
          lastChecked: '2026-01-02',
        },
      },
    };

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data.dimensions.D1).toEqual({
      converged: true,
      gateCount: 2,
      lastChecked: '2026-01-02',
    });
    expect(result.data.dimensions.D2).toEqual({
      converged: false,
      gateCount: 2,
      lastChecked: '2026-01-02',
    });
    expect(result.data.uncheckedDimensions).toEqual(['D3', 'D4', 'D5']);
  });

  it('CheckConvergence_DimensionSummary_IncludesGateCounts', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D3', 'D4', 'D5'],
      dimensions: {
        D1: {
          dimension: 'D1',
          label: 'Design',
          gateResults: [
            { gateName: 'tdd', passed: true, timestamp: '2026-01-01' },
            { gateName: 'plan-coverage', passed: true, timestamp: '2026-01-02' },
          ],
          converged: true,
          lastChecked: '2026-01-02',
        },
        D2: {
          dimension: 'D2',
          label: 'Static',
          gateResults: [{ gateName: 'lint', passed: false, timestamp: '2026-01-01' }],
          converged: false,
          lastChecked: '2026-01-01',
        },
      },
    };

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.data.dimensions.D1).toEqual({
      converged: true,
      gateCount: 2,
      lastChecked: '2026-01-02',
    });
    expect(result.data.dimensions.D2).toEqual({
      converged: false,
      gateCount: 1,
      lastChecked: '2026-01-01',
    });
  });
});
