import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EventStore } from '../event-store/store.js';
import type { RefinementSignal } from './refinement-signal.js';
import type { TelemetryViewState } from '../telemetry/telemetry-projection.js';
import { generateHints as generateTelemetryHints } from '../telemetry/hints.js';

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used for quality hint event emission. */
export function configureQualityEventStore(store: EventStore | null): void {
  moduleEventStore = store;
}

// ─── Hint Interface ─────────────────────────────────────────────────────────

export type QualityHintCategory = 'pbt' | 'benchmark' | 'gate' | 'review' | 'eval' | 'refinement' | 'telemetry';

export interface QualityHint {
  readonly skill: string;
  readonly category: QualityHintCategory;
  readonly severity: 'info' | 'warning';
  readonly hint: string;
  readonly confidenceLevel?: 'actionable' | 'advisory';
  readonly affectedPromptPaths?: string[];
}

// ─── Calibration Context ───────────────────────────────────────────────────

export interface CalibrationContext {
  readonly signalConfidence: 'high' | 'medium' | 'low';
  readonly refinementSignals: RefinementSignal[];
}

// ─── Rule Type ──────────────────────────────────────────────────────────────

type QualityHintRule = (state: CodeQualityViewState, skillName: string) => QualityHint | null;

// ─── Threshold Constants ────────────────────────────────────────────────────

const GATE_PASS_RATE_WARNING = 0.80;
const CONSECUTIVE_FAILURES_WARNING = 3;
const SELF_CORRECTION_RATE_INFO = 0.30;
const PBT_FAILURE_RATE_WARNING = 0.15;

// ─── Per-Skill Rules ────────────────────────────────────────────────────────

const skillRules: readonly QualityHintRule[] = [
  // Low gate pass rate rule
  (state, skill) => {
    const metrics = state.skills[skill];
    if (!metrics || metrics.gatePassRate >= GATE_PASS_RATE_WARNING) return null;
    const topFailures = metrics.topFailureCategories.slice(0, 3).map(c => c.category).join(', ');
    return {
      skill,
      category: 'gate',
      severity: 'warning',
      hint: `Gate pass rate is ${Math.floor(metrics.gatePassRate * 100)}%. Common failures: ${topFailures}. Pay extra attention to these areas.`,
    };
  },

  // Consecutive failures rule
  (state, skill) => {
    const regressions = state.regressions.filter(r => r.skill === skill && r.consecutiveFailures >= CONSECUTIVE_FAILURES_WARNING);
    if (regressions.length === 0) return null;
    const gates = regressions.map(r => `${r.gate} (${r.consecutiveFailures} consecutive)`).join(', ');
    return {
      skill,
      category: 'gate',
      severity: 'warning',
      hint: `Active regressions: ${gates}. These gates have consecutive failures — investigate before proceeding.`,
    };
  },

  // Self-correction rate rule
  (state, skill) => {
    const metrics = state.skills[skill];
    if (!metrics || metrics.selfCorrectionRate < SELF_CORRECTION_RATE_INFO) return null;
    return {
      skill,
      category: 'review',
      severity: 'info',
      hint: `High self-correction rate (${(metrics.selfCorrectionRate * 100).toFixed(0)}%). Consider strengthening upfront validation to reduce remediation cycles.`,
    };
  },
];

// ─── Global Rules (run once, not per-skill) ─────────────────────────────────

const globalRules: readonly QualityHintRule[] = [
  // Benchmark regression rule
  (state, skill) => {
    const degrading = state.benchmarks.filter(b => b.trend === 'degrading');
    if (degrading.length === 0) return null;
    const operations = degrading.map(b => b.operation).join(', ');
    return {
      skill,
      category: 'benchmark',
      severity: 'warning',
      hint: `Degrading benchmarks detected: ${operations}. Review recent changes for performance impact.`,
    };
  },

  // PBT failure rule
  (state, skill) => {
    const pbtGate = state.gates['check-property-tests'];
    if (!pbtGate) return null;
    const failureRate = Math.round((1 - pbtGate.passRate) * 100) / 100;
    if (failureRate <= PBT_FAILURE_RATE_WARNING) return null;
    return {
      skill,
      category: 'pbt',
      severity: 'warning',
      hint: `Property-based test failure rate is ${(failureRate * 100).toFixed(0)}%. Review edge cases and invariant definitions.`,
    };
  },
];

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HINTS = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function severityOrder(severity: QualityHint['severity']): number {
  return severity === 'warning' ? 0 : 1;
}

// ─── Generator ──────────────────────────────────────────────────────────────

export function generateQualityHints(
  state: CodeQualityViewState,
  targetSkill?: string,
  calibrationContext?: CalibrationContext,
  telemetryState?: TelemetryViewState,
): QualityHint[] {
  const hints: QualityHint[] = [];
  const skills = targetSkill ? [targetSkill] : Object.keys(state.skills);

  // Per-skill rules: run once for each skill
  for (const skill of skills) {
    for (const rule of skillRules) {
      const hint = rule(state, skill);
      if (hint) hints.push(hint);
    }
  }

  // Global rules: run exactly once (using first skill for attribution)
  const globalSkill = targetSkill ?? skills[0];
  if (globalSkill) {
    for (const rule of globalRules) {
      const hint = rule(state, globalSkill);
      if (hint) hints.push(hint);
    }
  }

  // Telemetry hints: convert tool optimization hints to quality hints
  if (telemetryState) {
    const telemetryHints = generateTelemetryHints(telemetryState);
    for (const th of telemetryHints) {
      hints.push({
        skill: 'global',
        category: 'telemetry',
        severity: 'info',
        hint: `[${th.tool}] ${th.hint}`,
      });
    }
  }

  // Enrich hints with calibration data when provided
  const enrichedHints = calibrationContext
    ? enrichWithCalibration(hints, calibrationContext, targetSkill)
    : hints;

  enrichedHints.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
  const result = enrichedHints.slice(0, MAX_HINTS);

  // Fire-and-forget: emit quality.hint.generated event when hints are produced
  if (result.length > 0 && moduleEventStore) {
    moduleEventStore
      .append('quality-hints', {
        type: 'quality.hint.generated',
        data: {
          skill: targetSkill ?? 'global',
          hintCount: result.length,
          categories: [...new Set(result.map(h => h.category))],
          generatedAt: new Date().toISOString(),
        },
      })
      .catch(() => {
        // Intentionally swallowed — event emission is fire-and-forget
      });
  }

  return result;
}

// ─── Calibration Enrichment ──────────────────────────────────────────────────

function enrichWithCalibration(
  hints: QualityHint[],
  calibration: CalibrationContext,
  targetSkill?: string,
): QualityHint[] {
  const confidenceLevel = isCalibrated(calibration.signalConfidence)
    ? 'actionable' as const
    : 'advisory' as const;

  // Enrich existing hints with confidence level
  const enriched: QualityHint[] = hints.map(hint => ({
    ...hint,
    confidenceLevel,
  }));

  // Add refinement hints for matching signals (filtered by targetSkill when specified)
  for (const signal of calibration.refinementSignals) {
    if (targetSkill && signal.skill !== targetSkill) continue;
    enriched.push({
      skill: signal.skill,
      category: 'refinement',
      severity: 'info',
      hint: signal.suggestedAction,
      confidenceLevel,
      affectedPromptPaths: signal.affectedPromptPaths,
    });
  }

  return enriched;
}

function isCalibrated(confidence: CalibrationContext['signalConfidence']): boolean {
  return confidence === 'high' || confidence === 'medium';
}
