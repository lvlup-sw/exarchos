// Every surface that used to hold its own copy of the phase event facts is a
// projection of `PHASE_EVENT_CONTRACTS` now. This suite reads each one back
// and compares it to the contract, for every phase, in both directions — the
// successor to the four delegate-only equalities the old reducer-contract test
// asserted against a two-case switch that called itself a registry.

import { describe, it, expect } from 'vitest';
import { PHASE_EVENT_CONTRACTS } from '../../../../src/workflow/topology/phase-events.js';
import {
  EVENT_DESCRIPTIONS,
  PHASE_EXPECTED_EVENTS,
} from '../../../../src/verbs/gates/check-event-emissions.js';
import { serializePlaybooks, workflowPlaybooks } from '../../../../src/workflow/playbooks.js';
import { EVENT_EMISSION_REGISTRY } from '../../../../src/events/schemas.js';

const REGISTRY: ReadonlyMap<string, string> = new Map(Object.entries(EVENT_EMISSION_REGISTRY));

function expectedTypes(phase: string): readonly string[] {
  return (PHASE_EVENT_CONTRACTS[phase]?.expects ?? []).map((row) => row.type);
}

function disclosedTypes(phase: string): readonly string[] {
  return (PHASE_EVENT_CONTRACTS[phase]?.runtimeEmits ?? []).map((row) => row.type);
}

describe('the gate table projects the contract', () => {
  it('PhaseExpectedEvents_EveryPhase_EqualsTheContractInOrder', () => {
    const expectingPhases = Object.entries(PHASE_EVENT_CONTRACTS)
      .filter(([, contract]) => contract.expects.length > 0)
      .map(([phase]) => phase)
      .sort();
    expect(expectingPhases.length).toBeGreaterThan(0);
    expect(Object.keys(PHASE_EXPECTED_EVENTS).sort()).toEqual(expectingPhases);
    for (const phase of expectingPhases) {
      expect(PHASE_EXPECTED_EVENTS[phase], phase).toEqual(expectedTypes(phase));
    }
  });

  it('EventDescriptions_NameExactlyTheExpectedTypes', () => {
    const expected = new Set(Object.values(PHASE_EXPECTED_EVENTS).flat());
    expect(new Set(Object.keys(EVENT_DESCRIPTIONS))).toEqual(expected);
    for (const [type, description] of Object.entries(EVENT_DESCRIPTIONS)) {
      expect(description, type).toMatch(new RegExp(`^Emit ${type.replace(/\./g, '\\.')} via exarchos_event — `));
    }
  });
});

describe('the playbooks project the contract', () => {
  const registered = [...workflowPlaybooks.entries()].flatMap(([workflowType, playbooks]) =>
    playbooks.map((playbook) => ({ workflowType, playbook })),
  );

  it('Playbooks_EveryRegisteredPhase_InstructsExactlyTheContractsExpectations', () => {
    expect(registered.length).toBeGreaterThan(20);
    for (const { workflowType, playbook } of registered) {
      const label = `${workflowType}/${playbook.phase}`;
      expect(playbook.events.map((e) => e.type), label).toEqual(expectedTypes(playbook.phase));
      for (const instruction of playbook.events) {
        const row = PHASE_EVENT_CONTRACTS[playbook.phase]?.expects.find(
          (r) => r.type === instruction.type,
        );
        expect(instruction.when, label).toBe(row?.when);
        expect(instruction.fields, label).toEqual(row?.fields === undefined ? undefined : [...row.fields]);
      }
    }
  });

  it('Playbooks_EveryRegisteredPhase_DisclosesExactlyTheContractsRuntimeEmissions', () => {
    for (const { workflowType, playbook } of registered) {
      const label = `${workflowType}/${playbook.phase}`;
      const disclosed = disclosedTypes(playbook.phase);
      if (disclosed.length === 0) {
        expect(playbook.autoEmittedEvents, label).toBeUndefined();
        continue;
      }
      expect(playbook.autoEmittedEvents?.map((e) => e.type), label).toEqual(disclosed);
      for (const disclosure of playbook.autoEmittedEvents ?? []) {
        expect(disclosure.source, label).toBe('auto');
        expect(disclosure.emittedBy.length, label).toBeGreaterThan(0);
      }
    }
  });

  it('Playbooks_NoPhase_InstructsTheModelToEmitARuntimeOwnedEvent', () => {
    // The fact the contract exists to keep true: an instruction is for a
    // model-emitted event, a disclosure is for a runtime-emitted one, and no
    // playbook may put a type on both sides.
    for (const { workflowType, playbook } of registered) {
      const label = `${workflowType}/${playbook.phase}`;
      const instructed = playbook.events.map((e) => e.type);
      expect(instructed.filter((type) => REGISTRY.get(type) !== 'model'), label).toEqual([]);
      const disclosed = new Set((playbook.autoEmittedEvents ?? []).map((e) => e.type));
      expect(instructed.filter((type) => disclosed.has(type)), label).toEqual([]);
    }
  });

  it('SerializedPlaybooks_CarryTheSameRowsAsTheRegisteredOnes', () => {
    for (const workflowType of workflowPlaybooks.keys()) {
      const serialized = serializePlaybooks(workflowType);
      for (const [phase, entry] of Object.entries(serialized.phases)) {
        const label = `${workflowType}/${phase}`;
        expect(entry.events.map((e) => e.type), label).toEqual(expectedTypes(phase));
        expect((entry.autoEmittedEvents ?? []).map((e) => e.type), label).toEqual(
          disclosedTypes(phase),
        );
      }
    }
  });
});
