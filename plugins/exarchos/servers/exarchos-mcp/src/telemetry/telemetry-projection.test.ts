import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { telemetryProjection, TELEMETRY_VIEW, initToolMetrics } from './telemetry-projection.js';
import type { TelemetryViewState, ToolMetrics } from './telemetry-projection.js';

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
