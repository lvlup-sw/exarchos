// @oracle-sources: ../../src/events/registration-validate.ts, the per-action `emissions` clause each shipped contract carries — authored beside its action and never derived from the event catalog
//
// The two sides are independently authored on purpose. The event catalog says
// which `(action, event)` edges the registration validator can prove; the
// contracts say which ones their actions promise. Comparing a contract against
// a restatement of itself would agree by construction, so the catalog is what
// gives the comparison teeth.

import { describe, expect, it } from 'vitest';
import { collectReachabilityInputs } from '../../src/contract/reachability/collect.js';
import {
  declaredEmissions,
  effectPlanFromContract,
  records,
  recordsNothing,
  type EffectPlanInput,
} from '../../src/dispatch/core/effect-carrier.js';
import { verifierDeclaredEmissions } from '../../src/dispatch/core/interceptors/emission-verifier.js';
import { declaredEmissionEdges } from '../../src/events/registration-validate.js';
import {
  contractEmissionsOf,
  declared,
  none,
  type ActionContract,
  type ActionEmission,
} from '../../src/registry/action-contract.js';
import type { AutoEmission } from '../../src/registry/gate-metadata.js';
import type { BuiltinCompositeTool, CompositeTool } from '../../src/registry.js';

const REASONED_NONE = none('reasoned silence — sibling list must not fill this in');

function completeContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: REASONED_NONE,
    ensures: REASONED_NONE,
    needs: REASONED_NONE,
    touches: { frame: 'single-machine', resources: REASONED_NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: REASONED_NONE,
    ...overrides,
  };
}

const SIBLING_GATE: AutoEmission = {
  event: 'gate.executed',
  condition: 'always',
  owner: 'sibling',
  role: 'primary',
};

const NESTED_STARTED: ActionEmission = {
  event: 'workflow.started',
  condition: 'always',
  owner: 'workflow',
  role: 'primary',
};

const PLAN_FIELDS: EffectPlanInput = {
  effectClass: 'filesystem',
  owner: 'effect-owner',
  description: 'emission-authority probe',
  emits: records({ event: 'gate.executed', when: 'on-success', owner: 'sibling', role: 'recovery' }),
};

function probeRegistry(emissions: ActionContract['emissions']): readonly CompositeTool[] {
  return [
    {
      name: 'exarchos_probe',
      description: 'emission-authority probe',
      actions: [
        {
          name: 'run',
          description: 'Run the probe',
          schema: {} as never,
          phases: new Set<string>(),
          roles: new Set<string>(),
          outputSchema: {} as never,
          annotations: {
            safety: 'local-mutation',
            readOnly: false,
            destructive: false,
            idempotent: true,
            openWorld: false,
          },
          autoEmits: [SIBLING_GATE],
          actionContract: completeContract({ emissions }),
        },
      ],
    },
  ];
}

describe('action-contract emission authority', () => {
  it('Registry_TopLevelAutoEmits_IsNotAuthoritative', () => {
    const silent = probeRegistry(REASONED_NONE);
    expect(contractEmissionsOf(silent[0]!.actions[0]!)).toEqual([]);
    expect(declaredEmissionEdges(silent)).toEqual([]);

    const nested = probeRegistry(declared(NESTED_STARTED));
    const edges = declaredEmissionEdges(nested);
    expect(edges.map((edge) => edge.event)).toEqual(['workflow.started']);
    expect(edges.some((edge) => edge.event === 'gate.executed')).toBe(false);
    expect(contractEmissionsOf(nested[0]!.actions[0]!)).toEqual([NESTED_STARTED]);

    const read = verifierDeclaredEmissions as (
      contract: Pick<ActionContract, 'emissions'> | undefined,
      siblingAutoEmits?: readonly AutoEmission[],
    ) => readonly AutoEmission[] | undefined;
    expect(read(completeContract({ emissions: REASONED_NONE }), [SIBLING_GATE])).toBeUndefined();
    expect(read(undefined, [SIBLING_GATE])).toBeUndefined();
    expect(read(completeContract({ emissions: declared(NESTED_STARTED) }), [SIBLING_GATE])).toEqual([
      NESTED_STARTED,
    ]);
  });

  it('EffectPlanEmits_DerivesFromActionContract', () => {
    const plan = effectPlanFromContract(PLAN_FIELDS, {
      replay: { kind: 'safe-repeat' },
      emissions: declared(NESTED_STARTED),
    });
    expect(declaredEmissions(plan).map((emission) => emission.event)).toEqual(['workflow.started']);
    expect(declaredEmissions(plan).some((emission) => emission.event === 'gate.executed')).toBe(
      false,
    );
  });

  it('EffectPlanWhen_StaysPerEffect', () => {
    const plan = effectPlanFromContract(
      {
        ...PLAN_FIELDS,
        emits: records({ event: 'workflow.started', when: 'before' }),
      },
      {
        replay: { kind: 'safe-repeat' },
        emissions: declared({
          ...NESTED_STARTED,
          condition: 'always',
        }),
      },
    );
    expect(declaredEmissions(plan)).toEqual([
      { event: 'workflow.started', when: 'before', owner: 'workflow', role: 'primary' },
    ]);
    expect(declaredEmissions(plan)[0]?.when).not.toBe(NESTED_STARTED.condition);
  });

  it('EmissionOwners_DeriveFromActionContract', () => {
    const plan = effectPlanFromContract(PLAN_FIELDS, {
      replay: { kind: 'safe-repeat' },
      emissions: declared(NESTED_STARTED),
    });
    expect(declaredEmissions(plan)).toEqual([
      { event: 'workflow.started', when: 'on-success', owner: 'workflow', role: 'primary' },
    ]);
    expect(plan.owner).toBe('effect-owner');
    expect(declaredEmissions(plan)[0]?.owner).not.toBe('sibling');
    expect(declaredEmissions(plan)[0]?.role).not.toBe('recovery');
  });

  it('Reachability_EventHop_UsesNestedEmissions', () => {
    const registry = [
      {
        name: 'exarchos_probe',
        description: 'emission-authority probe',
        actions: [
          {
            name: 'run',
            autoEmits: [SIBLING_GATE],
            actionContract: completeContract({ emissions: declared(NESTED_STARTED) }),
          },
          {
            name: 'silent',
            autoEmits: [SIBLING_GATE],
            actionContract: completeContract({ emissions: REASONED_NONE }),
          },
        ],
      },
    ] as unknown as readonly BuiltinCompositeTool[];

    const inputs = collectReachabilityInputs({ registry });
    const probe = inputs.emissions.filter((row) => row.actionId.startsWith('exarchos_probe.'));
    expect(probe).toEqual([
      { actionId: 'exarchos_probe.run', event: 'workflow.started', registered: true },
    ]);
    expect(probe.some((row) => row.event === SIBLING_GATE.event)).toBe(false);
    expect(probe.some((row) => row.actionId === 'exarchos_probe.silent')).toBe(false);
  });

  it('reasoned none is not filled from sibling records on the plan', () => {
    const plan = effectPlanFromContract(PLAN_FIELDS, {
      replay: { kind: 'safe-repeat' },
      emissions: REASONED_NONE,
    });
    expect(plan.emits).toEqual(recordsNothing(REASONED_NONE.because));
  });
});
