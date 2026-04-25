/**
 * `next-action@v1` projection reducer (T060, DR-16, DR-17).
 *
 * Wraps T040's pure {@link computeNextActions} as a registered
 * {@link ProjectionReducer} so the projection registry (DR-1) becomes the
 * single source of truth for projection identity and versioning — matching
 * the architectural principle DR-17 enshrines for *all* future projections.
 *
 * ## State-derived, not event-folded
 *
 * Most projections in this system (e.g. `rehydration@v1`) compute their
 * `State` by folding the event stream: `apply(state, event) => nextState`.
 * `next-action`, by contrast, is a pure function of the **current**
 * `WorkflowState` + HSM topology — neither of which is an `event`. The
 * outbound transitions from the current phase are all that matter.
 *
 * To reconcile that with the `ProjectionReducer<S, E>` contract, this reducer
 * ships:
 *
 *   1. `apply: (state, event) => state` — the identity function. Events never
 *      change the projected value; the registry / runner should never replay
 *      this reducer over an event stream expecting a fold.
 *   2. `derive(state, hsm) => NextAction[]` — the actual computation,
 *      delegating to T040's {@link computeNextActions}. This is the intended
 *      entry point for envelope builders (see DR-8's `next_actions` field).
 *
 * Keeping `apply` as identity is the deliberate choice flagged in T060's
 * task spec: it preserves the `ProjectionReducer` shape (so `defaultRegistry`
 * treats this projection uniformly with event-folded ones) without lying
 * about where the state comes from.
 *
 * ## Registration
 *
 * Registration with {@link defaultRegistry} is performed by the sibling
 * `index.ts` barrel, not here — the reducer module stays a pure value to
 * make tests that construct their own registries straightforward.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { HSMDefinition } from '../../workflow/state-machine.js';
import type { NextAction } from '../../next-action.js';
import { computeNextActions } from '../../next-actions-computer.js';

/**
 * The projected value for `next-action@v1` is a list of suggested next
 * actions (DR-8). The initial value is empty — a workflow with no known
 * phase has no suggested transitions.
 */
export type NextActionState = NextAction[];

/**
 * Shape of the workflow-state subset this reducer's {@link derive} inspects.
 *
 * Intentionally loose — `computeNextActions` only reads `phase` and
 * `workflowType`, and any additional fields on the caller's state object are
 * simply ignored. Keeping the type structural avoids coupling this module to
 * the full {@link import('../../workflow/types.js').WorkflowState} shape.
 */
export interface NextActionDerivationState {
  readonly phase?: string;
  readonly workflowType?: string;
}

/**
 * Extended reducer interface — adds the state-derived `derive()` method on
 * top of the standard `ProjectionReducer<NextAction[], WorkflowEvent>`
 * contract. Callers that only need the reducer's `id` / `version` / `initial`
 * / `apply` surface can treat this as a plain `ProjectionReducer`.
 */
export interface NextActionReducer
  extends ProjectionReducer<NextActionState, WorkflowEvent> {
  /**
   * Derive the set of valid next actions from the current workflow state +
   * HSM topology. This is the state-derived equivalent of `apply` for this
   * projection; see module docstring for why `apply` is identity.
   *
   * Delegates to T040's {@link computeNextActions} so any future changes to
   * next-action semantics are made in exactly one place.
   */
  derive(state: NextActionDerivationState, hsm: HSMDefinition): NextActionState;
}

/**
 * Concrete `next-action@v1` reducer value. Registered with `defaultRegistry`
 * by `./index.ts` at module-import time (DR-1 convention).
 */
export const nextActionReducer: NextActionReducer = {
  id: 'next-action@v1',
  version: 1,
  initial: [],
  // `apply` is the identity function — this projection is state-derived, not
  // event-folded. See the module docstring for the rationale. Using a tight
  // `return state` (no spread / no copy) preserves reference identity, which
  // some downstream consumers rely on for structural-sharing change checks.
  apply(state: NextActionState, _event: WorkflowEvent): NextActionState {
    return state;
  },
  derive(state: NextActionDerivationState, hsm: HSMDefinition): NextActionState {
    return computeNextActions(state, hsm);
  },
};
