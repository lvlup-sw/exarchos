/**
 * The `next-action@v1` projection reducer. It wraps {@link computeNextActions} as a registered
 * {@link ProjectionReducer}, so the projection registry owns the identity and version of this projection.
 *
 * The projection comes from state and not from a fold of events. It is a pure function of the current
 * `WorkflowState` and the HSM topology. Thus `apply` is the identity function, and `derive` does the work.
 * The identity `apply` keeps the `ProjectionReducer` shape, so `defaultRegistry` treats this projection
 * like the event-folded ones.
 *
 * The sibling `index.ts` barrel registers the reducer. This module stays a pure value for tests that
 * build their own registries.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import type { HSMDefinition } from '../../workflow/state-machine.js';
import type { NextAction, RegistryAdvertisement } from '../../next-action.js';
import {
  computeNextActions,
  computeRegistryAdvertisements,
  type ActionAdmissionFacts,
} from '../../next-actions-computer.js';

/**
 * The suggested next actions. The initial value is empty, because a workflow
 * with no known phase has no suggested transitions.
 */
export type NextActionState = NextAction[];

/**
 * The subset of workflow state that `derive` and `deriveAdvertised` read.
 * The type is structural, so this module does not depend on the full `WorkflowState` shape.
 */
export interface NextActionDerivationState {
  readonly phase?: string;
  readonly workflowType?: string;
  readonly featureId?: string;
  readonly actionAdmission?: ActionAdmissionFacts;
}

/**
 * A `ProjectionReducer` with the state-derived `derive` and `deriveAdvertised` methods.
 * A caller that needs only `id`, `version`, `initial`, and `apply` can use it as a plain `ProjectionReducer`.
 */
export interface NextActionReducer
  extends ProjectionReducer<NextActionState, WorkflowEvent> {
  /**
   * Derives the valid next actions from the current workflow state and the HSM topology.
   * It is the state-derived equivalent of `apply`, and it delegates to {@link computeNextActions}.
   */
  derive(state: NextActionDerivationState, hsm: HSMDefinition): NextActionState;
  /**
   * Allow-only registry ActionIds for the same workflow-scoped inputs.
   * Distinct from {@link derive}: phase and control verbs stay on the HSM
   * envelope and are never ActionIds.
   */
  deriveAdvertised(state: NextActionDerivationState): readonly RegistryAdvertisement[];
}

/** The `next-action@v1` reducer. `./index.ts` registers it with `defaultRegistry` at module load. */
export const nextActionReducer: NextActionReducer = {
  id: 'next-action@v1',
  version: 1,
  scope: 'stream' as const,
  initial: [],
  /** The identity function. It returns `state` without a copy, so the reference stays the same. */
  apply(state: NextActionState, _event: WorkflowEvent): NextActionState {
    return state;
  },
  derive(state: NextActionDerivationState, hsm: HSMDefinition): NextActionState {
    return computeNextActions(state, hsm);
  },
  deriveAdvertised(state: NextActionDerivationState): readonly RegistryAdvertisement[] {
    return computeRegistryAdvertisements(state);
  },
};
