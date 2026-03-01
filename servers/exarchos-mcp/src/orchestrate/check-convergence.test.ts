// ─── Check Convergence Action Tests ─────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock event store + materializer ────────────────────────────────────────

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

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

import { handleCheckConvergence } from './check-convergence.js';

const STATE_DIR = '/tmp/test-check-convergence';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleCheckConvergence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewState = {};
  });

  it('CheckConvergence_MissingFeatureId_ReturnsError', async () => {
    const result: ToolResult = await handleCheckConvergence(
      {} as { featureId: string },
      STATE_DIR,
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

    await handleCheckConvergence({ featureId: 'test-feature' }, STATE_DIR);

    // Verify gate event was emitted (fire-and-forget)
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

    await handleCheckConvergence({ featureId: 'test-feature' }, STATE_DIR);

    // Verify gate event includes phase: 'meta'
    expect(mockStore.append).toHaveBeenCalled();
    const appendCall = mockStore.append.mock.calls[0];
    const event = appendCall[1] as {
      type: string;
      data: { details: Record<string, unknown> };
    };
    expect(event.data.details.phase).toBe('meta');
  });

  it('CheckConvergence_GateEmissionFailure_DoesNotBreakHandler', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D1', 'D2', 'D3', 'D4', 'D5'],
      dimensions: {},
    };

    // Make event emission fail
    mockStore.append.mockRejectedValueOnce(new Error('disk full'));

    const result: ToolResult = await handleCheckConvergence(
      { featureId: 'test-feature' },
      STATE_DIR,
    );

    // Handler should still succeed despite emission failure
    expect(result.success).toBe(true);
    expect(result.data.passed).toBe(false);
  });

  it('CheckConvergence_UsesWorkflowIdAsStreamId', async () => {
    mockViewState = {
      featureId: 'test-feature',
      overallConverged: false,
      uncheckedDimensions: ['D1', 'D2', 'D3', 'D4', 'D5'],
      dimensions: {},
    };

    const { queryDeltaEvents } = await import('../views/tools.js');

    await handleCheckConvergence(
      { featureId: 'test-feature', workflowId: 'custom-stream' },
      STATE_DIR,
    );

    // Should use workflowId as the stream ID
    expect(queryDeltaEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'custom-stream',
      'convergence',
    );
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
