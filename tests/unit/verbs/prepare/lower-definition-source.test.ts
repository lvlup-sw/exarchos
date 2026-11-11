// These tests check the source of the lowered kernel. The lowering reads the authored definition
// of each built-in type and not the state machine. The result is the definition without its
// extension, and it equals the kernel that the golden recorded before the definition files existed.
// A copy of the earlier lowering algorithm in this file walks the machine and gives the same kernel.
//
// @oracle-sources: ../../workflow/__fixtures__/built-in.golden.json, ../../../../src/verbs/prepare/lower-definition.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@lvlup-sw/strategos-contracts';
import { describe, expect, it } from 'vitest';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { canonicalJson } from '../../../../src/contract/request-context.js';
import { builtInWorkflowAuthority } from '../../../../src/verbs/prepare/built-in-authority.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  kernelOf,
} from '../../../../src/workflow/definitions/built-in.js';
import { getHSMDefinition, getInitialPhase, type State } from '../../../../src/workflow/state-machine.js';

/** The directory of this test file. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The module under test. */
const LOWERING_PATH = path.resolve(HERE, '../../../../src/verbs/prepare/lower-definition.ts');

/** The golden that the code before the definition files wrote. No test writes it. */
const GOLDEN_PATH = path.resolve(HERE, '../../workflow/__fixtures__/built-in.golden.json');

/** The relative import of the definitions loader. */
const LOADER_IMPORT = '../../workflow/definitions/built-in.js';

/** The relative imports that the lowering no longer holds. */
const MACHINE_IMPORTS: readonly string[] = ['../../workflow/state-machine.js', './built-in-authority.js'];

type KernelStep = WorkflowDefinitionV1['steps'][number];
type KernelTransition = WorkflowDefinitionV1['transitions'][number];

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** The workflows of the golden, keyed by type. */
const GOLDEN_WORKFLOWS = recordAt(
  recordAt(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')), 'golden').workflows,
  'workflows',
);

/** The canonical JSON of the kernel that the golden recorded for one type. */
function goldenKernelOf(type: string): string {
  return textAt(recordAt(GOLDEN_WORKFLOWS[type], `workflows.${type}`).kernel, `workflows.${type}.kernel`);
}

/** The module specifiers of each import and export statement of a source text. */
function importSpecifiers(source: string): readonly string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/**
 * The lowering algorithm from before the definition files, kept as a second source. It walks the
 * state machine of one built-in type. An atomic state becomes a step typed by its phase kind, and a
 * final state becomes a terminal step. A compound state flattens into its children.
 */
function lowerFromMachine(workflowType: string): WorkflowDefinitionV1 {
  const hsm = getHSMDefinition(workflowType);
  const states = Object.values(hsm.states);

  const stateOf = (id: string): State => {
    const state = hsm.states[id];
    if (state === undefined) {
      throw new Error(`workflow '${workflowType}' names state '${id}', which it does not declare`);
    }
    return state;
  };
  const entryOf = (id: string): string => {
    const state = stateOf(id);
    if (state.type !== 'compound') return id;
    if (state.initial === undefined) {
      throw new Error(`compound state '${id}' of workflow '${workflowType}' declares no initial child`);
    }
    return entryOf(state.initial);
  };
  const leavesOf = (id: string): string[] => {
    const state = stateOf(id);
    if (state.type !== 'compound') return [id];
    return states.filter((child) => child.parent === id).flatMap((child) => leavesOf(child.id));
  };

  const steps: KernelStep[] = states
    .filter((state) => state.type !== 'compound')
    .map((state) => ({
      kind: 'skill',
      stepId: state.id,
      stepName: state.id,
      isTerminal: state.type === 'final',
      runtime: 'exarchos',
      stepType: state.type === 'atomic' ? state.kind : 'final',
    }));

  const transitions: KernelTransition[] = [];
  const seen = new Set<string>();
  for (const transition of hsm.transitions) {
    const to = entryOf(transition.to);
    for (const from of leavesOf(transition.from)) {
      const transitionId = `${from}->${to}`;
      if (seen.has(transitionId)) continue;
      seen.add(transitionId);
      transitions.push({ transitionId, fromStepId: from, toStepId: to, isDefault: false });
    }
  }

  const terminals = steps.filter((step) => step.isTerminal);
  const onlyTerminal = terminals.length === 1 ? terminals[0] : undefined;
  return WorkflowDefinitionV1Schema.parse({
    schemaVersion: '1.0',
    name: `exarchos.${workflowType}`,
    steps,
    transitions,
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
    authority: builtInWorkflowAuthority(),
    entryStepId: entryOf(getInitialPhase(workflowType)),
    ...(onlyTerminal !== undefined ? { terminalStepId: onlyTerminal.stepId } : {}),
  });
}

describe('the source of the lowered kernel', () => {
  /** The lowering imports the definitions loader. It imports neither the state machine nor the authority module. */
  it('LowerDefinition_TheModule_ReadsTheDefinitionsAndNotTheMachine', () => {
    const relative = new Set(importSpecifiers(fs.readFileSync(LOWERING_PATH, 'utf8')).filter((s) => s.startsWith('.')));
    expect(relative.size).toBeGreaterThan(0);
    expect(relative.has(LOADER_IMPORT)).toBe(true);
    for (const machineImport of MACHINE_IMPORTS) expect(relative.has(machineImport), machineImport).toBe(false);
  });

  /** The lowered kernel is the authored definition without its extension, and its canonical JSON is the golden kernel. */
  it.each(BUILT_IN_WORKFLOW_TYPES)('LowerDefinition_%s_IsTheDefinitionWithoutItsExtension', (type) => {
    const lowered = lowerBuiltInDefinition(type);
    expect(lowered).toBeDefined();
    expect(lowered?.definition).toStrictEqual(kernelOf(builtInDefinition(type)));
    expect(Object.hasOwn(lowered?.definition ?? {}, 'exarchos')).toBe(false);
    expect(canonicalJson(lowered?.definition)).toBe(goldenKernelOf(type));
  });

  /** The earlier lowering algorithm, run over the live machine, gives the same kernel and the same digest. */
  it.each(BUILT_IN_WORKFLOW_TYPES)('LowerDefinition_%s_EqualsTheMachineLowering', (type) => {
    const lowered = lowerBuiltInDefinition(type);
    const fromMachine = lowerFromMachine(type);
    expect(lowered?.definition).toStrictEqual(fromMachine);
    expect(lowered?.definitionVersion).toBe(contentDigest(fromMachine));
  });
});
