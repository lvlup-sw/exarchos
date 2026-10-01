import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EventStore } from '../../events/store.js';
import type { RefinementSignal } from './refinement-signal.js';
import type { TelemetryViewState } from '../telemetry/telemetry-projection.js';
import { generateHints as generateTelemetryHints } from '../telemetry/hints.js';

export type QualityHintCategory = 'pbt' | 'benchmark' | 'gate' | 'review' | 'eval' | 'refinement' | 'telemetry';

export interface QualityHint {
  readonly skill: string;
  readonly category: QualityHintCategory;
  readonly severity: 'info' | 'warning';
  readonly hint: string;
  readonly confidenceLevel?: 'actionable' | 'advisory';
  readonly affectedPromptPaths?: string[];
}

export interface CalibrationContext {
  readonly signalConfidence: 'high' | 'medium' | 'low';
  readonly refinementSignals: RefinementSignal[];
}

type QualityHintRule = (state: CodeQualityViewState, skillName: string) => QualityHint | null;

const GATE_PASS_RATE_WARNING = 0.80;
const CONSECUTIVE_FAILURES_WARNING = 3;
const SELF_CORRECTION_RATE_INFO = 0.30;
const PBT_FAILURE_RATE_WARNING = 0.15;

const skillRules: readonly QualityHintRule[] = [
  /** Warns when the gate pass rate of the skill is below `GATE_PASS_RATE_WARNING`. */
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

  /** Warns when gates of the skill have at least `CONSECUTIVE_FAILURES_WARNING` consecutive failures. */
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

  /** Gives an info hint when the self-correction rate is at least `SELF_CORRECTION_RATE_INFO`. */
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

/** Rules that run once for each call, not once for each skill. */
const globalRules: readonly QualityHintRule[] = [
  /** Warns about benchmarks with a degrading trend. */
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

  /** Warns when the failure rate of the `check-property-tests` gate is above `PBT_FAILURE_RATE_WARNING`. */
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

const MAX_HINTS = 5;

function severityOrder(severity: QualityHint['severity']): number {
  return severity === 'warning' ? 0 : 1;
}

/**
 * Generates quality hints, with warnings first, and keeps at most `MAX_HINTS`.
 * Per-skill rules run for each skill. Global rules run once, for the target skill or the first skill.
 * The function adds telemetry hints and calibration data when the caller gives them.
 * When hints exist and `eventStore` is given, it appends `quality.hint.generated` without a wait and ignores a failure.
 */
export function generateQualityHints(
  state: CodeQualityViewState,
  targetSkill?: string,
  calibrationContext?: CalibrationContext,
  telemetryState?: TelemetryViewState,
  eventStore?: EventStore | null,
): QualityHint[] {
  const hints: QualityHint[] = [];
  const skills = targetSkill ? [targetSkill] : Object.keys(state.skills);

  for (const skill of skills) {
    for (const rule of skillRules) {
      const hint = rule(state, skill);
      if (hint) hints.push(hint);
    }
  }

  const globalSkill = targetSkill ?? skills[0];
  if (globalSkill) {
    for (const rule of globalRules) {
      const hint = rule(state, globalSkill);
      if (hint) hints.push(hint);
    }
  }

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

  const enrichedHints = calibrationContext
    ? enrichWithCalibration(hints, calibrationContext, targetSkill)
    : hints;

  enrichedHints.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
  const result = enrichedHints.slice(0, MAX_HINTS);

  if (result.length > 0 && eventStore) {
    eventStore
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
      });
  }

  return result;
}

/**
 * Sets the confidence level on each hint and adds a refinement hint for each signal.
 * A high or medium signal confidence gives `actionable`, and a low one gives `advisory`.
 * When `targetSkill` is given, only the signals of that skill add hints.
 */
function enrichWithCalibration(
  hints: QualityHint[],
  calibration: CalibrationContext,
  targetSkill?: string,
): QualityHint[] {
  const confidenceLevel = isCalibrated(calibration.signalConfidence)
    ? 'actionable' as const
    : 'advisory' as const;

  const enriched: QualityHint[] = hints.map(hint => ({
    ...hint,
    confidenceLevel,
  }));

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
