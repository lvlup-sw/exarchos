import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const CONVERGENCE_VIEW = 'convergence';

// ─── Dimension Definitions ─────────────────────────────────────────────────

const ALL_DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const;

const DIMENSION_LABELS: Record<string, string> = {
  D1: 'Design Completeness',
  D2: 'Static Analysis',
  D3: 'Context Economy',
  D4: 'Operational Resilience',
  D5: 'Workflow Determinism',
};

// ─── View State Interface ─────────────────────────────────────────────────

export interface ConvergenceViewState {
  readonly featureId: string;
  readonly dimensions: Record<string, {
    readonly dimension: string;       // 'D1' | 'D2' | 'D3' | 'D4' | 'D5'
    readonly label: string;           // Human-readable name
    readonly gateResults: Array<{ gateName: string; passed: boolean; timestamp: string }>;
    readonly converged: boolean;      // All gates for this dimension passed
    readonly lastChecked: string | null;
  }>;
  readonly overallConverged: boolean;
  readonly uncheckedDimensions: string[];
}

// ─── Convergence Predicates ────────────────────────────────────────────────

function isDimensionConverged(
  gateResults: Array<{ gateName: string; passed: boolean; timestamp: string }>,
): boolean {
  if (gateResults.length === 0) return false;
  return gateResults.every((r) => r.passed);
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

// ─── Event Handlers ────────────────────────────────────────────────────────

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
  const existing = state.dimensions[dimension];

  const newGateResult = {
    gateName: data.gateName,
    passed,
    timestamp: event.timestamp,
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

// ─── Projection ────────────────────────────────────────────────────────────

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
