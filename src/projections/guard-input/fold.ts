/**
 * The ledger fold of the guard input.
 *
 * The fold is pure and synchronous over the migrated rows of one stream.
 * So a caller can fold the result of an event-store query or the rows of a settle snapshot.
 * No module of this directory imports `src/workflow/state-store.ts`.
 * That module reaches `resolveWorkflowState` through a dynamic import of the registry, so the import closes a runtime cycle.
 */
import type { WorkflowEvent } from '../../events/schemas.js';
import { workflowStateProjection, type WorkflowStateView } from '../views/workflow-state-projection.js';

/**
 * Folds the rows of one stream through `workflowStateProjection` in row order, from the initial view of the projection.
 * The fold changes no row, and the same rows give an equal view.
 */
export function foldWorkflowState(rows: readonly WorkflowEvent[]): WorkflowStateView {
  let view = workflowStateProjection.init();
  for (const row of rows) {
    view = workflowStateProjection.apply(view, row);
  }
  return view;
}
