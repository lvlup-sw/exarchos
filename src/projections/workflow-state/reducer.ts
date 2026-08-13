/**
 * `workflow-state@v1` canonical reducer — Wave 3 / #1554 (DR-1).
 *
 * Promotes the existing {@link workflowStateProjection} (a `ViewProjection`
 * living in `projections/views/workflow-state-projection.ts`, already the materializer's
 * workflow-state fold) to a registered {@link ProjectionReducer}. This is the
 * **single canonical left-fold** that derives a feature's `WorkflowStateView`
 * from its event stream (INV-1: one left-fold). Every reader — `resolveWorkflowState`,
 * rehydration, the views surface — folds through this reducer rather than
 * maintaining a parallel hand-written fold.
 *
 * ## Bridge: `ViewProjection` ↔ `ProjectionReducer`
 *
 * The two contracts are structurally the same fold (`init`/`initial` seed +
 * pure `apply`). The bridge is intentionally thin — it adds the registry
 * identity (`id`/`version`/`scope`) and delegates the fold to the existing
 * projection so there is exactly ONE `switch (event.type)` over `WorkflowEvent`
 * producing a `WorkflowStateView` (enforced by the single-fold CI gate, #1554-4).
 *
 * `initial` is captured once from `workflowStateProjection.init()`. This is
 * safe because `apply` is pure (DR-1) and never mutates the `state` argument,
 * so a shared seed cannot leak across folds. The `ViewMaterializer` continues
 * to call `init()` directly for its per-stream caches; this reducer is the seam
 * the projection-registry runners and the per-stream `decide`/`aggregateStream`
 * primitives resolve by id.
 *
 * @see docs/designs/archive/2026-06-20-w3-event-sourcing-read-path.md §3.3
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import {
  workflowStateProjection,
  type WorkflowStateView,
} from '../views/workflow-state-projection.js';

export const workflowStateReducer: ProjectionReducer<WorkflowStateView, WorkflowEvent> = {
  id: 'workflow-state@v1',
  version: 1,
  // Per-feature workflow stream — consumed by the per-stream primitives
  // (`decide` / `aggregateStream`). Scope must match the state's key space;
  // see `projections/types.ts` for the rule and its exact guarantee.
  scope: 'stream' as const,
  initial: workflowStateProjection.init(),
  apply(state: WorkflowStateView, event: WorkflowEvent): WorkflowStateView {
    return workflowStateProjection.apply(state, event);
  },
};
