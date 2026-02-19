import { describe, it, expect } from 'vitest';
import { generateHints } from './hints.js';
import type { Hint } from './hints.js';
import type { TelemetryViewState, ToolMetrics } from './telemetry-projection.js';
import { initToolMetrics } from './telemetry-projection.js';

function makeState(tools: Record<string, Partial<ToolMetrics>>): TelemetryViewState {
  const fullTools: Record<string, ToolMetrics> = {};
  for (const [name, partial] of Object.entries(tools)) {
    fullTools[name] = { ...initToolMetrics(), ...partial };
  }
  return {
    tools: fullTools,
    sessionStart: new Date().toISOString(),
    totalInvocations: 0,
    totalTokens: 0,
    windowSize: 1000,
  };
}

describe('generateHints', () => {
  describe('view_tasks hints', () => {
    it('should suggest fields projection when p95Bytes > 1200', () => {
      const state = makeState({ view_tasks: { p95Bytes: 1500 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(1);
      expect(hints[0].tool).toBe('view_tasks');
      expect(hints[0].hint).toContain('fields');
    });

    it('should not hint when p95Bytes < 800', () => {
      const state = makeState({ view_tasks: { p95Bytes: 600 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('workflow_get hints', () => {
    it('should suggest query parameter when p95Bytes > 600', () => {
      const state = makeState({ workflow_get: { p95Bytes: 800 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(1);
      expect(hints[0].tool).toBe('workflow_get');
      expect(hints[0].hint).toContain('query');
    });

    it('should not hint when p95Bytes < 400', () => {
      const state = makeState({ workflow_get: { p95Bytes: 300 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('event_query hints', () => {
    it('should suggest limit parameter when p95Bytes > 2000', () => {
      const state = makeState({ event_query: { p95Bytes: 2500 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(1);
      expect(hints[0].tool).toBe('event_query');
      expect(hints[0].hint).toContain('limit');
    });

    it('should not hint when p95Bytes < 800', () => {
      const state = makeState({ event_query: { p95Bytes: 500 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('workflow_set hints', () => {
    it('should suggest batching when p95DurationMs > 200', () => {
      const state = makeState({ workflow_set: { p95DurationMs: 250 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(1);
      expect(hints[0].tool).toBe('workflow_set');
      expect(hints[0].hint).toContain('Batch multiple field updates into a single `set` call');
    });

    it('should not hint when p95DurationMs <= 200', () => {
      const state = makeState({ workflow_set: { p95DurationMs: 150 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('event_query invocation hints', () => {
    it('should suggest exarchos_view when invocations > 20', () => {
      const state = makeState({ event_query: { invocations: 25 } });
      const hints = generateHints(state);
      const invocationHint = hints.find((h) => h.hint.includes('exarchos_view'));
      expect(invocationHint).toBeDefined();
      expect(invocationHint!.tool).toBe('event_query');
      expect(invocationHint!.hint).toContain('Consider using `exarchos_view` for aggregated data instead of raw event queries');
    });

    it('should not hint when invocations <= 20', () => {
      const state = makeState({ event_query: { invocations: 15 } });
      const hints = generateHints(state);
      const invocationHint = hints.find((h) => h.hint.includes('exarchos_view'));
      expect(invocationHint).toBeUndefined();
    });
  });

  describe('generic error rate hints', () => {
    it('should warn when error rate > 20%', () => {
      const state = makeState({ some_tool: { invocations: 10, errors: 3 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(1);
      expect(hints[0].tool).toBe('some_tool');
      expect(hints[0].hint).toContain('Tool `some_tool` is failing frequently');
      expect(hints[0].hint).toContain('check parameters');
    });

    it('should not hint when error rate is 10%', () => {
      const state = makeState({ some_tool: { invocations: 10, errors: 1 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });

    it('should not hint when invocations is 0 (avoids division by zero)', () => {
      const state = makeState({ some_tool: { invocations: 0, errors: 0 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('team_status hints', () => {
    it('should suggest summary mode when invocations > 10', () => {
      const state = makeState({ team_status: { invocations: 15 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(1);
      expect(hints[0].tool).toBe('team_status');
      expect(hints[0].hint).toContain('Use `summary: true` for counts-only during orchestration');
    });

    it('should not hint when invocations <= 10', () => {
      const state = makeState({ team_status: { invocations: 8 } });
      const hints = generateHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty tools map', () => {
      const state = makeState({});
      const hints = generateHints(state);
      expect(hints).toEqual([]);
    });

    it('should return empty array when all tools have low metrics', () => {
      const state = makeState({
        view_tasks: { p95Bytes: 100 },
        workflow_get: { p95Bytes: 50 },
        event_query: { p95Bytes: 200 },
      });
      const hints = generateHints(state);
      expect(hints).toEqual([]);
    });

    it('should return hints for multiple tools at once', () => {
      const state = makeState({
        view_tasks: { p95Bytes: 1500 },
        workflow_get: { p95Bytes: 800 },
        event_query: { p95Bytes: 2500 },
      });
      const hints = generateHints(state);
      expect(hints).toHaveLength(3);
    });
  });
});
