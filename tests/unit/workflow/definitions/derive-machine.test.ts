// These tests check the phase machine that derives from each built-in definition. The golden
// recorded each hand-written machine and the result of each stored transition input before the
// definition files existed. So each derived machine must equal the machine of its registry factory
// and its golden machine as JSON. It must also bind the same guard objects. A composite edge must
// give the stored results, and the second-guard case is one of them.
//
// @oracle-sources: ../__fixtures__/built-in.golden.json, ../../../../src/workflow/hsm-definitions.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readStoredInputs, type EmissionInput } from '../../../helpers/definitions/built-in-golden.js';
import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  type BuiltInWorkflowType,
} from '../../../../src/workflow/definitions/built-in.js';
import { guards } from '../../../../src/workflow/guards.js';
import {
  GUARD_BINDINGS,
  buildGuardBindings,
  createDebugHSM,
  createDiscoveryHSM,
  createFeatureHSM,
  createOneshotHSM,
  createRefactorHSM,
  deriveMachine,
} from '../../../../src/workflow/hsm-definitions.js';
import {
  executeTransition,
  getValidTransitions,
  type HSMDefinition,
  type TransitionResult,
} from '../../../../src/workflow/state-machine.js';

/** The golden that the code before the definition files wrote. No test writes it. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/built-in.golden.json',
);

/** The text of the golden file. */
const GOLDEN_TEXT = fs.readFileSync(GOLDEN_PATH, 'utf8');

/** The registry factory of each built-in type. */
const FACTORIES: Readonly<Record<BuiltInWorkflowType, () => HSMDefinition>> = {
  feature: createFeatureHSM,
  debug: createDebugHSM,
  refactor: createRefactorHSM,
  oneshot: createOneshotHSM,
  discovery: createDiscoveryHSM,
};

/** The four composite guard ids of the built-in definitions. */
const COMPOSITE_IDS: readonly string[] = [
  'all-tasks-complete+team-disbanded',
  'validation+pr-requested',
  'synthesize-retryable+thorough-track',
  'synthesize-retryable+hotfix-track',
];

/** The number of guards in the binding table beside the plain guards: four composites and two merge-pending guards. */
const NON_PLAIN_BINDINGS = 6;

/** One stored transition input of the golden, with the result that the literal machine gave at the capture. */
interface StoredCase {
  readonly input: EmissionInput;
  readonly result: unknown;
}

/** The counts of the stored cases of one composite edge. */
interface CompositeTally {
  corpus: number;
  secondGuard: number;
  passes: number;
  failures: number;
}

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
  const list: readonly unknown[] = value;
  return list;
}

/** The parsed golden. */
const GOLDEN = recordAt(JSON.parse(GOLDEN_TEXT), 'golden');

/** The golden entry of one workflow type. */
function workflowOf(type: string): Record<string, unknown> {
  return recordAt(recordAt(GOLDEN.workflows, 'workflows')[type], `workflows.${type}`);
}

/** The stored inputs of the golden, each with its stored result. */
function storedCases(): readonly StoredCase[] {
  const inputs = readStoredInputs(GOLDEN_TEXT);
  const emissions = listAt(GOLDEN.emissions, 'emissions');
  if (emissions.length !== inputs.length) throw new Error('the golden emissions and inputs differ in length');
  return inputs.map((input, index) => ({
    input,
    result: recordAt(emissions[index], `emissions.${index}`).result,
  }));
}

/** Returns the stored case with the given case id, or throws. */
function storedCase(caseId: string): StoredCase {
  const found = storedCases().find((entry) => entry.input.caseId === caseId);
  if (found === undefined) throw new Error(`the golden has no stored case '${caseId}'`);
  return found;
}

/** Runs one stored input on a machine with the gate resolver that returns no gates, as the capture did. */
function runInput(machine: HSMDefinition, input: EmissionInput): TransitionResult {
  return executeTransition(machine, { ...input.state }, input.target, () => []);
}

/** Returns the JSON form of a value, as the golden stores it. */
function jsonOf(value: unknown): unknown {
  const json: unknown = JSON.parse(JSON.stringify(value));
  return json;
}

/** Returns the machine that derives from the live definition of a built-in type. */
function derivedMachine(type: BuiltInWorkflowType): HSMDefinition {
  return deriveMachine(builtInDefinition(type), GUARD_BINDINGS);
}

/** Returns a mutable copy of the feature definition. */
function featureClone(): ReturnType<typeof builtInDefinition> {
  return structuredClone(builtInDefinition('feature'));
}

/** Returns each object and list inside a value. The walk does not enter a guard, because the binding table owns each guard. */
function containersOf(value: unknown): ReadonlySet<object> {
  const found = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || found.has(node)) return;
    found.add(node);
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'guard') visit(child);
    }
  };
  visit(value);
  return found;
}

describe('the phase machine that derives from each built-in definition', () => {
  /** Each derived machine prints the same JSON as the machine of its factory and as its golden machine. So each state, key and guard text is the same. */
  it.each(BUILT_IN_WORKFLOW_TYPES)('DeriveMachine_%s_EqualsTheLiteralMachineAsJson', (type) => {
    const derived = JSON.stringify(derivedMachine(type));
    expect(derived).toBe(JSON.stringify(FACTORIES[type]()));
    expect(derived).toBe(workflowOf(type).machine);
  });

  /** Each plain and merge-pending guard of a derived machine is the guard object of the factory machine. A composite has the id and the description of the factory composite. */
  it.each(BUILT_IN_WORKFLOW_TYPES)('DeriveMachine_%s_BindsEachPlainGuardByReference', (type) => {
    const derived = derivedMachine(type).transitions;
    const literal = FACTORIES[type]().transitions;
    expect(derived).toHaveLength(literal.length);
    let byReference = 0;
    derived.forEach((transition, index) => {
      const label = `${type} ${transition.from}->${transition.to}`;
      const expected = literal[index]?.guard;
      const guard = transition.guard;
      expect(guard, label).toBeDefined();
      expect(expected, label).toBeDefined();
      if (guard === undefined || expected === undefined) return;
      expect(guard, label).toBe(GUARD_BINDINGS.get(guard.id));
      if (COMPOSITE_IDS.includes(expected.id)) {
        expect({ id: guard.id, description: guard.description }, label).toEqual({
          id: expected.id,
          description: expected.description,
        });
        return;
      }
      expect(guard, label).toBe(expected);
      byReference += 1;
    });
    expect(byReference).toBeGreaterThan(0);
  });

  /**
   * Each composite edge of a derived machine gives the stored result of each stored input of that edge.
   * The inputs are the corpus pass and fail cases and the case that passes the first inner guard and fails the second.
   */
  it('DeriveMachine_EachBoundComposite_GivesTheStoredResults', () => {
    const cases = storedCases();
    const tallies = new Map<string, CompositeTally>();
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const machine = derivedMachine(type);
      for (const transition of machine.transitions) {
        const guardId = transition.guard?.id ?? '';
        if (!COMPOSITE_IDS.includes(guardId)) continue;
        const tally: CompositeTally = { corpus: 0, secondGuard: 0, passes: 0, failures: 0 };
        const edgeCases = cases.filter(
          ({ input }) => input.type === type && input.state.phase === transition.from && input.target === transition.to,
        );
        for (const { input, result } of edgeCases) {
          const live = runInput(machine, input);
          expect(jsonOf(live), input.caseId).toEqual(result);
          if (input.caseKind === 'corpus') tally.corpus += 1;
          if (input.caseKind === 'second-guard') tally.secondGuard += 1;
          if (live.success) tally.passes += 1;
          else tally.failures += 1;
        }
        tallies.set(guardId, tally);
      }
    }
    expect([...tallies.keys()].sort()).toEqual([...COMPOSITE_IDS].sort());
    for (const [guardId, tally] of tallies) {
      expect(tally.secondGuard, guardId).toBe(1);
      expect(tally.corpus, guardId).toBeGreaterThanOrEqual(2);
      expect(tally.passes, guardId).toBeGreaterThan(0);
      expect(tally.failures, guardId).toBeGreaterThanOrEqual(2);
    }
  });

  /** A clone of feature names another guard id on its first edge. The derived machine binds that guard there, and each other transition keeps its guard. */
  it('DeriveMachine_ASwappedGuardId_BindsTheOtherGuard', () => {
    const clone = featureClone();
    const edge = clone.exarchos.edges['plan->plan-review'];
    expect(edge?.guardId).toBe('plan-artifact-exists');
    if (edge === undefined) return;
    edge.guardId = 'design-artifact-exists';

    const swapped = deriveMachine(clone, GUARD_BINDINGS).transitions;
    const live = derivedMachine('feature').transitions;
    expect(swapped).toHaveLength(live.length);
    expect(swapped[0]?.guard).toBe(guards.designArtifactExists);
    expect(live[0]?.guard).toBe(guards.planArtifactExists);
    const changed = swapped
      .filter((transition, index) => transition.guard !== live[index]?.guard)
      .map((transition) => `${transition.from}->${transition.to}`);
    expect(changed).toEqual(['plan->plan-review']);
  });

  /**
   * The binding table refuses a second guard with an id that it holds, also when the second object is a copy.
   * The live table holds each plain guard by reference, the four composites and the two merge-pending guards.
   */
  it('DeriveMachine_ADuplicateBindingId_Throws', () => {
    expect(() =>
      buildGuardBindings([guards.planArtifactExists, guards.designArtifactExists, guards.planArtifactExists]),
    ).toThrow(/the guard id 'plan-artifact-exists' has more than one binding/);
    expect(() => buildGuardBindings([...GUARD_BINDINGS.values(), { ...guards.prUrlExists }])).toThrow(
      /the guard id 'pr-url-exists' has more than one binding/,
    );
    expect(buildGuardBindings([...GUARD_BINDINGS.values()]).size).toBe(GUARD_BINDINGS.size);

    const plain = Object.values(guards);
    expect(GUARD_BINDINGS.size).toBe(plain.length + NON_PLAIN_BINDINGS);
    expect(plain.filter((guard) => GUARD_BINDINGS.get(guard.id) !== guard).map((guard) => guard.id)).toEqual([]);
    expect(COMPOSITE_IDS.filter((id) => !GUARD_BINDINGS.has(id))).toEqual([]);
    expect(GUARD_BINDINGS.has('merge-pending-entry')).toBe(true);
    expect(GUARD_BINDINGS.has('merge-pending-exit')).toBe(true);
  });

  /** An edge that names a guard id with no binding stops the derivation with an error that names the edge and the id. */
  it('DeriveMachine_AnUnknownGuardId_ThrowsAndNamesTheEdge', () => {
    const clone = featureClone();
    const edge = clone.exarchos.edges['plan->plan-review'];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    edge.guardId = 'no-such-guard';

    expect(() => deriveMachine(clone, GUARD_BINDINGS)).toThrow(
      /the built-in edge 'feature plan->plan-review' names the unknown guard 'no-such-guard'/,
    );
    expect(() => deriveMachine(builtInDefinition('feature'), new Map())).toThrow(
      /the built-in edge 'feature plan->plan-review' names the unknown guard 'plan-artifact-exists'/,
    );
    expect(() => deriveMachine(featureClone(), GUARD_BINDINGS)).not.toThrow();
  });

  /** Two kernel transitions in the other order give the valid targets of their source state in the other order. */
  it('DeriveMachine_AReorderedTransition_ChangesTheValidTargetOrder', () => {
    const clone = featureClone();
    const index = clone.transitions.findIndex((transition) => transition.transitionId === 'plan-review->delegate');
    const first = clone.transitions[index];
    const second = clone.transitions[index + 1];
    expect(second?.transitionId).toBe('plan-review->blocked');
    if (first === undefined || second === undefined) return;
    clone.transitions.splice(index, 2, second, first);

    const goldenTargets = listAt(recordAt(workflowOf('feature').validTargets, 'validTargets')['plan-review'], 'plan-review');
    const live = getValidTransitions(derivedMachine('feature'), 'plan-review').map((target) => target.phase);
    const reordered = getValidTransitions(deriveMachine(clone, GUARD_BINDINGS), 'plan-review').map(
      (target) => target.phase,
    );
    expect(live).toEqual(goldenTargets.map((target, at) => recordAt(target, `plan-review.${at}`).phase));
    expect(live).toEqual(['delegate', 'blocked', 'plan', 'cancelled', 'completed']);
    expect(reordered).toEqual(['blocked', 'delegate', 'plan', 'cancelled', 'completed']);
  });

  /** A group with no `maxFixCycles` has no cap, so the stored input at the cap of feature `implementation` succeeds. */
  it('DeriveMachine_ADroppedMaxFixCycles_LetsTheTransitionAtTheCapSucceed', () => {
    const atCap = storedCase('cap-feature-implementation');
    expect(recordAt(atCap.result, 'cap result').errorCode).toBe('CIRCUIT_OPEN');
    const clone = featureClone();
    const group = clone.exarchos.groups[0];
    expect(group?.groupId).toBe('implementation');
    expect(group?.maxFixCycles).toBe(3);
    if (group === undefined) return;
    delete group.maxFixCycles;

    const live = runInput(derivedMachine('feature'), atCap.input);
    const dropped = runInput(deriveMachine(clone, GUARD_BINDINGS), atCap.input);
    expect(jsonOf(live)).toEqual(atCap.result);
    expect(live.success).toBe(false);
    expect(dropped.success).toBe(true);
    expect(dropped.newPhase).toBe(atCap.input.target);
    expect(dropped.errorCode).toBeUndefined();
  });

  /** Each call returns a fresh machine. No object or list of it is frozen, or part of the definition or of another machine. */
  it('DeriveMachine_EachCall_ReturnsAMachineThatSharesNoArrayWithTheDefinition', () => {
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const definition = builtInDefinition(type);
      const first = deriveMachine(definition, GUARD_BINDINGS);
      const second = deriveMachine(definition, GUARD_BINDINGS);
      expect(JSON.stringify(second), type).toBe(JSON.stringify(first));
      const firstContainers = [...containersOf(first)];
      const secondContainers = containersOf(second);
      const definitionContainers = containersOf(definition);
      expect(firstContainers.length, type).toBeGreaterThan(Object.keys(first.states).length + first.transitions.length);
      expect(firstContainers.filter((container) => Object.isFrozen(container)), type).toEqual([]);
      expect(firstContainers.filter((container) => definitionContainers.has(container)), type).toEqual([]);
      expect(firstContainers.filter((container) => secondContainers.has(container)), type).toEqual([]);
    }
  });
});
