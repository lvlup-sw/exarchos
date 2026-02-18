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

// ─── Internal Tracking State ───────────────────────────────────────────────

/**
 * Tracks consecutive gate failures per gate+skill combination for
 * regression detection. This is carried alongside the view state but
 * not exposed externally.
 */
interface FailureTracker {
  count: number;
  firstCommit: string;
  lastCommit: string;
}

/** Extended state that includes internal tracking. */
interface InternalState extends CodeQualityViewState {
  readonly _failureTrackers: Record<string, FailureTracker>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Compute running average: newAvg = (oldAvg * (n-1) + newVal) / n */
function runningAverage(oldAvg: number, n: number, newVal: number): number {
  return (oldAvg * (n - 1) + newVal) / n;
}

function defaultGateMetrics(gate: string): GateMetrics {
  return {
    gate,
    executionCount: 0,
    passRate: 0,
    avgDuration: 0,
    failureReasons: [],
  };
}

function defaultSkillMetrics(skill: string): SkillQualityMetrics {
  return {
    skill,
    totalExecutions: 0,
    gatePassRate: 0,
    selfCorrectionRate: 0,
    avgRemediationAttempts: 0,
    topFailureCategories: [],
  };
}

/** Calculate trend direction from last 3+ values. */
function calculateTrend(values: Array<{ value: number }>): 'improving' | 'stable' | 'degrading' {
  if (values.length < 3) return 'stable';

  const recent = values.slice(-3);
  const diffs = [];
  for (let i = 1; i < recent.length; i++) {
    diffs.push(recent[i].value - recent[i - 1].value);
  }

  const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;

  if (avgDiff < -0.001) return 'improving';
  if (avgDiff > 0.001) return 'degrading';
  return 'stable';
}

/** Add or increment a failure reason in the reasons array. */
function addFailureReason(
  reasons: Array<{ reason: string; count: number }>,
  reason: string,
): Array<{ reason: string; count: number }> {
  const existing = reasons.find((r) => r.reason === reason);
  if (existing) {
    return reasons.map((r) =>
      r.reason === reason ? { ...r, count: r.count + 1 } : r,
    );
  }
  return [...reasons, { reason, count: 1 }];
}

/** Build a tracker key from gate and skill. */
function trackerKey(gate: string, skill: string): string {
  return `${gate}:${skill}`;
}

/** Convert public view state to internal state with failure trackers. */
function toInternal(view: CodeQualityViewState): InternalState {
  return {
    ...view,
    _failureTrackers: (view as Partial<InternalState>)._failureTrackers ?? {},
  };
}

/** Create a result that hides _failureTrackers from enumeration. */
function fromInternal(state: InternalState): CodeQualityViewState {
  const { _failureTrackers, ...publicState } = state;
  const result = { ...publicState } as CodeQualityViewState;
  // Store trackers as non-enumerable so they survive apply() chaining
  // but don't leak into toEqual/JSON.stringify comparisons
  Object.defineProperty(result, '_failureTrackers', {
    value: _failureTrackers,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

// ─── Event Handlers ────────────────────────────────────────────────────────

function handleGateExecuted(state: InternalState, event: WorkflowEvent): CodeQualityViewState {
  const data = event.data as {
    gateName?: string;
    layer?: string;
    passed?: boolean;
    duration?: number;
    details?: Record<string, unknown>;
  } | undefined;

  if (!data) return fromInternal(state);

  const gateName = data.gateName;
  if (!gateName) return fromInternal(state);

  const passed = data.passed ?? false;
  const duration = data.duration ?? 0;
  const details = data.details ?? {};
  const skill = typeof details.skill === 'string' ? details.skill : undefined;
  const commit = typeof details.commit === 'string' ? details.commit : undefined;
  const reason = typeof details.reason === 'string' ? details.reason : undefined;

  // Update gate metrics
  const prevGate = state.gates[gateName] ?? defaultGateMetrics(gateName);
  const newCount = prevGate.executionCount + 1;
  const passedCount = Math.round(prevGate.passRate * prevGate.executionCount) + (passed ? 1 : 0);

  const updatedGate: GateMetrics = {
    ...prevGate,
    executionCount: newCount,
    passRate: passedCount / newCount,
    avgDuration: runningAverage(prevGate.avgDuration, newCount, duration),
    failureReasons: !passed && reason
      ? addFailureReason(prevGate.failureReasons, reason)
      : prevGate.failureReasons,
  };

  // Update skill metrics if skill is present
  let updatedSkills = state.skills;
  if (skill) {
    const prevSkill = state.skills[skill] ?? defaultSkillMetrics(skill);
    const newExec = prevSkill.totalExecutions + 1;
    const skillPassCount = Math.round(prevSkill.gatePassRate * prevSkill.totalExecutions) + (passed ? 1 : 0);

    updatedSkills = {
      ...state.skills,
      [skill]: {
        ...prevSkill,
        totalExecutions: newExec,
        gatePassRate: skillPassCount / newExec,
      },
    };
  }

  // Update failure trackers for regression detection
  const tKey = trackerKey(gateName, skill ?? '_none_');
  let updatedTrackers = { ...state._failureTrackers };
  let updatedRegressions = state.regressions;

  if (passed) {
    // Reset failure counter on pass
    const { [tKey]: _removed, ...rest } = updatedTrackers;
    updatedTrackers = rest;
  } else {
    const prevTracker = updatedTrackers[tKey];
    const newTracker: FailureTracker = {
      count: (prevTracker?.count ?? 0) + 1,
      firstCommit: prevTracker?.firstCommit ?? commit ?? '',
      lastCommit: commit ?? prevTracker?.lastCommit ?? '',
    };
    updatedTrackers = { ...updatedTrackers, [tKey]: newTracker };

    // Create regression entry at threshold
    if (newTracker.count >= 3) {
      // Remove any existing regression for this gate+skill, then add updated one
      const filtered = state.regressions.filter(
        (r) => !(r.gate === gateName && r.skill === (skill ?? '_none_')),
      );
      updatedRegressions = [
        ...filtered,
        {
          skill: skill ?? '_none_',
          gate: gateName,
          consecutiveFailures: newTracker.count,
          firstFailureCommit: newTracker.firstCommit,
          lastFailureCommit: newTracker.lastCommit,
          detectedAt: event.timestamp,
        },
      ];
    }
  }

  return fromInternal({
    ...state,
    gates: { ...state.gates, [gateName]: updatedGate },
    skills: updatedSkills,
    regressions: updatedRegressions,
    _failureTrackers: updatedTrackers,
  });
}

function handleBenchmarkCompleted(state: InternalState, event: WorkflowEvent): CodeQualityViewState {
  const data = event.data as {
    taskId?: string;
    results?: Array<{
      operation: string;
      metric: string;
      value: number;
      unit: string;
      passed: boolean;
    }>;
  } | undefined;

  if (!data?.results) return fromInternal(state);

  let benchmarks = [...state.benchmarks];

  for (const result of data.results) {
    const existing = benchmarks.find(
      (b) => b.operation === result.operation && b.metric === result.metric,
    );

    if (existing) {
      const updatedValues = [
        ...existing.values,
        { value: result.value, commit: data.taskId ?? '', timestamp: event.timestamp },
      ];
      const updatedTrend = calculateTrend(updatedValues);

      benchmarks = benchmarks.map((b) =>
        b.operation === result.operation && b.metric === result.metric
          ? { ...b, values: updatedValues, trend: updatedTrend }
          : b,
      );
    } else {
      const values = [{ value: result.value, commit: data.taskId ?? '', timestamp: event.timestamp }];
      benchmarks = [
        ...benchmarks,
        {
          operation: result.operation,
          metric: result.metric,
          values,
          trend: 'stable' as const,
        },
      ];
    }
  }

  return fromInternal({
    ...state,
    benchmarks,
  });
}

// ─── Projection ────────────────────────────────────────────────────────────

export const codeQualityProjection: ViewProjection<CodeQualityViewState> = {
  init: (): CodeQualityViewState => ({
    skills: {},
    gates: {},
    regressions: [],
    benchmarks: [],
  }),

  apply: (view: CodeQualityViewState, event: WorkflowEvent): CodeQualityViewState => {
    switch (event.type) {
      case 'gate.executed': {
        if (!event.data) return view;
        const state = toInternal(view);
        return handleGateExecuted(state, event);
      }

      case 'benchmark.completed': {
        if (!event.data) return view;
        const state = toInternal(view);
        return handleBenchmarkCompleted(state, event);
      }

      default:
        return view;
    }
  },
};
