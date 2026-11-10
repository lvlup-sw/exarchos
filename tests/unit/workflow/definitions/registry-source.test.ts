// These tests check that the live registry reads the built-in definitions. Each guard of a
// registry machine is the guard object of the binding table, and the machine module holds no
// transition literal. The roster and the initial phases equal the definitions and the golden
// that the code before the definition files wrote.
//
// @oracle-sources: ../__fixtures__/built-in.golden.json, ../../../../src/workflow/state-machine.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  isBuiltInDefinitionType,
} from '../../../../src/workflow/definitions/built-in.js';
import { GUARD_BINDINGS } from '../../../../src/workflow/hsm-definitions.js';
import {
  getHSMDefinition,
  getInitialPhase,
  isBuiltInWorkflowType,
  listWorkflowTypes,
} from '../../../../src/workflow/state-machine.js';

/** The directory of this test file. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The golden that the code before the definition files wrote. No test writes it. */
const GOLDEN_PATH = path.resolve(HERE, '../__fixtures__/built-in.golden.json');

/** The module that holds the factories of the built-in machines. */
const MACHINE_MODULE_PATH = path.resolve(HERE, '../../../../src/workflow/hsm-definitions.ts');

/** The five built-in type names in registry order, as the golden records them. */
const GOLDEN_ROSTER: readonly string[] = ['feature', 'debug', 'refactor', 'oneshot', 'discovery'];

/** The four composite guard ids of the built-in definitions. */
const COMPOSITE_IDS: readonly string[] = [
  'all-tasks-complete+team-disbanded',
  'validation+pr-requested',
  'synthesize-retryable+thorough-track',
  'synthesize-retryable+hotfix-track',
];

/** The number of transitions of the five built-in machines together. */
const BUILT_IN_TRANSITIONS = 51;

/** An object literal of a transition with a quoted source state, on one line or on more lines. */
const TRANSITION_LITERAL = /\{\s*from:\s*['"]/;

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

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** The parsed golden. */
const GOLDEN = recordAt(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')), 'golden');

/** The entries of the golden `types` field, in registry order. */
function goldenTypes(): readonly Record<string, unknown>[] {
  return listAt(GOLDEN.types, 'types').map((entry, index) => recordAt(entry, `types.${index}`));
}

/** The golden entry of one workflow type. */
function workflowOf(type: string): Record<string, unknown> {
  return recordAt(recordAt(GOLDEN.workflows, 'workflows')[type], `workflows.${type}`);
}

/** The number of transitions of the golden machine of one type. */
function goldenTransitionCount(type: string): number {
  const machine = recordAt(JSON.parse(textAt(workflowOf(type).machine, `workflows.${type}.machine`)), `${type} machine`);
  return listAt(machine.transitions, `${type} machine.transitions`).length;
}

describe('the live registry reads the built-in definitions', () => {
  /** Each guard of each registry machine is the object that the binding table holds for its id. A factory that builds its own composite fails. */
  it('RegistrySource_EachGuardOfTheRegistry_IsTheBoundGuardObject', () => {
    const unbound: string[] = [];
    const composites: string[] = [];
    let transitions = 0;
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const machine = getHSMDefinition(type);
      expect(machine.transitions, type).toHaveLength(goldenTransitionCount(type));
      for (const transition of machine.transitions) {
        transitions += 1;
        const label = `${type} ${transition.from}->${transition.to}`;
        const guard = transition.guard;
        if (guard === undefined || GUARD_BINDINGS.get(guard.id) !== guard) unbound.push(label);
        if (guard !== undefined && COMPOSITE_IDS.includes(guard.id)) composites.push(guard.id);
      }
    }
    expect(transitions).toBe(BUILT_IN_TRANSITIONS);
    expect([...composites].sort()).toEqual([...COMPOSITE_IDS].sort());
    expect(unbound).toEqual([]);
  });

  /** The machine module holds no transition literal. Each factory reads the definition of its type. */
  it('RegistrySource_TheMachineModule_HoldsNoTransitionLiteral', () => {
    const source = fs.readFileSync(MACHINE_MODULE_PATH, 'utf8');
    expect(source).toContain('export function createFeatureHSM(');
    expect(source).not.toMatch(TRANSITION_LITERAL);
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      expect(source, type).toContain(`builtInDefinition('${type}')`);
    }
  });

  /** The built-in names of the registry and the roster of the definitions both equal the golden names, in order. */
  it('RegistrySource_TheRoster_IsTheDefinitionRoster', () => {
    const goldenNames = goldenTypes().map((entry, index) => textAt(entry.name, `types.${index}.name`));
    expect(goldenNames).toEqual(GOLDEN_ROSTER);
    const registered = listWorkflowTypes().workflowTypes.map((entry) => entry.name);
    expect(registered.filter((name) => isBuiltInWorkflowType(name))).toEqual(goldenNames);
    expect([...BUILT_IN_WORKFLOW_TYPES]).toEqual(goldenNames);
    expect(goldenNames.filter((name) => !isBuiltInWorkflowType(name))).toEqual([]);
    expect(isBuiltInWorkflowType('not-a-built-in')).toBe(false);
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      expect(builtInDefinition(type).name, type).toBe(`exarchos.${type}`);
    }
  });

  /** The initial phase of each built-in type is the entry step of its definition and the initial phase of the golden. */
  it('RegistrySource_EachInitialPhase_IsTheEntryStep', () => {
    const types = goldenTypes();
    expect(types).toHaveLength(GOLDEN_ROSTER.length);
    let checked = 0;
    types.forEach((entry, index) => {
      const type = entry.name;
      expect(isBuiltInDefinitionType(type), `types.${index}.name`).toBe(true);
      if (!isBuiltInDefinitionType(type)) return;
      const initialPhase = getInitialPhase(type);
      expect(initialPhase, type).toBe(builtInDefinition(type).entryStepId);
      expect(initialPhase, type).toBe(entry.initialPhase);
      expect(initialPhase, type).toBe(workflowOf(type).initialPhase);
      checked += 1;
    });
    expect(checked).toBe(GOLDEN_ROSTER.length);
  });
});
