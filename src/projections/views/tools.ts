/**
 * The published module path of the view composite-tool surface. Consumers import from here.
 * Each view handler has its own module under `handlers/`, beside the shared materializer,
 * delta-query, and contract modules. This file holds no handler and only re-exports.
 * A new view gets a module under `handlers/` and an export line here.
 */

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
