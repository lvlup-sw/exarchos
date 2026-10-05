/**
 * Unit tests for the mapping from the telemetry view to runtime metrics. The fold
 * is the seam, so the suite stubs `foldToTail`. A real store proves the fold in
 * `tests/unit/projections/fold-at-tail.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  tailSequence: vi.fn().mockResolvedValue(0),
};

const mockMaterializer = {
  materializeAt: vi.fn(),
  getState: vi.fn(() => undefined),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
  discardFold: vi.fn(),
};

const foldToTail = vi.fn();

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: (...args: unknown[]) => foldToTail(...args),
}));

/** The fold answers with `state`, covering an arbitrary non-zero tail. */
function foldReturns(state: unknown): void {
  foldToTail.mockResolvedValue({ view: state, sequence: 7 });
}

/** The fold cannot answer — the graceful-degradation arm. */
function foldThrows(): void {
  foldToTail.mockRejectedValue(new Error('materialization failed'));
}

import { queryRuntimeMetrics, queryTelemetryState } from '../../../../src/projections/telemetry/telemetry-queries.js';
import type { TelemetryViewState } from '../../../../src/projections/telemetry/telemetry-projection.js';
import { initToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';

const STATE_DIR = '/tmp/test-telemetry-queries';

describe('queryRuntimeMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('QueryRuntimeMetrics_WithTelemetryEvents_ReturnsMetrics', async () => {
    const telemetryState: TelemetryViewState = {
      tools: {
        'exarchos_workflow': {
          ...initToolMetrics(),
          invocations: 5,
          totalTokens: 3000,
        },
        'exarchos_view': {
          ...initToolMetrics(),
          invocations: 5,
          totalTokens: 2000,
        },
      },
      sessionStart: '2026-01-01T00:00:00.000Z',
      totalInvocations: 10,
      totalTokens: 5000,
      windowSize: 1000,
    };
    foldReturns(telemetryState);

    const metrics = await queryRuntimeMetrics(mockStore as never, STATE_DIR);

    expect(metrics.sessionTokens).toBe(5000);
    expect(metrics.toolCount).toBe(2);
    expect(metrics.totalInvocations).toBe(10);
  });

  it('QueryRuntimeMetrics_EmptyStream_ReturnsZeroMetrics', async () => {
    const telemetryState: TelemetryViewState = {
      tools: {},
      sessionStart: '2026-01-01T00:00:00.000Z',
      totalInvocations: 0,
      totalTokens: 0,
      windowSize: 1000,
    };
    foldReturns(telemetryState);

    const metrics = await queryRuntimeMetrics(mockStore as never, STATE_DIR);

    expect(metrics.sessionTokens).toBe(0);
    expect(metrics.toolCount).toBe(0);
    expect(metrics.totalInvocations).toBe(0);
  });

  it('QueryRuntimeMetrics_MaterializationFailure_ReturnsZeroMetrics', async () => {
    foldThrows();

    const metrics = await queryRuntimeMetrics(mockStore as never, STATE_DIR);

    expect(metrics.sessionTokens).toBe(0);
    expect(metrics.toolCount).toBe(0);
    expect(metrics.totalInvocations).toBe(0);
  });
});

describe('queryTelemetryState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('QueryTelemetryState_WithData_ReturnsState', async () => {
    const telemetryState: TelemetryViewState = {
      tools: {
        'workflow_get': {
          ...initToolMetrics(),
          invocations: 3,
          p95Bytes: 800,
        },
      },
      sessionStart: '2026-01-01T00:00:00.000Z',
      totalInvocations: 3,
      totalTokens: 1500,
      windowSize: 1000,
    };
    foldReturns(telemetryState);

    const state = await queryTelemetryState(mockStore as never, STATE_DIR);

    expect(state).not.toBeNull();
    expect(state!.totalTokens).toBe(1500);
    expect(state!.tools['workflow_get']).toBeDefined();
  });

  it('QueryTelemetryState_MaterializationFailure_ReturnsNull', async () => {
    foldThrows();

    const state = await queryTelemetryState(mockStore as never, STATE_DIR);

    expect(state).toBeNull();
  });
});
