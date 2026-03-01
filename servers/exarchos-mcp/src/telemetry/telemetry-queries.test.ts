// ─── Telemetry Query Abstraction Tests ───────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock event store and materializer ───────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

const mockMaterializer = {
  materialize: vi.fn(),
  getState: vi.fn(() => null),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

import { queryRuntimeMetrics, queryTelemetryState } from './telemetry-queries.js';
import type { TelemetryViewState } from './telemetry-projection.js';
import { initToolMetrics } from './telemetry-projection.js';

const STATE_DIR = '/tmp/test-telemetry-queries';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('queryRuntimeMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('QueryRuntimeMetrics_WithTelemetryEvents_ReturnsMetrics', async () => {
    // Arrange: telemetry state with tool data
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
    mockMaterializer.materialize.mockReturnValue(telemetryState);

    // Act
    const metrics = await queryRuntimeMetrics(mockStore as never, STATE_DIR);

    // Assert
    expect(metrics.sessionTokens).toBe(5000);
    expect(metrics.toolCount).toBe(2);
    expect(metrics.totalInvocations).toBe(10);
  });

  it('QueryRuntimeMetrics_EmptyStream_ReturnsZeroMetrics', async () => {
    // Arrange: empty telemetry state
    const telemetryState: TelemetryViewState = {
      tools: {},
      sessionStart: '2026-01-01T00:00:00.000Z',
      totalInvocations: 0,
      totalTokens: 0,
      windowSize: 1000,
    };
    mockMaterializer.materialize.mockReturnValue(telemetryState);

    // Act
    const metrics = await queryRuntimeMetrics(mockStore as never, STATE_DIR);

    // Assert
    expect(metrics.sessionTokens).toBe(0);
    expect(metrics.toolCount).toBe(0);
    expect(metrics.totalInvocations).toBe(0);
  });

  it('QueryRuntimeMetrics_MaterializationFailure_ReturnsZeroMetrics', async () => {
    // Arrange: materializer throws
    mockMaterializer.materialize.mockImplementation(() => {
      throw new Error('materialization failed');
    });

    // Act
    const metrics = await queryRuntimeMetrics(mockStore as never, STATE_DIR);

    // Assert
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
    // Arrange
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
    mockMaterializer.materialize.mockReturnValue(telemetryState);

    // Act
    const state = await queryTelemetryState(mockStore as never, STATE_DIR);

    // Assert
    expect(state).not.toBeNull();
    expect(state!.totalTokens).toBe(1500);
    expect(state!.tools['workflow_get']).toBeDefined();
  });

  it('QueryTelemetryState_MaterializationFailure_ReturnsNull', async () => {
    // Arrange
    mockMaterializer.materialize.mockImplementation(() => {
      throw new Error('materialization failed');
    });

    // Act
    const state = await queryTelemetryState(mockStore as never, STATE_DIR);

    // Assert
    expect(state).toBeNull();
  });
});
