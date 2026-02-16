import type { TelemetryViewState, ToolMetrics } from './telemetry-projection.js';

// ─── Hint Interface ──────────────────────────────────────────────────────────

export interface Hint {
  readonly tool: string;
  readonly hint: string;
}

// ─── Threshold Constants ─────────────────────────────────────────────────────

const VIEW_TASKS_BYTES_THRESHOLD = 1200;
const WORKFLOW_GET_BYTES_THRESHOLD = 600;
const EVENT_QUERY_BYTES_THRESHOLD = 2000;

// ─── Rule Type ───────────────────────────────────────────────────────────────

type HintRule = (metrics: ToolMetrics, toolName: string) => Hint | null;

// ─── Rules ───────────────────────────────────────────────────────────────────

const rules: readonly HintRule[] = [
  (metrics, toolName) => {
    if (toolName === 'view_tasks' && metrics.p95Bytes > VIEW_TASKS_BYTES_THRESHOLD) {
      return { tool: toolName, hint: 'Consider using fields projection to reduce response size' };
    }
    return null;
  },
  (metrics, toolName) => {
    if (toolName === 'workflow_get' && metrics.p95Bytes > WORKFLOW_GET_BYTES_THRESHOLD) {
      return { tool: toolName, hint: 'Consider using query parameter for targeted field access' };
    }
    return null;
  },
  (metrics, toolName) => {
    if (toolName === 'event_query' && metrics.p95Bytes > EVENT_QUERY_BYTES_THRESHOLD) {
      return { tool: toolName, hint: 'Consider using limit parameter to cap event results' };
    }
    return null;
  },
];

// ─── Generator ───────────────────────────────────────────────────────────────

export function generateHints(state: TelemetryViewState): Hint[] {
  const hints: Hint[] = [];
  for (const [toolName, metrics] of Object.entries(state.tools)) {
    for (const rule of rules) {
      const hint = rule(metrics, toolName);
      if (hint) hints.push(hint);
    }
  }
  return hints;
}
