// ─── The workflow composite-tool surface — published module path ────────────
//
// One handler per action, each in its own module under `handlers/`. This file
// is the path every consumer already imports, so it stays the surface's
// published identity and the split is invisible to callers.
//
// Nothing is handled here. A new workflow action gets a module under
// `handlers/` and a line below; a handler body written in this file is the one
// thing this arrangement exists to prevent, because it is how a 2,062-line
// module grew the last time.

export { CURRENT_ES_VERSION, isEventSourced } from './handlers/shared.js';

// ─── Legacy materializer setter — kept as a no-op for test compatibility ────
//
// `configureWorkflowMaterializer` was the install seam for a module-level
// `ViewMaterializer` singleton that gated the ES v2 read and snapshot paths.
// That singleton was retired (#1867 reverted the projection reverts that
// depended on it; see `handlers/shared.ts` §"Module-Level ViewMaterializer
// (removed)") because nothing in `src/` ever set it, so both ES v2 paths were
// dark in the shipped composition. The handlers now resolve the materializer
// per-stateDir via `getOrCreateMaterializer(stateDir)`.
//
// The import path stays so the seven test files that wired it for fixture
// injection keep compiling. The setter is a no-op: the per-call materializer
// the handlers actually use cannot be substituted by a test-injected one, and
// a setter that "looks installed but isn't" is exactly the off-switch the
// removal paragraph above named. Tests that need a custom materializer must
// reach the fold seam directly; this symbol exists only to honor the
// previously-published module path.
export function configureWorkflowMaterializer(_materializer: unknown): void {
  // Intentionally empty — see the block comment above.
}

// Two handlers already lived in their own modules and were re-exported from
// here. They keep that arrangement — this file is the surface, wherever a
// handler's body happens to sit.
export { handleCancel } from './cancel.js';
export { handleSummary, handleReconcile, handleTransitions } from './query.js';
export { handleInit } from './handlers/init.js';
export { handleList } from './handlers/list.js';
export { handleGet } from './handlers/get.js';
export { handleSet } from './handlers/set.js';
export { handleUpdate, type UpdateInput } from './handlers/update.js';
export { handleTransition, type TransitionInput } from './handlers/transition.js';
export { handleCheckpoint, type HandleCheckpointOptions } from './handlers/checkpoint.js';
export { handleReconcileState } from './handlers/reconcile.js';
