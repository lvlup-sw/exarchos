import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  normalizeActionContract,
  type ActionContract,
  type ActionPostcondition,
} from '../../../src/registry/action-contract.js';
import { coordinationActions } from '../../../src/registry/actions/orchestrate/coordination.js';
import { gateActions } from '../../../src/registry/actions/orchestrate/gates.js';
import { invariantActions } from '../../../src/registry/actions/orchestrate/invariants.js';
import { verificationActions } from '../../../src/registry/actions/orchestrate/verification.js';
import { CAPABILITY_KEYS, type Capability } from '../../../src/runtime/agents/capabilities.js';

const FAMILY = [...coordinationActions, ...gateActions, ...verificationActions, ...invariantActions];

type ContractedAction = (typeof FAMILY)[number] & {
  readonly actionContract: ActionContract;
  readonly annotations: { readonly idempotent: boolean };
};

function isContracted(action: (typeof FAMILY)[number]): action is ContractedAction {
  return 'actionContract' in action && action.actionContract !== undefined;
}

function contractOf(action: (typeof FAMILY)[number]): ActionContract {
  expect(isContracted(action), `${action.name} must declare actionContract`).toBe(true);
  if (!isContracted(action)) {
    throw new Error(`${action.name} is missing actionContract`);
  }
  return action.actionContract;
}

function gateFamily(): ContractedAction[] {
  return FAMILY.filter((action): action is ContractedAction => isContracted(action) && action.gate !== undefined);
}

function assertCompleteContract(action: (typeof FAMILY)[number]): ActionContract {
  const contract = contractOf(action);
  const normalized = normalizeActionContract(contract, { annotations: action.annotations });
  expect(normalized, action.name).toEqual(contract);
  expect(contract.requires, action.name).toBeDefined();
  expect(contract.ensures, action.name).toBeDefined();
  expect(contract.needs, action.name).toBeDefined();
  expect(contract.touches.frame, action.name).toBe('single-machine');
  expect(contract.executionAuthority.kind === 'local' || contract.executionAuthority.kind === 'host', action.name).toBe(true);
  if (contract.executionAuthority.kind === 'local') {
    expect('obligation' in contract.executionAuthority, action.name).toBe(false);
  }
  expect(contract.replay.kind, action.name).toMatch(/^(safe-repeat|claim-required|reject-replay)$/);
  if (contract.requires.kind === 'none') {
    expect(contract.requires.because.trim().length, action.name).toBeGreaterThan(0);
  }
  if (contract.ensures.kind === 'none') {
    expect(contract.ensures.because.trim().length, action.name).toBeGreaterThan(0);
  }
  if (contract.needs.kind === 'none') {
    expect(contract.needs.because.trim().length, action.name).toBeGreaterThan(0);
  } else {
    for (const capability of contract.needs.values) {
      expect(CAPABILITY_KEYS.has(capability), `${action.name} needs ${capability}`).toBe(true);
    }
  }
  if (contract.emissions.kind === 'none') {
    expect(contract.emissions.because.trim().length, action.name).toBeGreaterThan(0);
  } else {
    for (const emission of contract.emissions.values) {
      expect(emission.owner.trim().length, action.name).toBeGreaterThan(0);
      expect(emission.role === 'primary' || emission.role === 'recovery', action.name).toBe(true);
    }
  }
  if (action.annotations.idempotent) {
    expect(contract.replay.kind, action.name).toBe('safe-repeat');
  } else {
    expect(contract.replay.kind, action.name).not.toBe('safe-repeat');
  }
  return contract;
}

function assertDurableGateEnsures(ensures: ActionContract['ensures'], actionName: string): void {
  expect(ensures.kind, actionName).toBe('declared');
  if (ensures.kind !== 'declared') {
    throw new Error(`${actionName} gate ensures must be declared`);
  }
  expect(
    ensures.values.some((postcondition) => postcondition.source === 'durable-evidence'),
    actionName,
  ).toBe(true);
  for (const postcondition of ensures.values) {
    expect(['durable-evidence', 'event-append'], actionName).toContain(postcondition.source);
    expect(['success', 'failure', 'always'], actionName).toContain(postcondition.when);
  }
}

describe('coordination, gate, and verification action contracts', () => {
  it('Registry_CoordinationGateActions_HaveCompleteContracts', () => {
    expect(FAMILY.length).toBeGreaterThan(0);
    for (const action of FAMILY) {
      assertCompleteContract(action);
    }
  });

  it('Registry_GateEnsures_NameDurableEvidence', () => {
    const gates = gateFamily();
    expect(gates.length).toBeGreaterThan(0);
    for (const action of gates) {
      assertDurableGateEnsures(action.actionContract.ensures, action.name);
    }
  });
});

describe('coordination and gate contract properties', () => {
  it('gate ensures resolve to durable evidence', () => {
    const gates = gateFamily();
    fc.assert(
      fc.property(fc.constantFrom(...gates), (action) => {
        const ensures = action.actionContract.ensures;
        expect(ensures.kind).toBe('declared');
        if (ensures.kind !== 'declared') {
          return;
        }
        const evidence = ensures.values.filter(
          (postcondition): postcondition is Extract<ActionPostcondition, { source: 'durable-evidence' }> =>
            postcondition.source === 'durable-evidence',
        );
        expect(evidence.length).toBeGreaterThan(0);
        for (const postcondition of evidence) {
          expect(postcondition.evidenceType.trim().length).toBeGreaterThan(0);
          expect(['success', 'failure', 'always']).toContain(postcondition.when);
        }
      }),
    );
  });

  it('capabilities are canonical', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FAMILY), (action) => {
        const needs = contractOf(action).needs;
        if (needs.kind !== 'declared') {
          expect(needs.because.trim().length).toBeGreaterThan(0);
          return;
        }
        for (const capability of needs.values) {
          expect(CAPABILITY_KEYS.has(capability as Capability)).toBe(true);
        }
      }),
    );
  });
});
