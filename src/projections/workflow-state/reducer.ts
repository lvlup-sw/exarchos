/**
 * `workflow-state@v1` reducer: the registered {@link ProjectionReducer} form of {@link workflowStateProjection}.
 * It adds the registry identity (`id`, `version`, `scope`) and delegates each fold to that projection.
 * Thus one `switch (event.type)` produces a `WorkflowStateView`. The single-workflow-fold CI gate enforces this.
 * `initial` comes from one call of `workflowStateProjection.init()`. A shared seed is safe because `apply` does not mutate its `state` argument.
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
  /** The state belongs to one feature stream, so the scope is `stream`. `projections/types.ts` gives the rule. */
  scope: 'stream' as const,
  initial: workflowStateProjection.init(),
  apply(state: WorkflowStateView, event: WorkflowEvent): WorkflowStateView {
    return workflowStateProjection.apply(state, event);
  },
};
