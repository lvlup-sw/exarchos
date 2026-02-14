import type { ViewProjection } from '../views/materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { percentile } from './percentile.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const TELEMETRY_VIEW = 'telemetry';

// ─── Rolling Window Default ────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 1000;

// ─── Per-Tool Metrics ──────────────────────────────────────────────────────

export interface ToolMetrics {
  readonly invocations: number;
  readonly errors: number;
  readonly totalDurationMs: number;
  readonly totalBytes: number;
  readonly totalTokens: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly p50Bytes: number;
  readonly p95Bytes: number;
  readonly p50Tokens: number;
  readonly p95Tokens: number;
  readonly durations: readonly number[];
  readonly sizes: readonly number[];
  readonly tokenEstimates: readonly number[];
}

// ─── Telemetry View State ──────────────────────────────────────────────────

export interface TelemetryViewState {
  readonly tools: Record<string, ToolMetrics>;
  readonly sessionStart: string;
  readonly totalInvocations: number;
  readonly totalTokens: number;
  readonly windowSize: number;
}

// ─── Factory for Empty ToolMetrics ─────────────────────────────────────────

export function initToolMetrics(): ToolMetrics {
  return {
    invocations: 0,
    errors: 0,
    totalDurationMs: 0,
    totalBytes: 0,
    totalTokens: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
    p50Bytes: 0,
    p95Bytes: 0,
    p50Tokens: 0,
    p95Tokens: 0,
    durations: [],
    sizes: [],
    tokenEstimates: [],
  };
}

// ─── Rolling Window Helper ─────────────────────────────────────────────────

function appendWithCap(arr: readonly number[], value: number, cap: number): readonly number[] {
  const next = [...arr, value];
  if (next.length <= cap) return next;
  return next.slice(next.length - cap);
}

// ─── Projection ────────────────────────────────────────────────────────────

export const telemetryProjection: ViewProjection<TelemetryViewState> = {
  init: () => ({
    tools: {},
    sessionStart: new Date().toISOString(),
    totalInvocations: 0,
    totalTokens: 0,
    windowSize: DEFAULT_WINDOW_SIZE,
  }),

  apply: (view, event) => {
    switch (event.type) {
      case 'tool.completed': {
        const data = event.data as {
          tool?: string;
          durationMs?: number;
          responseBytes?: number;
          tokenEstimate?: number;
        } | undefined;

        const toolName = data?.tool;
        if (!toolName) return view;

        const durationMs = data?.durationMs ?? 0;
        const responseBytes = data?.responseBytes ?? 0;
        const tokenEstimate = data?.tokenEstimate ?? 0;

        const existing = view.tools[toolName] ?? initToolMetrics();

        const durations = appendWithCap(existing.durations, durationMs, view.windowSize);
        const sizes = appendWithCap(existing.sizes, responseBytes, view.windowSize);
        const tokenEstimates = appendWithCap(existing.tokenEstimates, tokenEstimate, view.windowSize);

        const updated: ToolMetrics = {
          invocations: existing.invocations + 1,
          errors: existing.errors,
          totalDurationMs: existing.totalDurationMs + durationMs,
          totalBytes: existing.totalBytes + responseBytes,
          totalTokens: existing.totalTokens + tokenEstimate,
          p50DurationMs: percentile(durations as number[], 0.5),
          p95DurationMs: percentile(durations as number[], 0.95),
          p50Bytes: percentile(sizes as number[], 0.5),
          p95Bytes: percentile(sizes as number[], 0.95),
          p50Tokens: percentile(tokenEstimates as number[], 0.5),
          p95Tokens: percentile(tokenEstimates as number[], 0.95),
          durations,
          sizes,
          tokenEstimates,
        };

        return {
          ...view,
          tools: { ...view.tools, [toolName]: updated },
          totalInvocations: view.totalInvocations + 1,
          totalTokens: view.totalTokens + tokenEstimate,
        };
      }

      case 'tool.errored': {
        const data = event.data as { tool?: string } | undefined;
        const toolName = data?.tool;
        if (!toolName) return view;

        const existing = view.tools[toolName] ?? initToolMetrics();

        const updated: ToolMetrics = {
          ...existing,
          errors: existing.errors + 1,
        };

        return {
          ...view,
          tools: { ...view.tools, [toolName]: updated },
        };
      }

      default:
        return view;
    }
  },
};
