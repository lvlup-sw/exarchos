import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AttributionDimension = 'skill' | 'gate' | 'model';

export interface AttributionQuery {
  readonly dimension: AttributionDimension;
  readonly skill?: string;
  readonly timeRange?: { readonly start: string; readonly end: string };
}

export interface AttributionEntry {
  readonly name: string;
  readonly dimension: AttributionDimension;
  readonly contribution: number;
  readonly passRate: number;
  readonly executionCount: number;
}

export interface AttributionResult {
  readonly dimension: AttributionDimension;
  readonly entries: ReadonlyArray<AttributionEntry>;
  readonly totalExecutions: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_DIMENSIONS: ReadonlySet<string> = new Set(['skill', 'gate', 'model']);

export function isValidDimension(value: string): value is AttributionDimension {
  return VALID_DIMENSIONS.has(value);
}

// ─── Computation ────────────────────────────────────────────────────────────

export function computeAttribution(
  query: AttributionQuery,
  codeQuality: CodeQualityViewState,
  _evalResults: EvalResultsViewState,
): AttributionResult {
  if (!isValidDimension(query.dimension)) {
    throw new Error(`Invalid attribution dimension: ${String(query.dimension)}`);
  }

  switch (query.dimension) {
    case 'skill':
      return computeSkillAttribution(codeQuality, query.skill);
    case 'gate':
      return computeGateAttribution(codeQuality, query.skill);
    case 'model':
      return computeModelAttribution(codeQuality);
  }
}

// ─── Dimension Handlers ─────────────────────────────────────────────────────

function computeSkillAttribution(
  codeQuality: CodeQualityViewState,
  filterSkill?: string,
): AttributionResult {
  const skills = filterSkill
    ? Object.entries(codeQuality.skills).filter(([name]) => name === filterSkill)
    : Object.entries(codeQuality.skills);

  const totalExecutions = skills.reduce((sum, [, m]) => sum + m.totalExecutions, 0);

  const entries: AttributionEntry[] = skills.map(([name, metrics]) => ({
    name,
    dimension: 'skill' as const,
    contribution: totalExecutions > 0 ? metrics.totalExecutions / totalExecutions : 0,
    passRate: metrics.gatePassRate,
    executionCount: metrics.totalExecutions,
  }));

  entries.sort((a, b) => b.contribution - a.contribution);

  return { dimension: 'skill', entries, totalExecutions };
}

function computeGateAttribution(
  codeQuality: CodeQualityViewState,
  _filterSkill?: string,
): AttributionResult {
  const gates = Object.entries(codeQuality.gates);
  const totalExecutions = gates.reduce((sum, [, m]) => sum + m.executionCount, 0);

  const entries: AttributionEntry[] = gates.map(([name, metrics]) => ({
    name,
    dimension: 'gate' as const,
    contribution: totalExecutions > 0 ? metrics.executionCount / totalExecutions : 0,
    passRate: metrics.passRate,
    executionCount: metrics.executionCount,
  }));

  entries.sort((a, b) => b.contribution - a.contribution);

  return { dimension: 'gate', entries, totalExecutions };
}

function computeModelAttribution(
  codeQuality: CodeQualityViewState,
): AttributionResult {
  const models = Object.entries(codeQuality.models);
  const totalExecutions = models.reduce((sum, [, m]) => sum + m.totalExecutions, 0);

  const entries: AttributionEntry[] = models.map(([name, metrics]) => ({
    name,
    dimension: 'model' as const,
    contribution: totalExecutions > 0 ? metrics.totalExecutions / totalExecutions : 0,
    passRate: metrics.gatePassRate,
    executionCount: metrics.totalExecutions,
  }));

  entries.sort((a, b) => b.contribution - a.contribution);

  return { dimension: 'model', entries, totalExecutions };
}
