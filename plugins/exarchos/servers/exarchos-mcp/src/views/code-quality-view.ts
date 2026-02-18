import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const CODE_QUALITY_VIEW = 'code-quality';

// ─── View State Interfaces ─────────────────────────────────────────────────

export interface SkillQualityMetrics {
  readonly skill: string;
  readonly totalExecutions: number;
  readonly gatePassRate: number;
  readonly selfCorrectionRate: number;
  readonly avgRemediationAttempts: number;
  readonly topFailureCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
}

export interface GateMetrics {
  readonly gate: string;
  readonly executionCount: number;
  readonly passRate: number;
  readonly avgDuration: number;
  readonly failureReasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
}

export interface BenchmarkTrend {
  readonly operation: string;
  readonly metric: string;
  readonly values: ReadonlyArray<{ readonly value: number; readonly commit: string; readonly timestamp: string }>;
  readonly trend: 'improving' | 'stable' | 'degrading';
}

export interface QualityRegression {
  readonly skill: string;
  readonly gate: string;
  readonly consecutiveFailures: number;
  readonly firstFailureCommit: string;
  readonly lastFailureCommit: string;
  readonly detectedAt: string;
}

export interface CodeQualityViewState {
  readonly skills: Record<string, SkillQualityMetrics>;
  readonly gates: Record<string, GateMetrics>;
  readonly regressions: ReadonlyArray<QualityRegression>;
  readonly benchmarks: ReadonlyArray<BenchmarkTrend>;
}

// ─── Projection ────────────────────────────────────────────────────────────

export const codeQualityProjection: ViewProjection<CodeQualityViewState> = {
  init: () => ({
    skills: {},
    gates: {},
    regressions: [],
    benchmarks: [],
  }),

  apply: (view, _event) => {
    return view;
  },
};
