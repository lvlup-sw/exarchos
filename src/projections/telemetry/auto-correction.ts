import {
  VIEW_TASKS_BYTES_THRESHOLD,
  EVENT_QUERY_BYTES_THRESHOLD,
  WORKFLOW_GET_BYTES_THRESHOLD,
  CONSISTENCY_WINDOW_SIZE,
} from './constants.js';
import type { ToolMetrics } from './telemetry-projection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Keys of ToolMetrics that are numeric (excludes array fields). */
type NumericMetricKey = {
  [K in keyof ToolMetrics]: ToolMetrics[K] extends number ? K : never;
}[keyof ToolMetrics];

export interface CorrectionRule {
  readonly toolName: string;
  readonly action: string;
  readonly param: string;
  readonly threshold: number;
  readonly thresholdField: NumericMetricKey;
  readonly defaultValue: unknown;
  readonly check: (args: Record<string, unknown>) => boolean;
}

export interface Correction {
  readonly param: string;
  readonly value: unknown;
  readonly rule: string;
}

// ─── Correction Rules ───────────────────────────────────────────────────────

export const CORRECTION_RULES: readonly CorrectionRule[] = [
  {
    toolName: 'exarchos_view',
    action: 'tasks',
    param: 'fields',
    threshold: VIEW_TASKS_BYTES_THRESHOLD,
    thresholdField: 'p95Bytes',
    defaultValue: ['id', 'title', 'status', 'assignee'],
    check: (args) => args.fields === undefined,
  },
  {
    toolName: 'exarchos_event',
    action: 'query',
    param: 'limit',
    threshold: EVENT_QUERY_BYTES_THRESHOLD,
    thresholdField: 'p95Bytes',
    defaultValue: 50,
    check: (args) => args.limit === undefined,
  },
  {
    toolName: 'exarchos_workflow',
    action: 'get',
    param: 'fields',
    threshold: WORKFLOW_GET_BYTES_THRESHOLD,
    thresholdField: 'p95Bytes',
    defaultValue: ['phase', 'tasks', 'artifacts'],
    check: (args) => args.fields === undefined && args.query === undefined,
  },
];

// ─── Match Correction ───────────────────────────────────────────────────────

/**
 * Checks whether a correction rule matches the given tool invocation.
 *
 * Returns a `Correction` when all conditions are met:
 * 1. A rule exists for the toolName + action combination
 * 2. The threshold field exceeds the rule's threshold
 * 3. The consistency window is met (consecutiveBreaches >= CONSISTENCY_WINDOW_SIZE)
 * 4. The param is not already set in args (additive-only)
 *
 * Returns `null` otherwise.
 */
export function matchCorrection(
  toolName: string,
  action: string,
  args: Record<string, unknown>,
  metrics: ToolMetrics,
  consecutiveBreaches: number,
): Correction | null {
  if (consecutiveBreaches < CONSISTENCY_WINDOW_SIZE) {
    return null;
  }

  const rule = CORRECTION_RULES.find(
    (r) => r.toolName === toolName && r.action === action,
  );

  if (!rule) {
    return null;
  }

  const metricValue = metrics[rule.thresholdField];
  if (metricValue <= rule.threshold) {
    return null;
  }

  if (!rule.check(args)) {
    return null;
  }

  return {
    param: rule.param,
    value: rule.defaultValue,
    rule: `${rule.toolName}:${rule.action}:${rule.param}`,
  };
}

// ─── Apply Corrections ──────────────────────────────────────────────────────

/**
 * Applies corrections to args, returning the modified args and the list of
 * applied corrections.
 *
 * Respects `skipAutoCorrection: true` opt-out — returns args unchanged.
 */
export function applyCorrections(
  args: Record<string, unknown>,
  corrections: Correction[],
): { args: Record<string, unknown>; applied: Correction[] } {
  if (args.skipAutoCorrection === true) {
    return { args, applied: [] };
  }

  const modified = { ...args };
  const applied: Correction[] = [];

  for (const correction of corrections) {
    modified[correction.param] = correction.value;
    applied.push(correction);
  }

  return { args: modified, applied };
}

// ─── Consistency Tracker ────────────────────────────────────────────────────

/**
 * Tracks consecutive threshold breaches per tool+action key.
 *
 * A breach increments the counter; a non-breach resets it to 0.
 * `shouldCorrect` returns true once the counter reaches CONSISTENCY_WINDOW_SIZE.
 */
export class ConsistencyTracker {
  private breaches = new Map<string, number>();

  record(key: string, breached: boolean): number {
    if (breached) {
      const count = (this.breaches.get(key) ?? 0) + 1;
      this.breaches.set(key, count);
      return count;
    }
    this.breaches.delete(key);
    return 0;
  }

  shouldCorrect(key: string): boolean {
    return (this.breaches.get(key) ?? 0) >= CONSISTENCY_WINDOW_SIZE;
  }
}
