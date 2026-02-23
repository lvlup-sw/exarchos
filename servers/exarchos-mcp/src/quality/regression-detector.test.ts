import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';

// ─── Test Helper ────────────────────────────────────────────────────────────

function createMockEventStore(): { append: ReturnType<typeof vi.fn> } {
  return {
    append: vi.fn().mockResolvedValue({}),
  };
}

// ─── detectRegressions Tests ────────────────────────────────────────────────

describe('detectRegressions', () => {
  it('detectRegressions_ThreeConsecutiveFailures_ReturnsRegression', async () => {
    const { detectRegressions } = await import('./regression-detector.js');

    const viewState = {
      _failureTrackers: {
        'typecheck:delegation': {
          count: 3,
          firstCommit: 'abc123',
          lastCommit: 'def456',
        },
      },
    };

    const regressions = detectRegressions(viewState);

    expect(regressions).toHaveLength(1);
    expect(regressions[0].gate).toBe('typecheck');
    expect(regressions[0].skill).toBe('delegation');
    expect(regressions[0].consecutiveFailures).toBe(3);
    expect(regressions[0].firstFailureCommit).toBe('abc123');
    expect(regressions[0].lastFailureCommit).toBe('def456');
    expect(regressions[0].detectedAt).toBeDefined();
  });

  it('detectRegressions_TwoFailures_ReturnsEmpty', async () => {
    const { detectRegressions } = await import('./regression-detector.js');

    const viewState = {
      _failureTrackers: {
        'typecheck:delegation': {
          count: 2,
          firstCommit: 'abc123',
          lastCommit: 'def456',
        },
      },
    };

    const regressions = detectRegressions(viewState);

    expect(regressions).toHaveLength(0);
  });

  it('detectRegressions_FailureThenPass_ResetsCounter', async () => {
    const { detectRegressions } = await import('./regression-detector.js');

    // After a pass, the tracker would be removed from _failureTrackers
    // (as done in code-quality-view.ts), so an empty tracker means reset
    const viewState = {
      _failureTrackers: {},
    };

    const regressions = detectRegressions(viewState);

    expect(regressions).toHaveLength(0);
  });
});

// ─── emitRegressionEvents Tests ─────────────────────────────────────────────

describe('emitRegressionEvents', () => {
  let mockEventStore: ReturnType<typeof createMockEventStore>;

  beforeEach(() => {
    mockEventStore = createMockEventStore();
  });

  it('emitRegressionEvents_RegressionDetected_EmitsQualityRegressionEvent', async () => {
    const { emitRegressionEvents } = await import('./regression-detector.js');

    const regressions = [
      {
        skill: 'delegation',
        gate: 'typecheck',
        consecutiveFailures: 3,
        firstFailureCommit: 'abc123',
        lastFailureCommit: 'def456',
        detectedAt: '2026-02-22T00:00:00.000Z',
      },
    ];

    await emitRegressionEvents(
      regressions,
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = mockEventStore.append.mock.calls[0];
    expect(streamId).toBe('test-stream');
    expect(event.type).toBe('quality.regression');
    expect(event.data.skill).toBe('delegation');
    expect(event.data.gate).toBe('typecheck');
    expect(event.data.consecutiveFailures).toBe(3);
    expect(event.data.firstFailureCommit).toBe('abc123');
    expect(event.data.lastFailureCommit).toBe('def456');
  });

  it('emitRegressionEvents_NoRegressions_EmitsNothing', async () => {
    const { emitRegressionEvents } = await import('./regression-detector.js');

    await emitRegressionEvents(
      [],
      'test-stream',
      mockEventStore as unknown as EventStore,
    );

    expect(mockEventStore.append).not.toHaveBeenCalled();
  });
});
