// ─── The view composite-tool surface — published module path ────────────────
//
// One handler per view, each in its own module under `handlers/`, plus the
// three pieces they share: the cached materializer, the delta-query seam, and
// the two contract helpers that shape compact and analytic responses. This
// file is the path every consumer already imports, so it stays the surface's
// published identity and the split is invisible to callers.
//
// Nothing is handled here. A new view gets a module under `handlers/` and a
// line below.

export { getOrCreateMaterializer, resetMaterializerCache } from './handlers/materializer.js';
export {
  hasCorrelationFilters,
  deriveCorrelationFilters,
  queryDeltaEvents,
  materializeFiltered,
  type ViewQueryFilters,
} from './handlers/query.js';

export { handleViewWorkflowStatus } from './handlers/workflow-status.js';
export { handleViewTasks } from './handlers/tasks.js';
export { handleViewPipeline } from './handlers/pipeline.js';
export { handleViewTeamPerformance } from './handlers/team-performance.js';
export { handleViewDelegationTimeline } from './handlers/delegation-timeline.js';
export { handleViewCodeQuality } from './handlers/code-quality.js';
export { handleViewEvalResults } from './handlers/eval-results.js';
export { handleViewQualityHints } from './handlers/quality-hints.js';
export { handleViewQualityCorrelation } from './handlers/quality-correlation.js';
export { handleViewQualityAttribution } from './handlers/quality-attribution.js';
export { handleViewSessionProvenance } from './handlers/session-provenance.js';
export { handleViewDelegationReadiness } from './handlers/delegation-readiness.js';
export { handleViewSynthesisReadiness } from './handlers/synthesis-readiness.js';
export { handleViewShepherdStatus } from './handlers/shepherd-status.js';
export { handleViewProvenance } from './handlers/provenance.js';
export { handleViewConvergence } from './handlers/convergence.js';
export { handleViewGateReliability } from './handlers/gate-reliability.js';
