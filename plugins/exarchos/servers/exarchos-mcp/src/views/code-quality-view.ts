import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const CODE_QUALITY_VIEW = 'code-quality';

// ─── View State Interfaces ─────────────────────────────────────────────────

export interface SkillQualityMetrics {
  skill: string;
  totalExecutions: number;
  gatePassRate: number;
  selfCorrectionRate: number;
  avgRemediationAttempts: number;
  topFailureCategories: Array<{ category: string; count: number }>;
}

export interface GateMetrics {
  gate: string;
  executionCount: number;
  passRate: number;
  avgDuration: number;
  failureReasons: Array<{ reason: string; count: number }>;
}

export interface BenchmarkTrend {
  operation: string;
  metric: string;
  values: Array<{ value: number; commit: string; timestamp: string }>;
  trend: 'improving' | 'stable' | 'degrading';
}

export interface QualityRegression {
  skill: string;
  gate: string;
  consecutiveFailures: number;
  firstFailureCommit: string;
  lastFailureCommit: string;
  detectedAt: string;
}

export interface CodeQualityViewState {
  skills: Record<string, SkillQualityMetrics>;
  gates: Record<string, GateMetrics>;
  regressions: QualityRegression[];
  benchmarks: BenchmarkTrend[];
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
