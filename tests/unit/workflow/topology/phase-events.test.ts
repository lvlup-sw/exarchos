// The phase event contract: its load-time refusals, proven on seeded rows
// through the real functions; its derivations; and the fact that every event
// it expects can be folded by the projections that will see it.

import { describe, it, expect } from 'vitest';
import {
  PHASE_EVENT_CONTRACTS,
  assertContractPhasesAreRegistered,
  assertPhaseEventContracts,
  expectedEventsByPhase,
  hintDescriptions,
  eventInstructionsFor,
  runtimeEmissionsFor,
  type PhaseEventContractOf,
} from '../../../../src/workflow/topology/phase-events.js';
import { EVENT_DATA_SCHEMAS, EVENT_EMISSION_REGISTRY } from '../../../../src/events/schemas.js';
import { buildEvent } from '../../../../src/events/event-factory.js';
import { rehydrationReducer } from '../../../../src/projections/rehydration/reducer.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import {
  createDebugHSM,
  createDiscoveryHSM,
  createFeatureHSM,
  createOneshotHSM,
  createRefactorHSM,
} from '../../../../src/workflow/hsm-definitions.js';
import { sampleEventData } from '../../../../tools/test-helpers/event-payload-sample.js';

const LIVE_REGISTRY: ReadonlyMap<string, string> = new Map(Object.entries(EVENT_EMISSION_REGISTRY));

const SEEDED_REGISTRY: ReadonlyMap<string, string> = new Map([
  ['seeded.model', 'model'],
  ['seeded.other-model', 'model'],
  ['seeded.auto', 'auto'],
  ['seeded.retired', 'retired'],
]);

const BUILT_IN_PHASES: ReadonlySet<string> = new Set(
  [createFeatureHSM(), createDebugHSM(), createRefactorHSM(), createOneshotHSM(), createDiscoveryHSM()]
    .flatMap((hsm) => Object.keys(hsm.states)),
);

function contract(partial: Partial<PhaseEventContractOf<string>>): PhaseEventContractOf<string> {
  return { expects: [], runtimeEmits: [], ...partial };
}

describe('PHASE_EVENT_CONTRACTS — the live table', () => {
  it('PhaseEventContracts_Live_PassEventAndPhaseRefusals', () => {
    expect(Object.keys(PHASE_EVENT_CONTRACTS).length).toBeGreaterThan(0);
    expect(() => assertPhaseEventContracts(PHASE_EVENT_CONTRACTS, LIVE_REGISTRY)).not.toThrow();
    expect(() =>
      assertContractPhasesAreRegistered(PHASE_EVENT_CONTRACTS, BUILT_IN_PHASES),
    ).not.toThrow();
  });

  it('PhaseEventContracts_Live_ExpectsOnlyModelEventsAndDisclosesOnlyAutoEvents', () => {
    const expects = Object.values(PHASE_EVENT_CONTRACTS).flatMap((c) => c.expects);
    const discloses = Object.values(PHASE_EVENT_CONTRACTS).flatMap((c) => c.runtimeEmits);
    expect(expects.length).toBeGreaterThan(0);
    expect(discloses.length).toBeGreaterThan(0);
    expect(expects.filter((row) => LIVE_REGISTRY.get(row.type) !== 'model')).toEqual([]);
    expect(discloses.filter((row) => LIVE_REGISTRY.get(row.type) !== 'auto')).toEqual([]);
  });

  it('PhaseEventContracts_Live_EveryKeyIsABuiltInHsmState', () => {
    expect(BUILT_IN_PHASES.size).toBeGreaterThan(10);
    expect(Object.keys(PHASE_EVENT_CONTRACTS).filter((phase) => !BUILT_IN_PHASES.has(phase))).toEqual(
      [],
    );
  });
});

describe('assertPhaseEventContracts — seeded refusals', () => {
  it('Refuses_ARowThatDeclaresNothing', () => {
    expect(() => assertPhaseEventContracts({ seeded: contract({}) }, SEEDED_REGISTRY)).toThrow(
      /PHASE_EVENT_CONTRACTS\['seeded'\] declares nothing/,
    );
  });

  it('Refuses_AnExpectationOfAnAutoRetiredOrUnregisteredEvent', () => {
    const expecting = (type: string): Record<string, PhaseEventContractOf<string>> => ({
      seeded: contract({ expects: [{ type: type, when: 'seeded' }] }),
    });
    expect(() => assertPhaseEventContracts(expecting('seeded.auto'), SEEDED_REGISTRY)).toThrow(
      /expects 'seeded\.auto', whose emission source is 'auto'/,
    );
    expect(() => assertPhaseEventContracts(expecting('seeded.retired'), SEEDED_REGISTRY)).toThrow(
      /expects 'seeded\.retired', which is retired/,
    );
    expect(() => assertPhaseEventContracts(expecting('seeded.typo'), SEEDED_REGISTRY)).toThrow(
      /expects 'seeded\.typo', which is not registered/,
    );
    expect(() => assertPhaseEventContracts(expecting('seeded.model'), SEEDED_REGISTRY)).not.toThrow();
  });

  it('Refuses_ADisclosureOfANonAutoEvent', () => {
    const disclosing = (type: string): Record<string, PhaseEventContractOf<string>> => ({
      seeded: contract({
        runtimeEmits: [{ type: type, when: 'seeded', emittedBy: 'seeded' }],
      }),
    });
    expect(() => assertPhaseEventContracts(disclosing('seeded.model'), SEEDED_REGISTRY)).toThrow(
      /discloses 'seeded\.model' as runtime-emitted, but its emission source is 'model'/,
    );
    expect(() => assertPhaseEventContracts(disclosing('seeded.gone'), SEEDED_REGISTRY)).toThrow(
      /discloses 'seeded\.gone' as runtime-emitted, but its emission source is unregistered/,
    );
    expect(() => assertPhaseEventContracts(disclosing('seeded.auto'), SEEDED_REGISTRY)).not.toThrow();
  });

  it('Refuses_ATypeListedTwiceInOnePhase', () => {
    expect(() =>
      assertPhaseEventContracts(
        {
          seeded: contract({
            expects: [{ type: 'seeded.model', when: 'once' }],
            runtimeEmits: [{ type: 'seeded.model', when: 'twice', emittedBy: 'seeded' }],
          }),
        },
        SEEDED_REGISTRY,
      ),
    ).toThrow(/lists 'seeded\.model' twice/);
  });

  it('Refuses_APhaseNoBuiltInHsmRegisters', () => {
    expect(() =>
      assertContractPhasesAreRegistered(
        { ...PHASE_EVENT_CONTRACTS, 'seeded-phase': contract({ expects: [] }) },
        BUILT_IN_PHASES,
      ),
    ).toThrow(/names 1 phase\(s\) no built-in HSM registers: seeded-phase/);
  });
});

describe('derivations', () => {
  const SEEDED: Readonly<Record<string, PhaseEventContractOf<string>>> = {
    first: contract({
      expects: [
        { type: 'seeded.other-model', when: 'Second in the alphabet, first in order' },
        { type: 'seeded.model', when: 'After the other one', fields: ['a', 'b'] },
      ],
      runtimeEmits: [{ type: 'seeded.auto', when: 'Whenever', emittedBy: 'seeded runtime' }],
    }),
    'runtime-only': contract({
      runtimeEmits: [{ type: 'seeded.auto', when: 'Whenever', emittedBy: 'seeded runtime' }],
    }),
  };

  it('ExpectedEventsByPhase_KeepsOrderAndDropsPhasesExpectingNothing', () => {
    expect(expectedEventsByPhase(SEEDED)).toEqual({
      first: ['seeded.other-model', 'seeded.model'],
    });
  });

  it('HintDescriptions_TotalOverExpectedTypesAndPhrasedFromWhen', () => {
    expect(hintDescriptions(SEEDED)).toEqual({
      'seeded.other-model':
        'Emit seeded.other-model via exarchos_event — second in the alphabet, first in order',
      'seeded.model': 'Emit seeded.model via exarchos_event — after the other one',
    });
  });

  it('EventInstructionsFor_ReturnFreshCopies', () => {
    const first = eventInstructionsFor(SEEDED, 'first');
    expect(first.map((row) => row.type)).toEqual(['seeded.other-model', 'seeded.model']);
    first[1]?.fields?.push('seeded-mutation');
    expect(eventInstructionsFor(SEEDED, 'first')[1]?.fields).toEqual(['a', 'b']);
    expect(eventInstructionsFor(SEEDED, 'runtime-only')).toEqual([]);
    expect(eventInstructionsFor(SEEDED, 'absent')).toEqual([]);
  });

  it('RuntimeEmissionsFor_DiscloseAutoRowsOrNothing', () => {
    expect(runtimeEmissionsFor(SEEDED, 'first')).toEqual([
      { type: 'seeded.auto', source: 'auto', when: 'Whenever', emittedBy: 'seeded runtime' },
    ]);
    expect(runtimeEmissionsFor(SEEDED, 'absent')).toBeUndefined();
  });
});

describe('every expected event folds', () => {
  it('PhaseEventContracts_EveryExpectedEvent_FoldsThroughTheReducerAndTheCanonicalProjection', () => {
    // The gate demands these of the model, so the projections that read the
    // stream must at least accept them: a throw here would surface as a
    // rehydrate failure the moment the model did what the hint asked.
    const expected = [...new Set(Object.values(PHASE_EVENT_CONTRACTS).flatMap((c) => c.expects))];
    expect(expected.length).toBeGreaterThan(0);
    let reducerState = rehydrationReducer.initial;
    let viewState = workflowStateProjection.init();
    expected.forEach((row, index) => {
      const event = buildEvent('feat-phase-events', index + 1, {
        type: row.type,
        data: sampleEventData(EVENT_DATA_SCHEMAS[row.type]) ?? {},
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      reducerState = rehydrationReducer.apply(reducerState, event);
      viewState = workflowStateProjection.apply(viewState, event);
    });
    expect(reducerState).toBeDefined();
    expect(viewState).toBeDefined();
  });
});
