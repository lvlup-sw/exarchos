import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';

export const CODE_QUALITY_VIEW = 'code-quality';

export const MAX_BENCHMARKS = 50;
export const MAX_BENCHMARK_VALUES = 100;
export const MAX_REGRESSIONS = 50;
/** Cap on the mutation-score samples of one skill. */
export const MAX_MUTATION_SAMPLES = 100;

/** The mutation-score trend of one skill, from `details.mutationScore` of the `mutation-adequacy` gate. It has the shape of {@link BenchmarkTrend}. */
export interface MutationScoreTrend {
  readonly values: ReadonlyArray<{ readonly value: number; readonly commit: string; readonly timestamp: string }>;
  readonly trend: 'improving' | 'stable' | 'degrading';
}

export interface SkillQualityMetrics {
  readonly skill: string;
  readonly totalExecutions: number;
  readonly gatePassRate: number;
  readonly selfCorrectionRate: number;
  readonly avgRemediationAttempts: number;
  readonly topFailureCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  readonly latestPromptVersion?: string;
  /** Present after the view folds a `mutation-adequacy` gate result with a numeric `mutationScore`. */
  readonly mutationScoreTrend?: MutationScoreTrend;
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

export interface ModelQualityMetrics {
  readonly model: string;
  readonly totalExecutions: number;
  readonly gatePassRate: number;
}

export interface CodeQualityViewState {
  readonly skills: Record<string, SkillQualityMetrics>;
  readonly models: Record<string, ModelQualityMetrics>;
  readonly gates: Record<string, GateMetrics>;
  readonly regressions: ReadonlyArray<QualityRegression>;
  readonly benchmarks: ReadonlyArray<BenchmarkTrend>;
}

/** Consecutive failures of one gate and skill pair, for regression detection. It is not part of the public view type. */
interface FailureTracker {
  count: number;
  firstCommit: string;
  lastCommit: string;
}

/** Extended state that includes internal tracking. */
interface InternalState extends CodeQualityViewState {
  readonly _failureTrackers: Record<string, FailureTracker>;
  readonly _remediationCounts: Record<string, number>;
}

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

function defaultModelMetrics(model: string): ModelQualityMetrics {
  return {
    model,
    totalExecutions: 0,
    gatePassRate: 0,
  };
}

/**
 * Calculates the trend of the last three values, and returns `stable` for fewer than three.
 * By default, lower is better, so a falling series is `improving`. Pass `higherIsBetter` for a metric such as mutation score.
 */
function calculateTrend(
  values: Array<{ value: number }>,
  higherIsBetter = false,
): 'improving' | 'stable' | 'degrading' {
  if (values.length < 3) return 'stable';

  const recent = values.slice(-3);
  const diffs = [];
  for (let i = 1; i < recent.length; i++) {
    diffs.push((recent[i]?.value ?? 0) - (recent[i - 1]?.value ?? 0));
  }

  const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;

  if (avgDiff < -0.001) return higherIsBetter ? 'degrading' : 'improving';
  if (avgDiff > 0.001) return higherIsBetter ? 'improving' : 'degrading';
  return 'stable';
}

/** Add or increment a failure reason in the reasons array. */
function addFailureReason(
  reasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>,
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
  const partial = view as Partial<InternalState>;
  return {
    ...view,
    _failureTrackers: partial._failureTrackers ?? {},
    _remediationCounts: partial._remediationCounts ?? {},
  };
}

/**
 * Returns the public state with the tracker maps as non-enumerable properties.
 * Thus the maps survive the next `apply`, but stay out of `toEqual` and `JSON.stringify`.
 */
function fromInternal(state: InternalState): CodeQualityViewState {
  const { _failureTrackers, _remediationCounts, ...publicState } = state;
  const result = { ...publicState } as CodeQualityViewState;
  Object.defineProperty(result, '_failureTrackers', {
    value: _failureTrackers,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(result, '_remediationCounts', {
    value: _remediationCounts,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

/**
 * Folds one observed CI check into the metrics of `data.skill` only.
 * A CI check name can match the name of a repository gate, so the check stays out of `state.gates`.
 * It adds no model metrics, no failure tracker and no mutation trend.
 * A failed check counts as a failure category under its own name, because the record has no `reason`.
 */
function handleCiCheckObserved(
  state: InternalState,
  event: WorkflowEvent,
): CodeQualityViewState {
  const data = event.data as
    | { check?: unknown; passed?: unknown; skill?: unknown }
    | undefined;
  if (!data || typeof data.check !== 'string' || typeof data.skill !== 'string') {
    return fromInternal(state);
  }

  const passed = data.passed === true;
  const prev = state.skills[data.skill] ?? defaultSkillMetrics(data.skill);
  const totalExecutions = prev.totalExecutions + 1;
  const passCount = Math.round(prev.gatePassRate * prev.totalExecutions) + (passed ? 1 : 0);

  let categories = [...prev.topFailureCategories] as Array<{ category: string; count: number }>;
  if (!passed) {
    const existing = categories.find((c) => c.category === data.check);
    categories = existing
      ? categories.map((c) => (c.category === data.check ? { ...c, count: c.count + 1 } : c))
      : [...categories, { category: data.check, count: 1 }];
    categories.sort((a, b) => b.count - a.count);
    if (categories.length > 10) categories.length = 10;
  }

  return fromInternal({
    ...state,
    skills: {
      ...state.skills,
      [data.skill]: {
        ...prev,
        totalExecutions,
        gatePassRate: passCount / totalExecutions,
        topFailureCategories: categories,
      },
    },
  });
}

/**
 * Folds one gate result into the gate, skill, model and regression metrics.
 * Only the `mutation-adequacy` gate feeds the mutation trend, so a `mutationScore` from another gate has no effect.
 * Three consecutive failures of one gate and skill pair make a regression entry. A pass resets the count.
 */
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
  const model = typeof details.model === 'string' ? details.model : undefined;
  const commit = typeof details.commit === 'string' ? details.commit : undefined;
  const reason = typeof details.reason === 'string' ? details.reason : undefined;
  const promptVersion = typeof details.promptVersion === 'string' ? details.promptVersion : undefined;
  const mutationScore = gateName === 'mutation-adequacy' && typeof details.mutationScore === 'number'
    ? details.mutationScore
    : undefined;

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

  let updatedSkills = state.skills;
  if (skill) {
    const prevSkill = state.skills[skill] ?? defaultSkillMetrics(skill);
    const newExec = prevSkill.totalExecutions + 1;
    const skillPassCount = Math.round(prevSkill.gatePassRate * prevSkill.totalExecutions) + (passed ? 1 : 0);

    let updatedCategories = [...prevSkill.topFailureCategories] as Array<{ category: string; count: number }>;
    if (!passed) {
      const category = reason || gateName;
      const existing = updatedCategories.find(c => c.category === category);
      if (existing) {
        updatedCategories = updatedCategories.map(c =>
          c.category === category ? { ...c, count: c.count + 1 } : c,
        );
      } else {
        updatedCategories.push({ category, count: 1 });
      }
      updatedCategories.sort((a, b) => b.count - a.count);
      if (updatedCategories.length > 10) {
        updatedCategories.length = 10;
      }
    }

    let mutationScoreTrend = prevSkill.mutationScoreTrend;
    if (mutationScore !== undefined) {
      const prevValues = prevSkill.mutationScoreTrend?.values ?? [];
      let values = [
        ...prevValues,
        { value: mutationScore, commit: commit ?? '', timestamp: event.timestamp },
      ];
      if (values.length > MAX_MUTATION_SAMPLES) {
        values = values.slice(values.length - MAX_MUTATION_SAMPLES);
      }
      mutationScoreTrend = { values, trend: calculateTrend(values, true) };
    }

    updatedSkills = {
      ...state.skills,
      [skill]: {
        ...prevSkill,
        totalExecutions: newExec,
        gatePassRate: skillPassCount / newExec,
        topFailureCategories: updatedCategories,
        ...(promptVersion !== undefined ? { latestPromptVersion: promptVersion } : {}),
        ...(mutationScoreTrend !== undefined ? { mutationScoreTrend } : {}),
      },
    };
  }

  let updatedModels = state.models;
  if (model) {
    const prevModel = state.models[model] ?? defaultModelMetrics(model);
    const newModelExec = prevModel.totalExecutions + 1;
    const modelPassCount = Math.round(prevModel.gatePassRate * prevModel.totalExecutions) + (passed ? 1 : 0);

    updatedModels = {
      ...state.models,
      [model]: {
        ...prevModel,
        totalExecutions: newModelExec,
        gatePassRate: modelPassCount / newModelExec,
      },
    };
  }

  const tKey = trackerKey(gateName, skill ?? '_none_');
  let updatedTrackers = { ...state._failureTrackers };
  let updatedRegressions = state.regressions;

  if (passed) {
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

    if (newTracker.count >= 3) {
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

  if (updatedRegressions.length > MAX_REGRESSIONS) {
    updatedRegressions = updatedRegressions.slice(updatedRegressions.length - MAX_REGRESSIONS);
  }

  return fromInternal({
    ...state,
    gates: { ...state.gates, [gateName]: updatedGate },
    skills: updatedSkills,
    models: updatedModels,
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
      let updatedValues = [
        ...existing.values,
        { value: result.value, commit: data.taskId ?? '', timestamp: event.timestamp },
      ];
      if (updatedValues.length > MAX_BENCHMARK_VALUES) {
        updatedValues = updatedValues.slice(updatedValues.length - MAX_BENCHMARK_VALUES);
      }
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

  if (benchmarks.length > MAX_BENCHMARKS) {
    benchmarks = benchmarks.slice(benchmarks.length - MAX_BENCHMARKS);
  }

  return fromInternal({
    ...state,
    benchmarks,
  });
}

/**
 * Updates the self-correction metrics of a skill.
 * `selfCorrectionRate` is the corrections divided by the failures in the skill metrics, at most 1. It is 0 when there are no failures.
 * `avgRemediationAttempts` is the running average of `totalAttempts` over all corrections.
 */
function handleRemediationSucceeded(state: InternalState, event: WorkflowEvent): CodeQualityViewState {
  const data = event.data as {
    skill?: string;
    totalAttempts?: number;
  } | undefined;

  if (!data?.skill) return fromInternal(state);

  const skill = data.skill;
  const totalAttempts = data.totalAttempts ?? 1;

  const metrics = state.skills[skill] ?? defaultSkillMetrics(skill);
  const prevCorrections = state._remediationCounts[skill] ?? 0;
  const corrections = prevCorrections + 1;

  const totalFailures = metrics.totalExecutions - Math.round(metrics.gatePassRate * metrics.totalExecutions);

  const selfCorrectionRate = totalFailures > 0
    ? Math.min(corrections / totalFailures, 1)
    : 0;

  const avgRemediationAttempts = runningAverage(
    metrics.avgRemediationAttempts, corrections, totalAttempts,
  );

  return fromInternal({
    ...state,
    skills: {
      ...state.skills,
      [skill]: {
        ...metrics,
        selfCorrectionRate,
        avgRemediationAttempts,
      },
    },
    _remediationCounts: {
      ...state._remediationCounts,
      [skill]: corrections,
    },
  });
}

/**
 * Returns the handler for an event type, or `undefined` when the view ignores the type.
 * With this lookup, `toInternal` has one call site. A handler that gets the public view loses the non-enumerable tracker maps on its first spread.
 * Then regression detection and the remediation count restart from zero without an error.
 */
function handlerFor(
  type: WorkflowEvent['type'],
): ((state: InternalState, event: WorkflowEvent) => CodeQualityViewState) | undefined {
  switch (type) {
    case 'gate.executed':
      return handleGateExecuted;
    case 'ci.check_observed':
      return handleCiCheckObserved;
    case 'benchmark.completed':
      return handleBenchmarkCompleted;
    case 'remediation.succeeded':
      return handleRemediationSucceeded;
    default:
      return undefined;
  }
}

export const codeQualityProjection: ViewProjection<CodeQualityViewState> = {
  init: (): CodeQualityViewState => ({
    skills: {},
    models: {},
    gates: {},
    regressions: [],
    benchmarks: [],
  }),

  apply: (view: CodeQualityViewState, event: WorkflowEvent): CodeQualityViewState => {
    const handler = handlerFor(event.type);
    if (handler === undefined || !event.data) return view;
    return handler(toInternal(view), event);
  },
};
