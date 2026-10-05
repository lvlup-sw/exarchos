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

/**
 * One registered view, with its state type sealed inside.
 * Each projection folds to its own state shape, so a plain table of projections needs a cast.
 * A closure over the type gives the roster registration and a fold without a cast.
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
 * The telemetry-dependence differential folds each view twice: once over a full corpus, and once with telemetry dropped.
 * `createMaterializer` registers from this list, so a view cannot reach the runtime without that measurement.
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

/**
 * Builds a materializer with every view in `REGISTERED_VIEWS`.
 * Pipeline view snapshots use the versioned name `PIPELINE_SNAPSHOT_NAME`, so the store ignores older snapshots and the stream folds again.
 */
function createMaterializer(stateDir: string): ViewMaterializer {
  const snapshotStore = new SnapshotStore(stateDir, {
    [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME,
  });
  const materializer = new ViewMaterializer({ snapshotStore });
  for (const view of REGISTERED_VIEWS) {
    view.registerInto(materializer);
  }
  return materializer;
}

let cachedMaterializer: ViewMaterializer | null = null;
let cachedStateDir: string | null = null;

/** @internal Returns the cached materializer for `stateDir`. A different `stateDir` replaces the cache. */
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
