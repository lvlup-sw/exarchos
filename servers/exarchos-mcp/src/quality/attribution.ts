import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export type AttributionDimension = 'skill' | 'model' | 'gate' | 'prompt-version';

const VALID_DIMENSIONS: ReadonlySet<string> = new Set<string>(['skill', 'model', 'gate', 'prompt-version']);

/** Type guard: check if a string is a valid attribution dimension. */
export function isValidDimension(value: string): value is AttributionDimension {
  return VALID_DIMENSIONS.has(value);
}

export interface AttributionQuery {
  readonly dimension: AttributionDimension;
  readonly skill?: string;
  readonly timeRange?: string; // ISO 8601 duration (e.g., 'P7D')
}

export interface AttributionEntry {
  readonly key: string;
  readonly gatePassRate: number;
  readonly evalScore: number;
  readonly selfCorrectionRate: number;
  readonly regressionCount: number;
  readonly trend: 'improving' | 'stable' | 'degrading';
  readonly sampleSize: number;
}

export interface AttributionCorrelation {
  readonly factor1: string;
  readonly factor2: string;
  readonly direction: 'positive' | 'negative' | 'none';
  readonly strength: number; // 0-1
}

export interface AttributionResult {
  readonly dimension: string;
  readonly entries: ReadonlyArray<AttributionEntry>;
  readonly correlations: ReadonlyArray<AttributionCorrelation>;
}

// ─── ISO Duration Parser ────────────────────────────────────────────────────

/** Parse a simple ISO 8601 duration string into milliseconds. Supports P<n>D format. */
function parseIsoDuration(duration: string): number {
  const match = duration.match(/^P(\d+)D$/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
}

// ─── Time Range Filter ──────────────────────────────────────────────────────

function computeCutoff(timeRange: string | undefined, referenceTime: Date): Date | null {
  if (!timeRange) return null;
  const durationMs = parseIsoDuration(timeRange);
  if (durationMs <= 0) return null;
  return new Date(referenceTime.getTime() - durationMs);
}

// ─── Correlation Computation ────────────────────────────────────────────────

/**
 * Compute Pearson correlation coefficient between two numeric arrays.
 * Returns a value in [-1, 1]. Returns 0 if fewer than 2 data points
 * or if either array has zero variance.
 */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  if (denominator === 0) return 0;

  return numerator / denominator;
}

function correlationDirection(r: number): 'positive' | 'negative' | 'none' {
  if (r > 0.1) return 'positive';
  if (r < -0.1) return 'negative';
  return 'none';
}

function buildCorrelations(entries: AttributionEntry[]): AttributionCorrelation[] {
  if (entries.length < 2) return [];

  const factors: Array<{ name: string; values: number[] }> = [
    { name: 'gatePassRate', values: entries.map(e => e.gatePassRate) },
    { name: 'evalScore', values: entries.map(e => e.evalScore) },
    { name: 'selfCorrectionRate', values: entries.map(e => e.selfCorrectionRate) },
  ];

  const correlations: AttributionCorrelation[] = [];

  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const r = pearsonCorrelation(factors[i].values, factors[j].values);
      // Clamp to [0, 1] to guard against floating-point overshoot
      const strength = Math.min(1, Math.max(0, Math.abs(r)));
      correlations.push({
        factor1: factors[i].name,
        factor2: factors[j].name,
        direction: correlationDirection(r),
        strength,
      });
    }
  }

  return correlations;
}

// ─── Dimension Handlers ─────────────────────────────────────────────────────

function attributeBySkill(
  query: AttributionQuery,
  codeQuality: CodeQualityViewState,
  evalResults: EvalResultsViewState,
): AttributionEntry[] {
  const skillNames = query.skill
    ? [query.skill].filter(s => s in codeQuality.skills)
    : Object.keys(codeQuality.skills);

  return skillNames.map(skillName => {
    const qualityMetrics = codeQuality.skills[skillName];
    const evalMetrics = evalResults.skills[skillName];
    const regressionCount = codeQuality.regressions.filter(r => r.skill === skillName).length;

    return {
      key: skillName,
      gatePassRate: qualityMetrics.gatePassRate,
      evalScore: evalMetrics?.latestScore ?? 0,
      selfCorrectionRate: qualityMetrics.selfCorrectionRate,
      regressionCount,
      trend: evalMetrics?.trend ?? 'stable',
      sampleSize: qualityMetrics.totalExecutions,
    };
  });
}

function attributeByModel(
  codeQuality: CodeQualityViewState,
): AttributionEntry[] {
  return Object.values(codeQuality.models).map(modelMetrics => ({
    key: modelMetrics.model,
    gatePassRate: modelMetrics.gatePassRate,
    evalScore: 0, // models don't have direct eval scores
    selfCorrectionRate: 0,
    regressionCount: 0,
    trend: 'stable' as const,
    sampleSize: modelMetrics.totalExecutions,
  }));
}

function attributeByGate(
  codeQuality: CodeQualityViewState,
): AttributionEntry[] {
  return Object.values(codeQuality.gates).map(gateMetrics => {
    const regressionCount = codeQuality.regressions.filter(r => r.gate === gateMetrics.gate).length;

    return {
      key: gateMetrics.gate,
      gatePassRate: gateMetrics.passRate,
      evalScore: 0, // gates don't have direct eval scores
      selfCorrectionRate: 0,
      regressionCount,
      trend: 'stable' as const,
      sampleSize: gateMetrics.executionCount,
    };
  });
}

function attributeByPromptVersion(
  evalResults: EvalResultsViewState,
  cutoff: Date | null,
): AttributionEntry[] {
  // Group eval runs by suiteId (which represents prompt versions)
  const grouped = new Map<string, { scores: number[]; runs: number }>();

  for (const run of evalResults.runs) {
    if (cutoff && new Date(run.timestamp) < cutoff) continue;

    const existing = grouped.get(run.suiteId);
    if (existing) {
      existing.scores.push(run.avgScore);
      existing.runs += 1;
    } else {
      grouped.set(run.suiteId, { scores: [run.avgScore], runs: 1 });
    }
  }

  return Array.from(grouped.entries()).map(([suiteId, data]) => {
    const avgScore = data.scores.reduce((s, v) => s + v, 0) / data.scores.length;

    return {
      key: suiteId,
      gatePassRate: 0,
      evalScore: avgScore,
      selfCorrectionRate: 0,
      regressionCount: 0,
      trend: 'stable' as const,
      sampleSize: data.runs,
    };
  });
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Compute multi-dimensional quality attribution analysis.
 *
 * Slices quality data by skill, model, gate, or prompt-version and
 * computes correlations between quality factors.
 *
 * @param query - The attribution query specifying dimension and optional filters
 * @param codeQuality - The materialized code quality view state
 * @param evalResults - The materialized eval results view state
 * @param referenceTime - Optional reference time for time range filtering (defaults to now)
 */
export function computeAttribution(
  query: AttributionQuery,
  codeQuality: CodeQualityViewState,
  evalResults: EvalResultsViewState,
  referenceTime: Date = new Date(),
): AttributionResult {
  const cutoff = computeCutoff(query.timeRange, referenceTime);

  let entries: AttributionEntry[];

  switch (query.dimension) {
    case 'skill':
      entries = attributeBySkill(query, codeQuality, evalResults);
      break;
    case 'model':
      entries = attributeByModel(codeQuality);
      break;
    case 'gate':
      entries = attributeByGate(codeQuality);
      break;
    case 'prompt-version':
      entries = attributeByPromptVersion(evalResults, cutoff);
      break;
  }

  const correlations = buildCorrelations(entries);

  return {
    dimension: query.dimension,
    entries,
    correlations,
  };
}
