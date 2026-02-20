import type { CodeQualityViewState } from '../views/code-quality-view.js';

// ─── Hint Interface ─────────────────────────────────────────────────────────

export type QualityHintCategory = 'pbt' | 'benchmark' | 'gate' | 'review' | 'eval';

export interface QualityHint {
  readonly skill: string;
  readonly category: QualityHintCategory;
  readonly severity: 'info' | 'warning';
  readonly hint: string;
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

// ─── Generator ──────────────────────────────────────────────────────────────

export function generateQualityHints(
  state: CodeQualityViewState,
  targetSkill?: string,
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

  return hints;
}
