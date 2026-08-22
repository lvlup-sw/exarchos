import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SPAWN_CAPABILITY,
  HOST_OBLIGATIONS,
  normalizeActionContract,
  type ActionContract,
  type HostObligation,
} from '../../../src/registry/action-contract.js';
import { cutoverActions } from '../../../src/registry/actions/orchestrate/cutover.js';
import { lifecycleOpsActions } from '../../../src/registry/actions/orchestrate/lifecycle-ops.js';
import { onboardingActions } from '../../../src/registry/actions/orchestrate/onboarding.js';
import { reviewOpsActions } from '../../../src/registry/actions/orchestrate/review-ops.js';
import type { BuiltinToolAction, ContractedToolAction } from '../../../src/registry/types.js';

const LIFECYCLE_REVIEW_ACTIONS: readonly BuiltinToolAction[] = [
  ...lifecycleOpsActions,
  ...reviewOpsActions,
  ...onboardingActions,
  ...cutoverActions,
];

function asContracted(action: BuiltinToolAction): ContractedToolAction {
  if (!('actionContract' in action) || action.actionContract === undefined) {
    throw new Error(`Action '${action.name}' is missing required actionContract`);
  }
  return action as ContractedToolAction;
}

function isHostObligation(value: string): value is HostObligation {
  return (HOST_OBLIGATIONS as readonly string[]).includes(value);
}

function replayAnnotationsOf(action: BuiltinToolAction): { readonly idempotent: boolean } {
  return { idempotent: action.annotations.idempotent };
}

describe('lifecycle and review action contracts', () => {
  it('Registry_LifecycleReviewActions_HaveCompleteContracts', () => {
    expect(LIFECYCLE_REVIEW_ACTIONS.length).toBeGreaterThan(0);
    for (const action of LIFECYCLE_REVIEW_ACTIONS) {
      const contracted = asContracted(action);
      const normalized = normalizeActionContract(contracted.actionContract, {
        annotations: replayAnnotationsOf(action),
      });
      expect(normalized).toEqual(contracted.actionContract);
      expect(normalized.requires.kind === 'declared' || normalized.requires.kind === 'none').toBe(true);
      expect(normalized.ensures.kind === 'declared' || normalized.ensures.kind === 'none').toBe(true);
      expect(normalized.needs.kind === 'declared' || normalized.needs.kind === 'none').toBe(true);
      expect(normalized.touches.frame).toBe('single-machine');
      expect(
        normalized.touches.resources.kind === 'declared' || normalized.touches.resources.kind === 'none',
      ).toBe(true);
      expect(normalized.replay.kind === 'safe-repeat'
        || normalized.replay.kind === 'claim-required'
        || normalized.replay.kind === 'reject-replay').toBe(true);
      expect(normalized.emissions.kind === 'declared' || normalized.emissions.kind === 'none').toBe(true);
      if (normalized.emissions.kind === 'declared') {
        for (const emission of normalized.emissions.values) {
          expect(emission.role === 'primary' || emission.role === 'recovery').toBe(true);
          expect(emission.owner.length).toBeGreaterThan(0);
          expect(emission.condition === 'always' || emission.condition === 'conditional').toBe(true);
        }
      }
      if (normalized.requires.kind === 'none') {
        expect(normalized.requires.because.trim().length).toBeGreaterThan(0);
      }
      if (normalized.ensures.kind === 'none') {
        expect(normalized.ensures.because.trim().length).toBeGreaterThan(0);
      }
      if (normalized.needs.kind === 'none') {
        expect(normalized.needs.because.trim().length).toBeGreaterThan(0);
      }
      if (normalized.emissions.kind === 'none') {
        expect(normalized.emissions.because.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('Registry_HostObligations_AreExplicit', () => {
    const hostActions = LIFECYCLE_REVIEW_ACTIONS
      .map(asContracted)
      .filter((action) => action.actionContract.executionAuthority.kind === 'host');
    expect(hostActions.length).toBeGreaterThan(0);
    for (const action of LIFECYCLE_REVIEW_ACTIONS.map(asContracted)) {
      const authority = action.actionContract.executionAuthority;
      if (authority.kind === 'local') {
        expect(authority).toEqual({ kind: 'local' });
        expect('obligation' in authority).toBe(false);
        continue;
      }
      expect(authority.kind).toBe('host');
      expect(isHostObligation(authority.obligation)).toBe(true);
      if (authority.obligation === 'agent-spawn') {
        expect(action.actionContract.needs.kind).toBe('declared');
        if (action.actionContract.needs.kind === 'declared') {
          expect(action.actionContract.needs.values).toContain(AGENT_SPAWN_CAPABILITY);
        }
      }
    }
  });

  it('host obligations and local authority are mutually exclusive', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LIFECYCLE_REVIEW_ACTIONS.map(asContracted)), (action) => {
        const authority = action.actionContract.executionAuthority;
        const local = authority.kind === 'local';
        const host = authority.kind === 'host';
        expect(local !== host).toBe(true);
        if (local) {
          expect('obligation' in authority).toBe(false);
        }
        if (host) {
          expect(isHostObligation(authority.obligation)).toBe(true);
        }
      }),
    );
  });

  it('normalized host-local mix is rejected', () => {
    const sample = asContracted(LIFECYCLE_REVIEW_ACTIONS[0]!);
    const mixed: ActionContract = {
      ...sample.actionContract,
      executionAuthority: { kind: 'local', obligation: 'human-approval' } as ActionContract['executionAuthority'],
    };
    expect(() => normalizeActionContract(mixed)).toThrow(/local action cannot also claim a host obligation/);
  });
});
