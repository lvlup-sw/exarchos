// ─── IMPLEMENT-kind reachability (DR-4 / epic #1546, slice S2) ───────────────
//
// The heart of the phase-kind binding: verification is an obligation of the
// IMPLEMENT *kind*, not of the `delegate` phase name. These tests prove that
// every implement-kind phase across every workflow type resolves the SAME
// verification ladder as the canonical `delegate` boundary does — by
// construction, because `resolveGateSet` keys on `kind` alone.
//
// Before DR-4, only the `delegate` / `overhaul-delegate` phases had a per-task
// classification call site that stamped the ladder; the debug/hotfix/polish/
// oneshot implement phases surfaced verification only through playbook prose
// and so could not reach the integration-suite + boundary gates (#1537). The
// kind binding closes that gap: any phase whose `kind` is `'IMPLEMENT'` resolves
// the full ladder.

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
 * Narrow an HSM state to the atomic variant so its `kind` is accessible. Throws
 * (failing the test loudly) if the named state is missing or not atomic — both
 * would silently void the kind guarantee this suite exists to prove.
 */
function atomicState(hsm: HSMDefinition, id: string): Extract<State, { type: 'atomic' }> {
  const state = hsm.states[id];
  expect(state, `state '${id}' must exist in HSM '${hsm.id}'`).toBeDefined();
  expect(state?.type, `state '${id}' must be atomic`).toBe('atomic');
  // Narrowed by the assertion above; re-narrow for the type system.
  if (state === undefined || state.type !== 'atomic') {
    throw new Error(`state '${id}' is not an atomic state`);
  }
  return state;
}

describe('IMPLEMENT-kind reachability (DR-4)', () => {
  // The six implement-kind phases and the factory each is declared in. Only
  // IMPLEMENT phases belong here — every one must resolve the delegate ladder.
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
    // A representative medium / non-boundary context — the same profile the
    // delegate boundary resolves through `resolveGateSet('IMPLEMENT', …)`.
    const ctx: ResolveGateSetCtx = { riskTier: 'medium', boundaryTouching: false };
    const delegateLadder = resolveGateSet('IMPLEMENT', ctx);

    for (const { phase, hsm } of implementPhases) {
      const state = atomicState(hsm, phase);

      // First the kind itself — the binding surface.
      expect(state.kind, `${phase} kind`).toBe('IMPLEMENT');

      // Then the resolved sequence: keyed on the phase's own kind, it must match
      // the canonical delegate ladder cell-for-cell.
      expect(resolveGateSet(state.kind, ctx), `${phase} ladder`).toEqual(delegateLadder);
    }
  });

  it('ImplementPhases_HighTierBoundary_IncludesIntegrationAndBoundaryGates', () => {
    // The #1537 win: a high-risk, boundary-touching IMPLEMENT phase reaches the
    // integration-suite + boundary gates. Because every implement phase resolves
    // the IMPLEMENT kind, the debug/refactor implement phases now reach these
    // gates too — not just `delegate`.
    // DR-8: resolveGateSet now returns ResolvedGate[]; unwrap the ladder family
    // to the GateName sequence for the membership assertions.
    const ladder = ladderGateNames(
      resolveGateSet('IMPLEMENT', { riskTier: 'high', boundaryTouching: true }),
    );

    expect(ladder).toContain('check_integration_suite');
    expect(ladder).toContain('check_contract_drift');
    expect(ladder).toContain('check_mock_boundary');
  });
});
