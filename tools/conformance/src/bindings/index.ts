/**
 * A barrel that re-exports the composition root from its per-subject modules.
 *
 * The split per subject keeps a contract module and a declaration store out of
 * the same file. A re-export inside this package is not a subject import, so
 * the declaration-seam census finds nothing in this barrel.
 */
export { ARTIFACT_DIRS } from './artifacts.js';
export { BOUNDARY_DERIVATIONS } from './declaration.js';
export {
  LIVE_TOOLS,
  BUILD_TOOL_DESCRIPTION,
  auditLiveDescriptionBudgets,
} from './registry.js';
