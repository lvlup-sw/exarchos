import { TELEMETRY_VIEW, telemetryProjection } from '../../telemetry/telemetry-projection.js';
import { CODE_QUALITY_VIEW, codeQualityProjection } from '../code-quality-view.js';
import { DELEGATION_READINESS_VIEW, delegationReadinessProjection } from '../delegation-readiness-view.js';
import { DELEGATION_TIMELINE_VIEW, delegationTimelineProjection } from '../delegation-timeline-view.js';
import { EVAL_RESULTS_VIEW, evalResultsProjection } from '../eval-results-view.js';
import { GATE_RELIABILITY_VIEW, gateReliabilityProjection } from '../gate-reliability-view.js';
import { ViewMaterializer } from '../materializer.js';
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

function createMaterializer(stateDir: string): ViewMaterializer {
  // DR-5/DR-6 snapshot-lineage registration: the pipeline view's snapshots move
  // to a versioned filename (`pipeline-v2`) so pre-upgrade v1 snapshots are
  // ignored and the stream re-folds to pick up `repoRoot`. The projection is
  // still registered under `PIPELINE_VIEW` below — only the on-disk lineage moves.
  const snapshotStore = new SnapshotStore(stateDir, {
    [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME,
  });
  const materializer = new ViewMaterializer({ snapshotStore });
  materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
  materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
  materializer.register(PIPELINE_VIEW, pipelineProjection);
  materializer.register(STACK_VIEW, stackViewProjection);
  materializer.register(TELEMETRY_VIEW, telemetryProjection);
  materializer.register(TEAM_PERFORMANCE_VIEW, teamPerformanceProjection);
  materializer.register(DELEGATION_TIMELINE_VIEW, delegationTimelineProjection);
  materializer.register(CODE_QUALITY_VIEW, codeQualityProjection);
  materializer.register(EVAL_RESULTS_VIEW, evalResultsProjection);
  materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
  materializer.register(DELEGATION_READINESS_VIEW, delegationReadinessProjection);
  materializer.register(SYNTHESIS_READINESS_VIEW, synthesisReadinessProjection);
  materializer.register(SHEPHERD_STATUS_VIEW, shepherdStatusProjection);
  materializer.register(PROVENANCE_VIEW, provenanceProjection);
  materializer.register(GATE_RELIABILITY_VIEW, gateReliabilityProjection);
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
