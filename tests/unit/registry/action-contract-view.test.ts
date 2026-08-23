import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  normalizeActionContract,
  type ActionContract,
  type DeclaredSet,
} from '../../../src/registry/action-contract.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';

function viewActions() {
  const tool = TOOL_REGISTRY.find((entry) => entry.name === 'exarchos_view');
  expect(tool).toBeDefined();
  return tool!.actions;
}

function contractOf(action: {
  name: string;
  annotations: { readonly idempotent: boolean };
}): ActionContract {
  expect('actionContract' in action, `exarchos_view.${action.name} is missing actionContract`).toBe(true);
  return normalizeActionContract(Reflect.get(action, 'actionContract'), {
    annotations: action.annotations,
  });
}

function noneReason(set: DeclaredSet<unknown>): string {
  expect(set.kind).toBe('none');
  if (set.kind !== 'none') {
    throw new Error('expected reasoned none');
  }
  return set.because;
}

describe('view action contracts', () => {
  it('Registry_ViewActions_HaveCompleteContracts', () => {
    const actions = viewActions();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const contract = contractOf(action);
      expect(contract.touches.frame).toBe('single-machine');
      expect(contract.executionAuthority.kind === 'local' || contract.executionAuthority.kind === 'host').toBe(true);
      if (contract.executionAuthority.kind === 'local') {
        expect(contract.executionAuthority).toEqual({ kind: 'local' });
      }
      expect(normalizeActionContract(contract, { annotations: action.annotations })).toEqual(contract);
      if (action.annotations.idempotent) {
        expect(contract.replay.kind).toBe('safe-repeat');
      } else {
        expect(contract.replay.kind).not.toBe('safe-repeat');
      }
      if (contract.emissions.kind === 'declared') {
        for (const emission of contract.emissions.values) {
          expect(emission.owner.trim().length).toBeGreaterThan(0);
          expect(emission.role === 'primary' || emission.role === 'recovery').toBe(true);
        }
      }
    }
    const exportAction = actions.find((action) => action.name === 'export');
    expect(exportAction).toBeDefined();
    const exportContract = contractOf(exportAction!);
    expect(exportContract.emissions.kind).toBe('declared');
    if (exportContract.emissions.kind === 'declared') {
      expect(exportContract.emissions.values.map((emission) => emission.event)).toEqual(
        expect.arrayContaining(['export.requested', 'export.executed']),
      );
    }
  });

  it('Registry_ReadOnlyViews_DeclareReasonedNoEmissions', () => {
    const readOnly = viewActions().filter((action) => action.annotations.readOnly);
    expect(readOnly.length).toBeGreaterThan(0);
    for (const action of readOnly) {
      const contract = contractOf(action);
      expect(noneReason(contract.emissions).trim().length).toBeGreaterThan(0);
      expect(noneReason(contract.ensures).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('view action contract properties', () => {
  it('read-only abstentions are explicit and non-blank', () => {
    const readOnly = viewActions().filter((action) => action.annotations.readOnly);
    expect(readOnly.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...readOnly), (action) => {
        const contract = contractOf(action);
        const abstentions: DeclaredSet<unknown>[] = [
          contract.requires,
          contract.ensures,
          contract.needs,
          contract.touches.resources,
          contract.emissions,
        ];
        for (const set of abstentions) {
          if (set.kind === 'none') {
            expect(set.because.trim().length).toBeGreaterThan(0);
          }
        }
      }),
    );
  });
});
