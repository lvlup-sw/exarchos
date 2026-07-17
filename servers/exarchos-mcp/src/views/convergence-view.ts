import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const CONVERGENCE_VIEW = 'convergence';

// ─── Dimension Definitions ─────────────────────────────────────────────────

export const ALL_DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const;

const DIMENSION_LABELS: Record<string, string> = {
  D1: 'Design Completeness',
  D2: 'Static Analysis',
  D3: 'Context Economy',
  D4: 'Operational Resilience',
  D5: 'Workflow Determinism',
};

// ─── View State Interface ─────────────────────────────────────────────────

/**
 * A single gate result captured under a convergence dimension.
 *
 * `skipped` and `skipReason` are populated when the underlying gate could not
 * actually run (e.g. static-analysis on a repo with no recognized toolchain).
 * A skipped gate has `passed: false` AND `skipped: true` — this is distinct
 * from a real failure (passed: false, skipped undefined/false). The dimension
 * is treated as not-converged in either case so a skip never falsely-greens
 * convergence. See DR-4 in docs/plans/archive/2026-05-04-v290-dogfood-bundle.md.
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
  readonly dimensions: Record<string, {
    readonly dimension: string;       // 'D1' | 'D2' | 'D3' | 'D4' | 'D5'
    readonly label: string;           // Human-readable name
    readonly gateResults: ConvergenceGateResult[];
    readonly converged: boolean;      // All gates for this dimension passed
    readonly lastChecked: string | null;
  }>;
  readonly overallConverged: boolean;
  readonly uncheckedDimensions: string[];
}

// ─── Convergence Predicates ────────────────────────────────────────────────

function isDimensionConverged(
  gateResults: ConvergenceGateResult[],
): boolean {
  if (gateResults.length === 0) return false;

  // Check only the latest result per unique gate name so retries can recover.
  // A gate is only "green" when passed AND not skipped — a skipped gate is
  // inconclusive, never converged (T-10 / DR-4).
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
  const phase = data.details?.phase as string | undefined;
  // T-10 / DR-4: surface skipped/skipReason from the event details so
  // downstream rendering can distinguish a skipped (inconclusive) gate
  // from a true pass or fail. A skipped gate is never converged.
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
