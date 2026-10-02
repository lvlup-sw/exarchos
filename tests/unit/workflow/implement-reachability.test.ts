/**
 * Tests that verification is an obligation of the IMPLEMENT kind, not of the `delegate` phase name.
 * `resolveGateSet` reads the kind and not the phase name.
 * So each IMPLEMENT phase of each workflow type resolves the same ladder as `delegate`.
 */

import { describe, it, expect } from 'vitest';
import { resolveGateSet, ladderGateNames, type ResolveGateSetCtx } from '../../../src/workflow/phase-kind.js';
import type { State, HSMDefinition } from '../../../src/workflow/state-machine.js';
import {
  createFeatureHSM,
  createDebugHSM,
  createOneshotHSM,
  createRefactorHSM,
} from '../../../src/workflow/hsm-definitions.js';

/**
 * Narrows an HSM state to the atomic variant so its `kind` is accessible.
 * It fails the test if the state is missing or not atomic, because either case voids the kind guarantee.
 */
function atomicState(hsm: HSMDefinition, id: string): Extract<State, { type: 'atomic' }> {
  const state = hsm.states[id];
  expect(state, `state '${id}' must exist in HSM '${hsm.id}'`).toBeDefined();
  expect(state?.type, `state '${id}' must be atomic`).toBe('atomic');
  if (state === undefined || state.type !== 'atomic') {
    throw new Error(`state '${id}' is not an atomic state`);
  }
  return state;
}

/** `implementPhases` holds the six IMPLEMENT phases and the HSM of each. Each one must resolve the ladder of `delegate`. */
describe('IMPLEMENT-kind reachability (DR-4)', () => {
  const implementPhases: ReadonlyArray<{
    readonly phase: string;
    readonly hsm: HSMDefinition;
  }> = [
    { phase: 'delegate', hsm: createFeatureHSM() },
    { phase: 'overhaul-delegate', hsm: createRefactorHSM() },
    { phase: 'debug-implement', hsm: createDebugHSM() },
    { phase: 'hotfix-implement', hsm: createDebugHSM() },
    { phase: 'polish-implement', hsm: createRefactorHSM() },
    { phase: 'implementing', hsm: createOneshotHSM() },
  ];

  it('ImplementPhases_AllResolveTheSameLadderAsDelegate', () => {
    const ctx: ResolveGateSetCtx = { riskTier: 'medium', boundaryTouching: false };
    const delegateLadder = resolveGateSet('IMPLEMENT', ctx);

    for (const { phase, hsm } of implementPhases) {
      const state = atomicState(hsm, phase);

      expect(state.kind, `${phase} kind`).toBe('IMPLEMENT');

      expect(resolveGateSet(state.kind, ctx), `${phase} ladder`).toEqual(delegateLadder);
    }
  });

  it('ImplementPhases_HighTierBoundary_IncludesIntegrationAndBoundaryGates', () => {
    const ladder = ladderGateNames(
      resolveGateSet('IMPLEMENT', { riskTier: 'high', boundaryTouching: true }),
    );

    expect(ladder).toContain('check_integration_suite');
    expect(ladder).toContain('check_contract_drift');
    expect(ladder).toContain('check_mock_boundary');
  });
});
