// These tests compare the live built-in workflows with a golden that the code before the
// definitions wrote. The golden holds each machine, the topology, the valid targets, the
// lowered kernel, the admission IR edges and the result of each stored transition input.
// A change of any output changes the rendered text, and the first test fails.
//
// @oracle-sources: ../__fixtures__/built-in.golden.json, ../../../../src/workflow/state-machine.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  captureEmissionInputs,
  readStoredInputs,
  renderBuiltInGolden,
  type EmissionInput,
} from '../../../helpers/definitions/built-in-golden.js';
import { transitionAdmissionCorpus } from '../__fixtures__/transition-admission-corpus.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import {
  PHASE_EVENT_CONTRACTS,
  assertContractPhasesAreRegistered,
} from '../../../../src/workflow/topology/phase-events.js';

/** The golden file that the scratch capture wrote once. No test writes it. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/built-in.golden.json',
);

/** The text of the golden file. */
const GOLDEN_TEXT = fs.readFileSync(GOLDEN_PATH, 'utf8');

/** The five built-in types in registry order. */
const BUILT_IN_TYPES: readonly string[] = ['feature', 'debug', 'refactor', 'oneshot', 'discovery'];

/** The digest of each lowered kernel, read from the golden at its capture. */
const DEFINITION_VERSIONS: Readonly<Record<string, string>> = {
  feature: 'fb23880b4958b39590a7a3008c22bdbb819d944d8c2fee99fab512202eb46fc9',
  debug: '9baacc58a2ac48a7631b62ed54088ccd5658578200a25a0fd60b68d57f65bdfa',
  refactor: '43026d3d6759b5522666802dcd750bd2939eea9897ff1369dcb1ee1d575b86aa',
  oneshot: '3eb31cbf2e44da2d45ace758abc1b246d6ca27272ea35610b248ba55174389ee',
  discovery: '7c0f7ffdae1f8dd7a0a8181aa862857730cc3d9e2b1f8bac077cd25d406b69e0',
};

/** The second inner guard of each composite guard. Each second-guard case fails on this guard. */
const SECOND_INNER_GUARD: Readonly<Record<string, string>> = {
  'all-tasks-complete+team-disbanded': 'team-disbanded-emitted',
  'validation+pr-requested': 'pr-requested',
  'synthesize-retryable+thorough-track': 'thorough-track-selected',
  'synthesize-retryable+hotfix-track': 'hotfix-track-selected',
};

/** The floor of each case kind of the stored inputs. */
const CASE_FLOORS = { corpus: 102, universal: 70, cap: 2, secondGuard: 4 };

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a list, or throws with its path. */
function listAt(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** The parsed golden. */
const GOLDEN = recordAt(JSON.parse(GOLDEN_TEXT), 'golden');

/** The golden entry of one workflow type. */
function workflowOf(type: string): Record<string, unknown> {
  return recordAt(recordAt(GOLDEN.workflows, 'workflows')[type], `workflows.${type}`);
}

/** The parsed machine of one workflow type. */
function machineOf(type: string): Record<string, unknown> {
  return recordAt(JSON.parse(textAt(workflowOf(type).machine, `${type}.machine`)), `${type}.machine`);
}

/** The parsed kernel of one workflow type. */
function kernelOf(type: string): Record<string, unknown> {
  return recordAt(JSON.parse(textAt(workflowOf(type).kernel, `${type}.kernel`)), `${type}.kernel`);
}

/** The states of one machine, in machine order. */
function statesOf(type: string): readonly Record<string, unknown>[] {
  return Object.entries(recordAt(machineOf(type).states, `${type}.states`)).map(([id, state]) =>
    recordAt(state, `${type}.states.${id}`),
  );
}

/** The number of stored inputs of each case kind. */
function countKinds(inputs: readonly EmissionInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.caseKind, (counts.get(input.caseKind) ?? 0) + 1);
  return counts;
}

/** The sorted `<type>:<phase>` keys of the stored inputs of one case kind. */
function phasesOfKind(inputs: readonly EmissionInput[], kind: string): readonly string[] {
  return inputs
    .filter((input) => input.caseKind === kind)
    .map((input) => `${input.type}:${String(input.state.phase)}`)
    .sort();
}

describe('the golden of the built-in workflows', () => {
  /** The live code renders the golden text again from the stored inputs, byte for byte. */
  it('BuiltInGolden_LiveProjection_IsByteIdenticalToTheGolden', () => {
    expect(renderBuiltInGolden(readStoredInputs(GOLDEN_TEXT))).toBe(GOLDEN_TEXT);
  });

  /** The live lowering gives the five digests that each capsule pins. The golden field is not the source here. */
  it('BuiltInGolden_TheDigests_AreTheFiveHexLiterals', () => {
    expect(Object.keys(DEFINITION_VERSIONS)).toEqual(BUILT_IN_TYPES);
    for (const type of BUILT_IN_TYPES) {
      expect(lowerBuiltInDefinition(type)?.definitionVersion, type).toBe(DEFINITION_VERSIONS[type]);
    }
  });

  /** The golden holds each denominator of the built-in workflows, and each case kind meets its floor. */
  it('BuiltInGolden_TheGolden_HoldsTheDenominators', () => {
    const names = listAt(GOLDEN.types, 'types').map((entry, index) =>
      textAt(recordAt(entry, `types.${index}`).name, `types.${index}.name`),
    );
    expect(names).toEqual(BUILT_IN_TYPES);
    expect(Object.keys(recordAt(GOLDEN.workflows, 'workflows'))).toEqual(BUILT_IN_TYPES);

    const stateTypes = new Map<string, number>();
    const transitionCounts: number[] = [];
    let kernelSteps = 0;
    for (const type of BUILT_IN_TYPES) {
      for (const state of statesOf(type)) {
        const stateType = textAt(state.type, `${type}.state.type`);
        stateTypes.set(stateType, (stateTypes.get(stateType) ?? 0) + 1);
      }
      const transitions = listAt(machineOf(type).transitions, `${type}.transitions`).length;
      const kernel = kernelOf(type);
      kernelSteps += listAt(kernel.steps, `${type}.kernel.steps`).length;
      expect(listAt(kernel.transitions, `${type}.kernel.transitions`), type).toHaveLength(transitions);
      expect(listAt(workflowOf(type).irEdges, `${type}.irEdges`), type).toHaveLength(transitions);
      transitionCounts.push(transitions);
    }
    expect(Object.fromEntries(stateTypes)).toEqual({ atomic: 35, compound: 5, final: 10 });
    expect([...stateTypes.values()].reduce((sum, count) => sum + count, 0)).toBe(50);
    expect(kernelSteps).toBe(45);
    expect(transitionCounts).toEqual([12, 16, 17, 4, 2]);
    expect(transitionCounts.reduce((sum, count) => sum + count, 0)).toBe(51);

    const inputs = readStoredInputs(GOLDEN_TEXT);
    const kinds = countKinds(inputs);
    expect(kinds.get('corpus') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.corpus);
    expect((kinds.get('cancel') ?? 0) + (kinds.get('cleanup') ?? 0)).toBeGreaterThanOrEqual(CASE_FLOORS.universal);
    expect(kinds.get('cap') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.cap);
    expect(kinds.get('second-guard') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.secondGuard);

    const atomic = BUILT_IN_TYPES.flatMap((type) =>
      statesOf(type)
        .filter((state) => state.type === 'atomic')
        .map((state) => `${type}:${textAt(state.id, `${type}.state.id`)}`),
    ).sort();
    expect(atomic).toHaveLength(35);
    expect(phasesOfKind(inputs, 'cancel')).toEqual(atomic);
    expect(phasesOfKind(inputs, 'cleanup')).toEqual(atomic);
  });

  /** Each phase of the phase event contract is a state of a golden machine, so the load assertion of the registry holds. */
  it('BuiltInGolden_EveryContractPhase_IsAStateOfTheGolden', () => {
    const states = new Set(
      BUILT_IN_TYPES.flatMap((type) => statesOf(type).map((state) => textAt(state.id, `${type}.state.id`))),
    );
    const phases = Object.keys(PHASE_EVENT_CONTRACTS);
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.filter((phase) => !states.has(phase))).toEqual([]);
    expect(() => assertContractPhasesAreRegistered(PHASE_EVENT_CONTRACTS, states)).not.toThrow();
  });

  /**
   * The capture of the live corpus gives unique case ids, and each case kind meets its floor.
   * The test does not compare the capture with the stored inputs, so a corpus edit that keeps the floors passes.
   */
  it('BuiltInGolden_TheCaptureOfTheLiveCorpus_CoversEachCaseKind', () => {
    const inputs = captureEmissionInputs(transitionAdmissionCorpus);
    const ids = inputs.map((input) => input.caseId);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = countKinds(inputs);
    expect(kinds.get('corpus') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.corpus);
    expect(kinds.get('cancel') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.universal / 2);
    expect(kinds.get('cleanup') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.universal / 2);
    expect(kinds.get('cap') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.cap);
    expect(kinds.get('second-guard') ?? 0).toBeGreaterThanOrEqual(CASE_FLOORS.secondGuard);
  });

  /**
   * Each composite guard has one second-guard case. Its stored result is a guard failure, and the message names the second inner guard.
   * So a composite that binds only its first inner guard gives a different result.
   */
  it('BuiltInGolden_EachSecondGuardCase_FailsOnTheSecondInnerGuard', () => {
    const composites = new Map<string, string>();
    for (const type of BUILT_IN_TYPES) {
      for (const [index, entry] of listAt(machineOf(type).transitions, `${type}.transitions`).entries()) {
        const transition = recordAt(entry, `${type}.transitions.${index}`);
        const guardId = textAt(recordAt(transition.guard, `${type}.transitions.${index}.guard`).id, 'guard.id');
        if (!guardId.includes('+')) continue;
        composites.set(`${type}:${String(transition.from)}->${String(transition.to)}`, guardId);
      }
    }
    expect([...composites.values()].sort()).toEqual(Object.keys(SECOND_INNER_GUARD).sort());

    const emissions = listAt(GOLDEN.emissions, 'emissions');
    const inputs = readStoredInputs(GOLDEN_TEXT);
    const hits = new Map<string, number>();
    inputs.forEach((input, index) => {
      if (input.caseKind !== 'second-guard') return;
      const composite = composites.get(`${input.type}:${String(input.state.phase)}->${input.target}`);
      expect(composite, input.caseId).toBeDefined();
      const result = recordAt(recordAt(emissions[index], `emissions.${index}`).result, `emissions.${index}.result`);
      expect(result.errorCode, input.caseId).toBe('GUARD_FAILED');
      const message = textAt(result.errorMessage, `emissions.${index}.result.errorMessage`);
      const prefix = `Guard '${String(composite)}' failed: ${String(SECOND_INNER_GUARD[String(composite)])} not satisfied`;
      expect(message.startsWith(prefix), `${input.caseId}: ${message}`).toBe(true);
      hits.set(String(composite), (hits.get(String(composite)) ?? 0) + 1);
    });
    expect(Object.fromEntries(hits)).toEqual(
      Object.fromEntries(Object.keys(SECOND_INNER_GUARD).map((composite) => [composite, 1])),
    );
  });
});
