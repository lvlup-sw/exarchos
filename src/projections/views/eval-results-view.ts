import type { ViewProjection } from './materializer.js';
import { JudgeCalibratedDataSchema, type WorkflowEvent } from '../../events/schemas.js';

export const EVAL_RESULTS_VIEW = 'eval-results';

export const MAX_EVAL_RUNS = 100;
export const MAX_CALIBRATIONS = 50;
export const MAX_SCORE_HISTORY = 50;

export interface SkillEvalMetrics {
  readonly skill: string;
  readonly latestScore: number;
  readonly trend: 'improving' | 'stable' | 'degrading';
  readonly lastRunId: string;
  readonly lastRunTimestamp: string;
  readonly totalRuns: number;
  readonly regressionCount: number;
  readonly capabilityPassRate: number;
}

export interface EvalRunRecord {
  readonly runId: string;
  readonly suiteId: string;
  readonly trigger: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly avgScore: number;
  readonly duration: number;
  readonly timestamp: string;
}

export interface EvalRegression {
  readonly caseId: string;
  readonly suiteId: string;
  readonly firstFailedRunId: string;
  readonly consecutiveFailures: number;
}

export interface CalibrationRecord {
  readonly skill: string;
  readonly rubricName: string;
  readonly split: string;
  readonly tpr: number;
  readonly tnr: number;
  readonly accuracy: number;
  readonly f1: number;
  readonly calibratedAt: string;
}

export interface EvalResultsViewState {
  readonly skills: Record<string, SkillEvalMetrics>;
  readonly runs: ReadonlyArray<EvalRunRecord>;
  readonly regressions: ReadonlyArray<EvalRegression>;
  readonly calibrations: ReadonlyArray<CalibrationRecord>;
}

interface CaseHistory {
  lastPassed: boolean;
  consecutiveFailures: number;
  firstFailedRunId: string;
}

interface ScoreHistory {
  scores: number[];
}

interface InternalState extends EvalResultsViewState {
  readonly _caseHistory: Record<string, CaseHistory>;
  readonly _scoreHistory: Record<string, ScoreHistory>;
}

/** Returns the trend of the last 3 scores. With fewer than 3 scores, it returns `stable`. */
function calculateTrend(scores: number[]): 'improving' | 'stable' | 'degrading' {
  if (scores.length < 3) return 'stable';

  const recent = scores.slice(-3);
  const diffs: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    diffs.push((recent[i] ?? 0) - (recent[i - 1] ?? 0));
  }

  const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;

  if (avgDiff > 0.001) return 'improving';
  if (avgDiff < -0.001) return 'degrading';
  return 'stable';
}

/** Convert public view state to internal state. */
function toInternal(view: EvalResultsViewState): InternalState {
  return {
    ...view,
    _caseHistory: (view as Partial<InternalState>)._caseHistory ?? {},
    _scoreHistory: (view as Partial<InternalState>)._scoreHistory ?? {},
  };
}

/**
 * Returns the public state, with the internal trackers as non-enumerable properties.
 * The trackers survive the next `apply`, but `toEqual` and `JSON.stringify` do not see them.
 */
function fromInternal(state: InternalState): EvalResultsViewState {
  const { _caseHistory, _scoreHistory, ...publicState } = state;
  const result = { ...publicState } as EvalResultsViewState;
  Object.defineProperty(result, '_caseHistory', {
    value: _caseHistory,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(result, '_scoreHistory', {
    value: _scoreHistory,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

/**
 * Records the run and updates the metrics of its skill, keyed by `suiteId`.
 * `capabilityPassRate` is the passed cases over the total cases, for the stored runs of that suite and the new run.
 */
function handleEvalRunCompleted(state: InternalState, event: WorkflowEvent): EvalResultsViewState {
  const data = event.data as {
    runId?: string;
    suiteId?: string;
    trigger?: string;
    total?: number;
    passed?: number;
    failed?: number;
    avgScore?: number;
    duration?: number;
    regressions?: string[];
  } | undefined;

  if (!data) return fromInternal(state);

  const runId = data.runId ?? '';
  const suiteId = data.suiteId ?? '';
  const trigger = data.trigger ?? 'local';
  const total = data.total ?? 0;
  const passed = data.passed ?? 0;
  const failed = data.failed ?? 0;
  const avgScore = data.avgScore ?? 0;
  const duration = data.duration ?? 0;

  const newRun: EvalRunRecord = {
    runId,
    suiteId,
    trigger,
    total,
    passed,
    failed,
    avgScore,
    duration,
    timestamp: event.timestamp,
  };

  const prevScoreHistory = state._scoreHistory[suiteId] ?? { scores: [] };
  let updatedScores = [...prevScoreHistory.scores, avgScore];
  if (updatedScores.length > MAX_SCORE_HISTORY) {
    updatedScores = updatedScores.slice(updatedScores.length - MAX_SCORE_HISTORY);
  }
  const trend = calculateTrend(updatedScores);

  const regressionCount = state.regressions.filter((r) => r.suiteId === suiteId).length;

  const skillRuns = [...state.runs.filter((r) => r.suiteId === suiteId), newRun];
  const totalPassed = skillRuns.reduce((sum, r) => sum + r.passed, 0);
  const totalCases = skillRuns.reduce((sum, r) => sum + r.total, 0);
  const capabilityPassRate = totalCases > 0 ? totalPassed / totalCases : 0;

  const prevSkill = state.skills[suiteId];
  const updatedSkill: SkillEvalMetrics = {
    skill: suiteId,
    latestScore: avgScore,
    trend,
    lastRunId: runId,
    lastRunTimestamp: event.timestamp,
    totalRuns: (prevSkill?.totalRuns ?? 0) + 1,
    regressionCount,
    capabilityPassRate,
  };

  let updatedRuns = [...state.runs, newRun];
  if (updatedRuns.length > MAX_EVAL_RUNS) {
    updatedRuns = updatedRuns.slice(updatedRuns.length - MAX_EVAL_RUNS);
  }

  return fromInternal({
    ...state,
    skills: { ...state.skills, [suiteId]: updatedSkill },
    runs: updatedRuns,
    _scoreHistory: { ...state._scoreHistory, [suiteId]: { scores: updatedScores } },
  });
}

/**
 * A passed case clears its regression.
 * A failed case adds or updates a regression only when it passed before or already has a regression.
 */
function handleEvalCaseCompleted(state: InternalState, event: WorkflowEvent): EvalResultsViewState {
  const data = event.data as {
    runId?: string;
    caseId?: string;
    suiteId?: string;
    passed?: boolean;
  } | undefined;

  if (!data) return fromInternal(state);

  const caseId = data.caseId ?? '';
  const suiteId = data.suiteId ?? '';
  const passed = data.passed ?? false;
  const runId = data.runId ?? '';
  const caseKey = `${suiteId}:${caseId}`;

  const prevHistory = state._caseHistory[caseKey];
  let updatedRegressions = [...state.regressions];

  if (passed) {
    updatedRegressions = updatedRegressions.filter(
      (r) => !(r.caseId === caseId && r.suiteId === suiteId),
    );

    return fromInternal({
      ...state,
      regressions: updatedRegressions,
      _caseHistory: {
        ...state._caseHistory,
        [caseKey]: {
          lastPassed: true,
          consecutiveFailures: 0,
          firstFailedRunId: '',
        },
      },
    });
  }

  const wasPreviouslyPassing = prevHistory?.lastPassed === true;
  const prevConsecutiveFailures = prevHistory?.consecutiveFailures ?? 0;
  const newConsecutiveFailures = prevConsecutiveFailures + 1;
  const firstFailedRunId = prevHistory?.firstFailedRunId && !wasPreviouslyPassing
    ? prevHistory.firstFailedRunId
    : runId;

  const hadRegression = state.regressions.some(
    (r) => r.caseId === caseId && r.suiteId === suiteId,
  );

  if (wasPreviouslyPassing || hadRegression) {
    updatedRegressions = updatedRegressions.filter(
      (r) => !(r.caseId === caseId && r.suiteId === suiteId),
    );

    updatedRegressions.push({
      caseId,
      suiteId,
      firstFailedRunId,
      consecutiveFailures: newConsecutiveFailures,
    });
  }

  return fromInternal({
    ...state,
    regressions: updatedRegressions,
    _caseHistory: {
      ...state._caseHistory,
      [caseKey]: {
        lastPassed: false,
        consecutiveFailures: newConsecutiveFailures,
        firstFailedRunId,
      },
    },
  });
}

function handleJudgeCalibrated(state: InternalState, event: WorkflowEvent): EvalResultsViewState {
  const parsed = JudgeCalibratedDataSchema.safeParse(event.data);
  if (!parsed.success) return fromInternal(state);
  const data = parsed.data;

  const record: CalibrationRecord = {
    skill: data.skill,
    rubricName: data.rubricName,
    split: data.split,
    tpr: data.tpr,
    tnr: data.tnr,
    accuracy: data.accuracy,
    f1: data.f1,
    calibratedAt: event.timestamp,
  };

  let updatedCalibrations = [...state.calibrations, record];
  if (updatedCalibrations.length > MAX_CALIBRATIONS) {
    updatedCalibrations = updatedCalibrations.slice(updatedCalibrations.length - MAX_CALIBRATIONS);
  }

  return fromInternal({
    ...state,
    calibrations: updatedCalibrations,
  });
}

export const evalResultsProjection: ViewProjection<EvalResultsViewState> = {
  init: (): EvalResultsViewState => ({
    skills: {},
    runs: [],
    regressions: [],
    calibrations: [],
  }),

  apply: (view: EvalResultsViewState, event: WorkflowEvent): EvalResultsViewState => {
    switch (event.type) {
      case 'eval.run.completed': {
        if (!event.data) return view;
        const state = toInternal(view);
        return handleEvalRunCompleted(state, event);
      }

      case 'eval.case.completed': {
        if (!event.data) return view;
        const state = toInternal(view);
        return handleEvalCaseCompleted(state, event);
      }

      case 'eval.judge.calibrated': {
        if (!event.data) return view;
        const state = toInternal(view);
        return handleJudgeCalibrated(state, event);
      }

      default:
        return view;
    }
  },
};
