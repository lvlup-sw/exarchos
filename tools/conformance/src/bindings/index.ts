/**
 * The composition root, re-exported.
 *
 * Consumers import from here; the per-subject modules exist so that no single
 * file pairs a DR-1 contract module with a declaration store. Re-exports are
 * intra-package and carry no subject import of their own, so this barrel stays
 * clean under the declaration-seam census. See `./README.md`.
 */
export { ARTIFACT_DIRS } from './artifacts.js';
export { BOUNDARY_DERIVATIONS } from './declaration.js';
export {
  LIVE_TOOLS,
  BUILD_TOOL_DESCRIPTION,
  auditLiveDescriptionBudgets,
} from './registry.js';
