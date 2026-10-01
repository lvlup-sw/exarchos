import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';

export const CONVERGENCE_VIEW = 'convergence';

export const ALL_DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const;

const DIMENSION_LABELS: Record<string, string> = {
  D1: 'Design Completeness',
  D2: 'Static Analysis',
  D3: 'Context Economy',
  D4: 'Operational Resilience',
  D5: 'Workflow Determinism',
};

/**
 * One gate result under a convergence dimension.
 * `skipped` and `skipReason` are set when the gate did not run, for example static analysis with no known toolchain.
 * A skipped gate is not a pass, so it never makes a dimension converged.
 */
export interface ConvergenceGateResult {
  readonly gateName: string;
  readonly passed: boolean;
  readonly timestamp: string;
  readonly phase?: string;
  readonly skipped?: boolean;
  readonly skipReason?: string;
}

export interface ConvergenceViewState {
  readonly featureId: string;
  /** Results for each dimension, keyed by `D1` to `D5`. `label` is the readable name of the dimension. */
  readonly dimensions: Record<string, {
    readonly dimension: string;
    readonly label: string;
    readonly gateResults: ConvergenceGateResult[];
    readonly converged: boolean;
    readonly lastChecked: string | null;
  }>;
  readonly overallConverged: boolean;
  readonly uncheckedDimensions: string[];
}

/**
 * True when the latest result of each gate passed and was not skipped.
 * Only the latest result of each gate counts, so a retry can recover a failed gate.
 */
function isDimensionConverged(
  gateResults: ConvergenceGateResult[],
): boolean {
  if (gateResults.length === 0) return false;

  const latestByGate = new Map<string, { passed: boolean; skipped: boolean }>();
  for (const r of gateResults) {
    latestByGate.set(r.gateName, { passed: r.passed, skipped: r.skipped === true });
  }
  return [...latestByGate.values()].every((v) => v.passed && !v.skipped);
}

function computeUncheckedDimensions(
  dimensions: ConvergenceViewState['dimensions'],
): string[] {
  return ALL_DIMENSIONS.filter((d) => {
    const dim = dimensions[d];
    return !dim || dim.gateResults.length === 0;
  });
}

function computeOverallConverged(
  dimensions: ConvergenceViewState['dimensions'],
): boolean {
  return ALL_DIMENSIONS.every((d) => {
    const dim = dimensions[d];
    return dim && dim.gateResults.length > 0 && dim.converged;
  });
}

/**
 * Folds a `gate.executed` event whose `details.dimension` is `D1` to `D5` into that dimension.
 * It copies `skipped` and `skipReason` from `details`, so a reader can tell a skipped gate from a pass or a fail.
 */
function handleGateExecuted(
  state: ConvergenceViewState,
  event: WorkflowEvent,
): ConvergenceViewState {
  const data = event.data as {
    gateName?: string;
    passed?: boolean;
    details?: Record<string, unknown>;
  } | undefined;

  if (!data?.gateName) return state;

  const dimension = data.details?.dimension as string | undefined;
  if (!dimension) return state;

  if (!ALL_DIMENSIONS.includes(dimension as typeof ALL_DIMENSIONS[number])) return state;

  const passed = data.passed ?? false;
  const phase = data.details?.phase as string | undefined;
  const skipped = data.details?.skipped === true ? true : undefined;
  const skipReason = typeof data.details?.skipReason === 'string'
    ? (data.details.skipReason as string)
    : undefined;
  const existing = state.dimensions[dimension];

  const newGateResult: ConvergenceGateResult = {
    gateName: data.gateName,
    passed,
    timestamp: event.timestamp,
    ...(phase !== undefined && { phase }),
    ...(skipped !== undefined && { skipped }),
    ...(skipReason !== undefined && { skipReason }),
  };

  const updatedGateResults = existing
    ? [...existing.gateResults, newGateResult]
    : [newGateResult];

  const converged = isDimensionConverged(updatedGateResults);

  const updatedDimension = {
    dimension,
    label: DIMENSION_LABELS[dimension] ?? dimension,
    gateResults: updatedGateResults,
    converged,
    lastChecked: event.timestamp,
  };

  const updatedDimensions = {
    ...state.dimensions,
    [dimension]: updatedDimension,
  };

  return {
    ...state,
    dimensions: updatedDimensions,
    overallConverged: computeOverallConverged(updatedDimensions),
    uncheckedDimensions: computeUncheckedDimensions(updatedDimensions),
  };
}

export const convergenceProjection: ViewProjection<ConvergenceViewState> = {
  init: (): ConvergenceViewState => ({
    featureId: '',
    dimensions: {},
    overallConverged: false,
    uncheckedDimensions: [...ALL_DIMENSIONS],
  }),

  apply: (view: ConvergenceViewState, event: WorkflowEvent): ConvergenceViewState => {
    switch (event.type) {
      case 'gate.executed':
        return handleGateExecuted(view, event);

      default:
        return view;
    }
  },
};
