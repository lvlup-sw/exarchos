import type { WorkflowEvent } from '../../../events/schemas.js';
import { TELEMETRY_VIEW, telemetryProjection } from '../../telemetry/telemetry-projection.js';
import { CODE_QUALITY_VIEW, codeQualityProjection } from '../code-quality-view.js';
import { CONVERGENCE_VIEW, convergenceProjection } from '../convergence-view.js';
import { DELEGATION_READINESS_VIEW, delegationReadinessProjection } from '../delegation-readiness-view.js';
import { DELEGATION_TIMELINE_VIEW, delegationTimelineProjection } from '../delegation-timeline-view.js';
import { EVAL_RESULTS_VIEW, evalResultsProjection } from '../eval-results-view.js';
import { GATE_RELIABILITY_VIEW, gateReliabilityProjection } from '../gate-reliability-view.js';
import { ViewMaterializer, type ViewProjection } from '../materializer.js';
import { PIPELINE_SNAPSHOT_NAME, PIPELINE_VIEW, pipelineProjection } from '../pipeline-view.js';
import { PROVENANCE_VIEW, provenanceProjection } from '../provenance-view.js';
import { SHEPHERD_STATUS_VIEW, shepherdStatusProjection } from '../shepherd-status-view.js';
import { SnapshotStore } from '../snapshot-store.js';
import { STACK_VIEW, stackViewProjection } from '../stack-view.js';
import { SYNTHESIS_READINESS_VIEW, synthesisReadinessProjection } from '../synthesis-readiness-view.js';
import { TASK_DETAIL_VIEW, taskDetailProjection } from '../task-detail-view.js';
import { TEAM_PERFORMANCE_VIEW, teamPerformanceProjection } from '../team-performance-view.js';
import { WORKFLOW_STATE_VIEW, workflowStateProjection } from '../workflow-state-projection.js';
import { WORKFLOW_STATUS_VIEW, workflowStatusProjection } from '../workflow-status-view.js';

// ─── Helper: create a materializer with all projections registered ─────────


// #1555 — shared `asOf` bounded-fold seam (dispatch-core, INV-2).
// ─── Helper: create a materializer with all projections registered ─────────

/**
 * One registered view, with its state type sealed inside.
 *
 * Each projection folds to its own state shape, so a plain table of them has no
 * single element type that is not a cast. Closing over the type at construction
 * keeps both capabilities the roster needs — registration and a fold — without
 * one.
 */
export interface RegisteredView {
  readonly id: string;
  /** Register this projection, preserving its state type. */
  registerInto(materializer: ViewMaterializer): void;
  /** Fold a stream to this view's state, as a comparable value. */
  fold(events: readonly WorkflowEvent[]): unknown;
}

function registeredView<T>(id: string, projection: ViewProjection<T>): RegisteredView {
  return {
    id,
    registerInto: (materializer) => materializer.register(id, projection),
    fold: (events) =>
      events.reduce<T>((state, event) => projection.apply(state, event), projection.init()),
  };
}

/**
 * Every view the runtime materializes.
 *
 * Exported because registration is not the only thing that has to see this
 * roster. The telemetry-dependence differential folds each of these twice — once
 * over a full corpus and once with telemetry dropped — and a view reachable at
 * runtime but absent from the roster that differential walks would be an
 * unmeasured verdict surface, which is the gap that oracle exists to close.
 *
 * `createMaterializer` registers FROM this list rather than repeating it, so a
 * view cannot reach the runtime without joining the measured population.
 */
export const REGISTERED_VIEWS: readonly RegisteredView[] = Object.freeze([
  registeredView(WORKFLOW_STATUS_VIEW, workflowStatusProjection),
  registeredView(TASK_DETAIL_VIEW, taskDetailProjection),
  registeredView(PIPELINE_VIEW, pipelineProjection),
  registeredView(STACK_VIEW, stackViewProjection),
  registeredView(TELEMETRY_VIEW, telemetryProjection),
  registeredView(TEAM_PERFORMANCE_VIEW, teamPerformanceProjection),
  registeredView(DELEGATION_TIMELINE_VIEW, delegationTimelineProjection),
  registeredView(CODE_QUALITY_VIEW, codeQualityProjection),
  registeredView(EVAL_RESULTS_VIEW, evalResultsProjection),
  registeredView(WORKFLOW_STATE_VIEW, workflowStateProjection),
  registeredView(DELEGATION_READINESS_VIEW, delegationReadinessProjection),
  registeredView(SYNTHESIS_READINESS_VIEW, synthesisReadinessProjection),
  registeredView(SHEPHERD_STATUS_VIEW, shepherdStatusProjection),
  registeredView(PROVENANCE_VIEW, provenanceProjection),
  registeredView(CONVERGENCE_VIEW, convergenceProjection),
  registeredView(GATE_RELIABILITY_VIEW, gateReliabilityProjection),
]);

function createMaterializer(stateDir: string): ViewMaterializer {
  // DR-5/DR-6 snapshot-lineage registration: the pipeline view's snapshots move
  // to a versioned filename (`pipeline-v2`) so pre-upgrade v1 snapshots are
  // ignored and the stream re-folds to pick up `repoRoot`. The projection is
  // still registered under `PIPELINE_VIEW` below — only the on-disk lineage moves.
  const snapshotStore = new SnapshotStore(stateDir, {
    [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME,
  });
  const materializer = new ViewMaterializer({ snapshotStore });
  for (const view of REGISTERED_VIEWS) {
    view.registerInto(materializer);
  }
  return materializer;
}

// EventStore is no longer obtained through this module. After the
// constructor-injection refactor (#1182), every consumer receives the
// EventStore via DispatchContext. The previous registry/lazy-fallback
// pattern was eliminated to avoid the DIM-1 recurrence trap — see
// docs/rca/2026-04-26-v29-event-projection-cluster.md.

// ─── Cached Materializer ─────────────────────────────────────────────────────

let cachedMaterializer: ViewMaterializer | null = null;
let cachedStateDir: string | null = null;

/** @internal Exported for testing only */
export function getOrCreateMaterializer(stateDir: string): ViewMaterializer {
  if (cachedMaterializer && cachedStateDir === stateDir) {
    return cachedMaterializer;
  }
  cachedMaterializer = createMaterializer(stateDir);
  cachedStateDir = stateDir;
  return cachedMaterializer;
}

/** For testing: reset the singleton materializer cache. */
export function resetMaterializerCache(): void {
  cachedMaterializer = null;
  cachedStateDir = null;
}
