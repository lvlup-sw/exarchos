// ─── Regression Eval Generator ─────────────────────────────────────────────
//
// When CodeQualityView detects a quality regression (3+ consecutive gate
// failures), auto-generates a regression eval case from recent traces.
//
// Guards:
//   - signalConfidence must be 'high' or 'medium' (never 'low')
//   - At least one trace must be present
//
// Generated cases use the 'capability' layer (advisory for first 2 runs)
// and carry an 'auto-generated' tag for filtering.
// ────────────────────────────────────────────────────────────────────────────

import type { WorkflowEvent } from '../event-store/schemas.js';
import type { QualityRegression, GateMetrics } from '../views/code-quality-view.js';
import type { EvalCase } from '../evals/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SignalConfidence = 'high' | 'medium' | 'low';

export interface GeneratedRegressionCase {
  source: 'auto-generated';
  trigger: QualityRegression;
  evalCase: EvalCase;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAcceptableConfidence(confidence: SignalConfidence): boolean {
  return confidence === 'high' || confidence === 'medium';
}

function buildCaseId(regression: QualityRegression): string {
  return `auto-${regression.gate}-${regression.skill}-${regression.lastFailureCommit}`;
}

function extractTopFailureReason(gateMetrics: GateMetrics): string {
  if (gateMetrics.failureReasons.length === 0) return 'unknown';
  // Sort by count descending and take the top reason
  const sorted = [...gateMetrics.failureReasons].sort((a, b) => b.count - a.count);
  return sorted[0].reason;
}

function buildDescription(regression: QualityRegression): string {
  return `Regression: ${regression.gate} gate failing for ${regression.skill} skill (${regression.consecutiveFailures} consecutive failures)`;
}

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Generate a regression eval case from a detected quality regression and
 * recent workflow traces.
 *
 * Returns null if:
 *   - signalConfidence is 'low'
 *   - No traces are available (caller should emit a hint suggesting manual capture)
 */
export function generateRegressionEval(
  regression: QualityRegression,
  recentTraces: WorkflowEvent[],
  gateDetails: GateMetrics,
  signalConfidence: SignalConfidence,
): GeneratedRegressionCase | null {
  // Guard: never auto-generate from low confidence signals
  if (!isAcceptableConfidence(signalConfidence)) {
    return null;
  }

  // Guard: need at least one trace to pair with the regression
  if (recentTraces.length === 0) {
    return null;
  }

  const topFailureReason = extractTopFailureReason(gateDetails);

  const evalCase: EvalCase = {
    id: buildCaseId(regression),
    type: 'trace',
    description: buildDescription(regression),
    input: {
      gate: regression.gate,
      skill: regression.skill,
      consecutiveFailures: regression.consecutiveFailures,
      traces: recentTraces.map(t => ({
        type: t.type,
        timestamp: t.timestamp,
        data: t.data,
      })),
    },
    expected: {
      failurePattern: {
        gate: regression.gate,
        skill: regression.skill,
        topReason: topFailureReason,
        consecutiveFailures: regression.consecutiveFailures,
        commitRange: {
          first: regression.firstFailureCommit,
          last: regression.lastFailureCommit,
        },
      },
    },
    tags: ['auto-generated'],
    layer: 'capability',
  };

  return {
    source: 'auto-generated',
    trigger: regression,
    evalCase,
  };
}
