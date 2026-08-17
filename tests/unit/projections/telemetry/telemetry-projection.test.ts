import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import {
  telemetryProjection,
  TELEMETRY_VIEW,
  initToolMetrics,
  computeOutputTokenHints,
} from '../../../../src/projections/telemetry/telemetry-projection.js';
import type { TelemetryViewState, ToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';

describe('TelemetryProjection', () => {
  describe('init', () => {
    it('should return empty state with default window size', () => {
      const state = telemetryProjection.init();
      expect(state.tools).toEqual({});
      expect(state.totalInvocations).toBe(0);
      expect(state.totalTokens).toBe(0);
      expect(state.windowSize).toBe(1000);
      expect(state.sessionStart).toBeTruthy();
    });
  });

  describe('TELEMETRY_VIEW constant', () => {
    it('should export the view name', () => {
      expect(TELEMETRY_VIEW).toBe('telemetry');
    });
  });

  describe('initToolMetrics', () => {
    it('should return zeroed metrics with empty arrays', () => {
      const metrics = initToolMetrics();
      expect(metrics.invocations).toBe(0);
      expect(metrics.errors).toBe(0);
      expect(metrics.totalDurationMs).toBe(0);
      expect(metrics.totalBytes).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.p50DurationMs).toBe(0);
      expect(metrics.p95DurationMs).toBe(0);
      expect(metrics.p50Bytes).toBe(0);
      expect(metrics.p95Bytes).toBe(0);
      expect(metrics.p50Tokens).toBe(0);
      expect(metrics.p95Tokens).toBe(0);
      expect(metrics.durations).toEqual([]);
      expect(metrics.sizes).toEqual([]);
      expect(metrics.tokenEstimates).toEqual([]);
    });
  });

  describe('apply - tool.completed', () => {
    it('should create tool entry on first completed event', () => {
      let state = telemetryProjection.init();
      const event = makeEvent('tool.completed', {
        tool: 'workflow_get',
        durationMs: 15,
        responseBytes: 400,
        tokenEstimate: 100,
      });
      state = telemetryProjection.apply(state, event);

      expect(state.tools['workflow_get']).toBeDefined();
      expect(state.tools['workflow_get'].invocations).toBe(1);
      expect(state.tools['workflow_get'].totalDurationMs).toBe(15);
      expect(state.tools['workflow_get'].totalBytes).toBe(400);
      expect(state.tools['workflow_get'].totalTokens).toBe(100);
      expect(state.totalInvocations).toBe(1);
      expect(state.totalTokens).toBe(100);
    });

    it('should accumulate metrics across multiple events for same tool', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.completed', { tool: 't', durationMs: 10, responseBytes: 200, tokenEstimate: 50 }));
      state = telemetryProjection.apply(state, makeEvent('tool.completed', { tool: 't', durationMs: 20, responseBytes: 400, tokenEstimate: 100 }));
      state = telemetryProjection.apply(state, makeEvent('tool.completed', { tool: 't', durationMs: 30, responseBytes: 600, tokenEstimate: 150 }));

      expect(state.tools['t'].invocations).toBe(3);
      expect(state.tools['t'].totalDurationMs).toBe(60);
      expect(state.tools['t'].totalTokens).toBe(300);
      // p50 of [10, 20, 30] = 20
      expect(state.tools['t'].p50DurationMs).toBe(20);
    });

    it('should track separate entries for different tools', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.completed', { tool: 'a', durationMs: 10, responseBytes: 100, tokenEstimate: 25 }));
      state = telemetryProjection.apply(state, makeEvent('tool.completed', { tool: 'b', durationMs: 20, responseBytes: 200, tokenEstimate: 50 }));

      expect(Object.keys(state.tools)).toHaveLength(2);
      expect(state.totalInvocations).toBe(2);
      expect(state.totalTokens).toBe(75);
    });

    it('should compute percentiles correctly for durations, sizes, and tokens', () => {
      let state = telemetryProjection.init();
      for (let i = 1; i <= 100; i++) {
        state = telemetryProjection.apply(state, makeEvent('tool.completed', {
          tool: 'perc',
          durationMs: i,
          responseBytes: i * 10,
          tokenEstimate: i * 2,
        }));
      }

      expect(state.tools['perc'].p50DurationMs).toBe(50);
      expect(state.tools['perc'].p95DurationMs).toBe(95);
      expect(state.tools['perc'].p50Bytes).toBe(500);
      expect(state.tools['perc'].p95Bytes).toBe(950);
      expect(state.tools['perc'].p50Tokens).toBe(100);
      expect(state.tools['perc'].p95Tokens).toBe(190);
    });
  });

  describe('apply - tool.errored', () => {
    it('should increment error count', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.errored', { tool: 'x', durationMs: 5, errorMessage: 'TIMEOUT' }));

      expect(state.tools['x'].errors).toBe(1);
      expect(state.tools['x'].invocations).toBe(0);
    });

    it('should track errors alongside invocations', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.completed', { tool: 'x', durationMs: 10, responseBytes: 100, tokenEstimate: 25 }));
      state = telemetryProjection.apply(state, makeEvent('tool.errored', { tool: 'x', durationMs: 5, errorMessage: 'ERR' }));

      expect(state.tools['x'].invocations).toBe(1);
      expect(state.tools['x'].errors).toBe(1);
    });

    it('should not add to durations or sizes arrays for errored events', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.errored', { tool: 'x', durationMs: 5, errorMessage: 'ERR' }));

      expect(state.tools['x'].durations).toEqual([]);
      expect(state.tools['x'].sizes).toEqual([]);
      expect(state.tools['x'].tokenEstimates).toEqual([]);
    });
  });

  describe('apply - tool.invoked', () => {
    it('should ignore tool.invoked events (invocations counted via completed)', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.invoked', { tool: 'y' }));

      expect(state.tools).toEqual({});
      expect(state.totalInvocations).toBe(0);
    });
  });

  describe('apply - unrelated events', () => {
    it('should return state unchanged for unrelated event types', () => {
      const state = telemetryProjection.init();
      const result = telemetryProjection.apply(state, makeEvent('workflow.started', { featureId: 'test', workflowType: 'feature' }));

      expect(result).toBe(state);
    });
  });

  describe('rolling window', () => {
    it('should cap arrays at windowSize (1000)', () => {
      let state = telemetryProjection.init();
      for (let i = 0; i < 1005; i++) {
        state = telemetryProjection.apply(state, makeEvent('tool.completed', {
          tool: 'flood',
          durationMs: i,
          responseBytes: i * 10,
          tokenEstimate: i * 2,
        }));
      }

      expect(state.tools['flood'].durations).toHaveLength(1000);
      expect(state.tools['flood'].sizes).toHaveLength(1000);
      expect(state.tools['flood'].tokenEstimates).toHaveLength(1000);
      // Newest entries retained (oldest dropped)
      expect(state.tools['flood'].durations[0]).toBe(5); // dropped 0-4
    });

    it('should still compute correct totals beyond window cap', () => {
      let state = telemetryProjection.init();
      for (let i = 0; i < 1005; i++) {
        state = telemetryProjection.apply(state, makeEvent('tool.completed', {
          tool: 'flood',
          durationMs: 1,
          responseBytes: 10,
          tokenEstimate: 2,
        }));
      }

      // Totals accumulate beyond window
      expect(state.tools['flood'].invocations).toBe(1005);
      expect(state.tools['flood'].totalDurationMs).toBe(1005);
      expect(state.tools['flood'].totalBytes).toBe(10050);
      expect(state.tools['flood'].totalTokens).toBe(2010);
      expect(state.totalInvocations).toBe(1005);
      expect(state.totalTokens).toBe(2010);
    });
  });

  // ─── T12: Zod removal from tool.completed handler ──────────────────────

  describe('apply - tool.completed guard (T12)', () => {
    it('Apply_ToolCompleted_ValidData_UpdatesMetrics', () => {
      let state = telemetryProjection.init();
      const event = makeEvent('tool.completed', {
        tool: 'workflow_get',
        durationMs: 15,
        responseBytes: 400,
        tokenEstimate: 100,
      });
      state = telemetryProjection.apply(state, event);

      expect(state.tools['workflow_get']).toBeDefined();
      expect(state.tools['workflow_get'].invocations).toBe(1);
      expect(state.tools['workflow_get'].totalDurationMs).toBe(15);
      expect(state.tools['workflow_get'].totalBytes).toBe(400);
      expect(state.tools['workflow_get'].totalTokens).toBe(100);
      expect(state.totalInvocations).toBe(1);
      expect(state.totalTokens).toBe(100);
    });

    it('Apply_ToolCompleted_MissingFields_ReturnsViewUnchanged', () => {
      const state = telemetryProjection.init();

      // Missing 'tool' field
      const noTool = telemetryProjection.apply(state, makeEvent('tool.completed', {
        durationMs: 15,
        responseBytes: 400,
        tokenEstimate: 100,
      }));
      expect(noTool).toBe(state);

      // Missing 'durationMs' field
      const noDuration = telemetryProjection.apply(state, makeEvent('tool.completed', {
        tool: 'workflow_get',
        responseBytes: 400,
        tokenEstimate: 100,
      }));
      expect(noDuration).toBe(state);

      // durationMs is not a number
      const badDuration = telemetryProjection.apply(state, makeEvent('tool.completed', {
        tool: 'workflow_get',
        durationMs: 'not-a-number',
        responseBytes: 400,
        tokenEstimate: 100,
      }));
      expect(badDuration).toBe(state);

      // No data at all
      const noData = telemetryProjection.apply(state, {
        streamId: 'telemetry',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'tool.completed',
        schemaVersion: '1.0',
      } as WorkflowEvent);
      expect(noData).toBe(state);
    });

    it('Apply_ToolCompleted_NonStringTool_ReturnsViewUnchanged', () => {
      const state = telemetryProjection.init();

      const numericTool = telemetryProjection.apply(state, makeEvent('tool.completed', {
        tool: 123,
        durationMs: 15,
      }));
      expect(numericTool).toBe(state);
    });

    it('Apply_ToolCompleted_NonNumericOptionals_DefaultsToZero', () => {
      let state = telemetryProjection.init();
      state = telemetryProjection.apply(state, makeEvent('tool.completed', {
        tool: 'test_tool',
        durationMs: 10,
        responseBytes: 'garbage',
        tokenEstimate: 'garbage',
      }));

      expect(state.tools['test_tool'].totalBytes).toBe(0);
      expect(state.tools['test_tool'].totalTokens).toBe(0);
    });
  });

  // ─── T13: Zod removal from tool.errored handler ───────────────────────

  describe('apply - tool.errored guard (T13)', () => {
    it('Apply_ToolErrored_ValidData_UpdatesMetrics', () => {
      let state = telemetryProjection.init();
      const event = makeEvent('tool.errored', {
        tool: 'workflow_set',
        durationMs: 5,
        errorMessage: 'TIMEOUT',
      });
      state = telemetryProjection.apply(state, event);

      expect(state.tools['workflow_set']).toBeDefined();
      expect(state.tools['workflow_set'].errors).toBe(1);
      expect(state.tools['workflow_set'].invocations).toBe(0);
    });

    it('Apply_ToolErrored_MissingFields_ReturnsViewUnchanged', () => {
      const state = telemetryProjection.init();

      // Missing 'tool' field
      const noTool = telemetryProjection.apply(state, makeEvent('tool.errored', {
        durationMs: 5,
        errorMessage: 'TIMEOUT',
      }));
      expect(noTool).toBe(state);

      // No data at all
      const noData = telemetryProjection.apply(state, {
        streamId: 'telemetry',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'tool.errored',
        schemaVersion: '1.0',
      } as WorkflowEvent);
      expect(noData).toBe(state);
    });

    it('Apply_ToolErrored_NonStringTool_ReturnsViewUnchanged', () => {
      const state = telemetryProjection.init();

      const numericTool = telemetryProjection.apply(state, makeEvent('tool.errored', {
        tool: 42,
        durationMs: 5,
      }));
      expect(numericTool).toBe(state);
    });
  });
});

// Helper to create a minimal WorkflowEvent
function makeEvent(type: string, data: Record<string, unknown>): WorkflowEvent {
  return {
    streamId: 'telemetry',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: type as WorkflowEvent['type'],
    schemaVersion: '1.0',
    data,
  };
}

// ─── PR3/T9 (#1364): tool.action_errored projection ─────────────────────────
describe('TelemetryProjection_ActionErrored_AggregatesByTool', () => {
  it('folds action-errored events into per-tool actionErrors + breakdown', () => {
    let state = telemetryProjection.init();

    // 5× tool.completed for exarchos_orchestrate
    for (let i = 0; i < 5; i++) {
      state = telemetryProjection.apply(state, makeEvent('tool.completed', {
        tool: 'exarchos_orchestrate',
        durationMs: 10,
        responseBytes: 100,
        tokenEstimate: 25,
      }));
    }

    // 2× tool.action_errored MERGE_ROLLED_BACK
    for (let i = 0; i < 2; i++) {
      state = telemetryProjection.apply(state, makeEvent('tool.action_errored', {
        tool: 'exarchos_orchestrate',
        durationMs: 10,
        errorCode: 'MERGE_ROLLED_BACK',
        responseBytes: 100,
        tokenEstimate: 25,
      }));
    }

    // 1× tool.action_errored PREFLIGHT_FAILED
    state = telemetryProjection.apply(state, makeEvent('tool.action_errored', {
      tool: 'exarchos_orchestrate',
      durationMs: 10,
      errorCode: 'PREFLIGHT_FAILED',
      responseBytes: 100,
      tokenEstimate: 25,
    }));

    // 1× tool.errored (transport)
    state = telemetryProjection.apply(state, makeEvent('tool.errored', {
      tool: 'exarchos_orchestrate',
      durationMs: 5,
      errorMessage: 'crashed',
    }));

    const entry = state.tools['exarchos_orchestrate'];
    expect(entry).toBeDefined();
    // invocations counts tool.completed only (existing rule retained).
    expect(entry.invocations).toBe(5);
    // errors counts transport (tool.errored) only.
    expect(entry.errors).toBe(1);
    // actionErrors = sum of action-errored events for this tool.
    expect(entry.actionErrors).toBe(3);
    // Breakdown by errorCode.
    expect(entry.actionErrorBreakdown).toEqual({
      MERGE_ROLLED_BACK: 2,
      PREFLIGHT_FAILED: 1,
    });
  });

  it('initToolMetrics_HasActionErrorFields_ZeroInitialized', () => {
    const m = initToolMetrics();
    expect(m.actionErrors).toBe(0);
    expect(m.actionErrorBreakdown).toEqual({});
  });

  it('Apply_ActionErrored_MissingFields_ReturnsViewUnchanged', () => {
    const state = telemetryProjection.init();

    // No data at all
    const noData = telemetryProjection.apply(state, {
      streamId: 'telemetry',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'tool.action_errored',
      schemaVersion: '1.0',
    } as WorkflowEvent);
    expect(noData).toBe(state);

    // Non-string tool
    const numericTool = telemetryProjection.apply(state, makeEvent('tool.action_errored', {
      tool: 42,
      durationMs: 10,
      errorCode: 'X',
      responseBytes: 0,
      tokenEstimate: 0,
    }));
    expect(numericTool).toBe(state);

    // Missing errorCode
    const noCode = telemetryProjection.apply(state, makeEvent('tool.action_errored', {
      tool: 'exarchos_orchestrate',
      durationMs: 10,
      responseBytes: 0,
      tokenEstimate: 0,
    }));
    expect(noCode).toBe(state);
  });

  it('Apply_ActionErrored_NewTool_CreatesEntry', () => {
    let state = telemetryProjection.init();
    state = telemetryProjection.apply(state, makeEvent('tool.action_errored', {
      tool: 'fresh_tool',
      durationMs: 10,
      errorCode: 'INVALID_INPUT',
      responseBytes: 50,
      tokenEstimate: 12,
    }));

    expect(state.tools['fresh_tool']).toBeDefined();
    expect(state.tools['fresh_tool'].actionErrors).toBe(1);
    expect(state.tools['fresh_tool'].actionErrorBreakdown).toEqual({ INVALID_INPUT: 1 });
    // No completed events folded — invocations stays 0.
    expect(state.tools['fresh_tool'].invocations).toBe(0);
    expect(state.tools['fresh_tool'].errors).toBe(0);
  });
});

// ─── #1262 — per-turn output-token tracking + hint emission ────────────────

describe('TelemetryProjection_OutputTokenHint', () => {
  it('TelemetryProjection_ThresholdCrossed_EmitsHint', () => {
    // Synthetic telemetry: a single `turn.completed` event carrying a
    // per-turn output-token sum above the threshold.
    let state = telemetryProjection.init();
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't1', outputTokens: 30000 }),
    );

    // The projection records each turn's output tokens.
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toEqual({ turnId: 't1', outputTokens: 30000 });

    // computeOutputTokenHints surfaces a NextAction-shaped checkpoint hint
    // when a turn crosses the threshold (passed in tokens).
    const hints = computeOutputTokenHints(state, 25600);
    expect(hints).toHaveLength(1);
    expect(hints[0].verb).toBe('checkpoint');
    expect(hints[0].reason).toMatch(/output tokens/i);
  });

  it('TelemetryProjection_BelowThreshold_NoHint', () => {
    let state = telemetryProjection.init();
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't1', outputTokens: 10000 }),
    );

    expect(state.turns).toHaveLength(1);
    const hints = computeOutputTokenHints(state, 25600);
    expect(hints).toHaveLength(0);
  });

  it('TelemetryProjection_TurnCompleted_NonNumericOutputTokens_IgnoresEvent', () => {
    const state = telemetryProjection.init();
    const result = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't1', outputTokens: 'garbage' }),
    );
    expect(result).toBe(state);
  });

  it('TelemetryProjection_MultipleTurns_LatestAboveThreshold_EmitsOneHint', () => {
    // Sentry MEDIUM #1422 fix changed the emission semantics: hints are
    // emitted ONLY when the LATEST turn is above threshold, not on every
    // historical crossing in the buffer (which previously flooded
    // next_actions). The test asserts the new contract — a streak that
    // ends before the latest turn yields no hint, but a streak that
    // includes the latest turn does.
    let state = telemetryProjection.init();
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't1', outputTokens: 5000 }),
    );
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't2', outputTokens: 30000 }),
    );
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't3', outputTokens: 28000 }),
    );

    const hints = computeOutputTokenHints(state, 25600);
    expect(hints).toHaveLength(1);
    expect(hints[0].verb).toBe('checkpoint');
  });

  it('TelemetryProjection_MultipleTurns_LatestBelowThreshold_EmitsNoHint', () => {
    // Companion to the test above — a historical crossing that does NOT
    // persist into the latest turn produces no hint (post-#1422 fix).
    let state = telemetryProjection.init();
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't1', outputTokens: 5000 }),
    );
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't2', outputTokens: 30000 }),
    );
    state = telemetryProjection.apply(
      state,
      makeEvent('turn.completed', { turnId: 't3', outputTokens: 8000 }),
    );

    const hints = computeOutputTokenHints(state, 25600);
    expect(hints).toHaveLength(0);
  });
});
