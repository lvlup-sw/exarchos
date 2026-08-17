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

export { configureWorkflowMaterializer, CURRENT_ES_VERSION, isEventSourced } from './handlers/shared.js';

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
