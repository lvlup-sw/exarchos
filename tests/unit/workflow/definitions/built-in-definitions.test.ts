// These tests check the loader of the five built-in workflow definitions and the built-in rules.
// Each refusal case changes one clone of a definition file and states the finding that it expects.
// The kernel copy and the universal edges are compared with the golden, which the code before the
// definition files wrote.
//
// @oracle-sources: ../../../../src/workflow/definitions/built-in.ts, ../__fixtures__/built-in.golden.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  isBuiltInDefinitionType,
  kernelOf,
  loadBuiltInDefinitions,
  validateBuiltInDefinition,
  type BuiltInWorkflowType,
} from '../../../../src/workflow/definitions/built-in.js';
import { parseExtension, validateExtension } from '../../../../src/workflow/definitions/extension.js';
import debug from '../../../../src/workflow/definitions/debug.workflow.json' with { type: 'json' };
import discovery from '../../../../src/workflow/definitions/discovery.workflow.json' with { type: 'json' };
import feature from '../../../../src/workflow/definitions/feature.workflow.json' with { type: 'json' };
import oneshot from '../../../../src/workflow/definitions/oneshot.workflow.json' with { type: 'json' };
import refactor from '../../../../src/workflow/definitions/refactor.workflow.json' with { type: 'json' };

/** The golden that the code before the definition files wrote. No test writes it. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/built-in.golden.json',
);

/** The five definition files, keyed by their type. */
const RAW: Readonly<Record<BuiltInWorkflowType, unknown>> = { feature, debug, refactor, oneshot, discovery };

/** The universal edges that the executor runs from each non-final state. */
const EXECUTOR_UNIVERSAL_EDGES = [
  { edgeKind: 'cancel', to: 'cancelled' },
  { edgeKind: 'cleanup', to: 'completed', guardId: 'merge-verified' },
];

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
function listAt(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** The parsed golden. */
const GOLDEN = recordAt(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')), 'golden');

/** The golden entry of one workflow type. */
function goldenWorkflow(type: string): Record<string, unknown> {
  return recordAt(recordAt(GOLDEN.workflows, 'workflows')[type], `workflows.${type}`);
}

/** A fresh clone of one definition file. */
function rawClone(type: BuiltInWorkflowType): Record<string, unknown> {
  return recordAt(structuredClone(RAW[type]), type);
}

/** Fresh clones of the five definition files. */
function cloneAll(): Record<BuiltInWorkflowType, Record<string, unknown>> {
  return {
    feature: rawClone('feature'),
    debug: rawClone('debug'),
    refactor: rawClone('refactor'),
    oneshot: rawClone('oneshot'),
    discovery: rawClone('discovery'),
  };
}

/** The extension of a raw document. */
function extensionOf(document: Record<string, unknown>): Record<string, unknown> {
  return recordAt(document.exarchos, 'exarchos');
}

/** The message of the error that the call throws, or `undefined` when it returns. */
function thrownMessage(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** The finding lines of a loader error: every line after the first. */
function findingLines(message: string | undefined): readonly string[] {
  return (message ?? '').split('\n').slice(1);
}

/** The result of one load: the finding lines of the error, or the types of the map that the load returned. */
interface LoadOutcome {
  readonly findings: readonly string[];
  readonly loadedTypes: readonly BuiltInWorkflowType[];
}

/**
 * Loads fresh clones of the five files, with the given document in place of the feature file.
 * A load that throws gives its finding lines. A load that returns gives the types of its map, also when the map is partial.
 */
function loadWithFeature(document: Record<string, unknown>): LoadOutcome {
  try {
    const loaded = loadBuiltInDefinitions({ ...cloneAll(), feature: document });
    return { findings: [], loadedTypes: [...loaded.keys()] };
  } catch (error) {
    return { findings: findingLines(error instanceof Error ? error.message : String(error)), loadedTypes: [] };
  }
}

/** Collects every object and list inside a value, the value included. */
function nestedObjects(value: unknown, into: object[] = []): object[] {
  if (typeof value !== 'object' || value === null) return into;
  into.push(value);
  const children: readonly unknown[] = Object.values(value);
  for (const child of children) nestedObjects(child, into);
  return into;
}

/** The universal targets of one golden workflow, as `<target>|<guard id>` keys. */
function goldenUniversalKeys(type: string): readonly string[] {
  const keys = new Set<string>();
  for (const [stateId, targets] of Object.entries(recordAt(goldenWorkflow(type).validTargets, 'validTargets'))) {
    for (const target of listAt(targets, stateId)) {
      const entry = recordAt(target, stateId);
      if (entry.universal !== true) continue;
      const guard = entry.guard === undefined ? '' : String(recordAt(entry.guard, 'guard').id);
      keys.add(`${String(entry.phase)}|${guard}`);
    }
  }
  return [...keys].sort();
}

describe('the built-in workflow definitions', () => {
  /**
   * Each file parses with the loose kernel schema, its extension parses with the strict schema, and no reference rule refuses it.
   * The loaded definition is the parsed kernel with the parsed extension.
   */
  it.each(BUILT_IN_WORKFLOW_TYPES)('BuiltInDefinitions_%s_ParsesWithTheKernelAndTheExtension', (type) => {
    const raw = RAW[type];
    const kernel = WorkflowDefinitionV1Schema.safeParse(raw);
    expect(kernel.success).toBe(true);
    const parsed = parseExtension(raw);
    expect(parsed.ok).toBe(true);
    if (!kernel.success || !parsed.ok) return;
    expect(validateExtension(raw, kernel.data, parsed.extension)).toEqual([]);
    expect(builtInDefinition(type)).toStrictEqual({ ...kernel.data, exarchos: parsed.extension });
  });

  /** Each file passes the built-in rules, and its name is `exarchos.<type>`. */
  it.each(BUILT_IN_WORKFLOW_TYPES)('BuiltInDefinitions_%s_PassesTheBuiltInRules', (type) => {
    expect(validateBuiltInDefinition(type, RAW[type])).toEqual([]);
    expect(builtInDefinition(type).name).toBe(`exarchos.${type}`);
    expect(validateBuiltInDefinition(type, { ...rawClone(type), name: 'exarchos.custom' })).toEqual([
      { rule: 'built-in-name', path: ['name'] },
    ]);
  });

  /** The kernel schema keeps a stray key in a step, so the built-in rules refuse it, and the load names it. */
  it('BuiltInDefinitions_AStrayStepKey_IsRefused', () => {
    const document = rawClone('feature');
    recordAt(listAt(document.steps, 'steps')[2], 'steps.2').note = 'free text';
    const kernel = WorkflowDefinitionV1Schema.safeParse(document);
    expect(kernel.success).toBe(true);
    expect(kernel.data?.steps[2]).toHaveProperty('note', 'free text');

    expect(validateBuiltInDefinition('feature', document)).toEqual([
      { rule: 'built-in-step-keys', path: ['steps', 2, 'note'] },
    ]);
    expect(findingLines(thrownMessage(() => loadBuiltInDefinitions({ ...cloneAll(), feature: document })))).toEqual([
      'feature built-in-step-keys steps.2.note',
    ]);
  });

  /** The kernel schema keeps a stray key in a transition, so the built-in rules refuse it at that key. */
  it('BuiltInDefinitions_AStrayTransitionKey_IsRefused', () => {
    const document = rawClone('debug');
    recordAt(listAt(document.transitions, 'transitions')[0], 'transitions.0').guard = 'triage-complete';
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);

    expect(validateBuiltInDefinition('debug', document)).toEqual([
      { rule: 'built-in-transition', path: ['transitions', 0, 'guard'] },
    ]);
    expect(findingLines(thrownMessage(() => loadBuiltInDefinitions({ ...cloneAll(), debug: document })))).toEqual([
      'debug built-in-transition transitions.0.guard',
    ]);
  });

  /** The authority of a built-in definition is the built-in authority. A dropped statement and a changed statement are each refused. */
  it('BuiltInDefinitions_AnAuthorityOtherThanTheBuiltIn_IsRefused', () => {
    const dropped = rawClone('refactor');
    listAt(recordAt(dropped.authority, 'authority').invariants, 'invariants').pop();
    expect(WorkflowDefinitionV1Schema.safeParse(dropped).success).toBe(true);
    expect(validateBuiltInDefinition('refactor', dropped)).toEqual([{ rule: 'built-in-authority', path: ['authority'] }]);

    const changed = rawClone('refactor');
    const assumption = recordAt(listAt(recordAt(changed.authority, 'authority').assumptions, 'assumptions')[0], 'assumption');
    assumption.statement = `${String(assumption.statement)} Edited.`;
    expect(validateBuiltInDefinition('refactor', changed)).toEqual([{ rule: 'built-in-authority', path: ['authority'] }]);
    expect(findingLines(thrownMessage(() => loadBuiltInDefinitions({ ...cloneAll(), refactor: changed })))).toEqual([
      'refactor built-in-authority authority',
    ]);
  });

  /** The extension schema accepts an edge with no guard id. The built-in rules refuse it, and the path names the edge. */
  it('BuiltInDefinitions_AnEdgeWithNoGuardId_IsRefused', () => {
    const document = rawClone('feature');
    delete recordAt(recordAt(extensionOf(document).edges, 'edges')['plan->plan-review'], 'edge').guardId;
    const parsed = parseExtension(document);
    expect(parsed.ok).toBe(true);

    expect(validateBuiltInDefinition('feature', document)).toEqual([
      { rule: 'built-in-edge', path: ['exarchos', 'edges', 'plan->plan-review', 'guardId'] },
    ]);
    expect(findingLines(thrownMessage(() => loadBuiltInDefinitions({ ...cloneAll(), feature: document })))).toEqual([
      'feature built-in-edge exarchos.edges.plan->plan-review.guardId',
    ]);
  });

  /**
   * Each definition declares exactly the two universal edges that the executor runs. They match the universal targets that the golden recorded.
   * A list in another order, with another guard, or with one edge only is refused.
   */
  it('BuiltInDefinitions_TheUniversalEdges_AreTheExecutorUniversals', () => {
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const universal = builtInDefinition(type).exarchos.universal;
      expect(universal, type).toStrictEqual(EXECUTOR_UNIVERSAL_EDGES);
      const keys = universal.map((edge) => `${edge.to}|${edge.edgeKind === 'cleanup' ? edge.guardId : ''}`).sort();
      expect(keys, type).toEqual(goldenUniversalKeys(type));
    }

    const [cancel, cleanup] = EXECUTOR_UNIVERSAL_EDGES;
    const refused: readonly unknown[][] = [
      [cleanup, cancel],
      [cancel, { ...cleanup, guardId: 'pr-url-exists' }],
      [cancel],
    ];
    for (const universal of refused) {
      const document = rawClone('oneshot');
      extensionOf(document).universal = universal;
      expect(validateBuiltInDefinition('oneshot', document), JSON.stringify(universal)).toEqual([
        { rule: 'built-in-universal', path: ['exarchos', 'universal'] },
      ]);
    }
  });

  /** Each loaded definition is frozen at every level, so no caller can change a built-in workflow. */
  it('BuiltInDefinitions_EachDefinition_IsDeepFrozen', () => {
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const objects = nestedObjects(builtInDefinition(type));
      expect(objects.length, type).toBeGreaterThan(30);
      expect(objects.filter((value) => !Object.isFrozen(value)), type).toEqual([]);
    }
    const groups = builtInDefinition('feature').exarchos.groups;
    expect(() => Object.defineProperty(groups, 'extra', { value: 1 })).toThrow(TypeError);
  });

  /** The kernel copy has no `exarchos` key, and it equals the lowered kernel that the golden recorded. The copy does not change the definition. */
  it('BuiltInDefinitions_TheKernelCopy_HoldsNoExtensionKey', () => {
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const definition = builtInDefinition(type);
      const kernel = kernelOf(definition);
      expect(Object.hasOwn(kernel, 'exarchos'), type).toBe(false);
      expect(kernel, type).toStrictEqual(JSON.parse(String(goldenWorkflow(type).kernel)));
      expect(Object.isFrozen(kernel), type).toBe(false);
      expect(Object.hasOwn(definition, 'exarchos'), type).toBe(true);
    }
  });

  /** Only the five roster names are built-in types. A near name, a prototype key or a value that is not a string is not one. */
  it('BuiltInDefinitions_ANameOutsideTheRoster_IsNotABuiltInType', () => {
    expect(BUILT_IN_WORKFLOW_TYPES).toEqual(['feature', 'debug', 'refactor', 'oneshot', 'discovery']);
    for (const type of BUILT_IN_WORKFLOW_TYPES) expect(isBuiltInDefinitionType(type), type).toBe(true);
    for (const value of ['custom', 'Feature', 'feature ', '', 'toString', '__proto__', 'constructor', undefined, null, 1]) {
      expect(isBuiltInDefinitionType(value), String(value)).toBe(false);
    }
  });

  /**
   * A raw set with one fault in two documents throws one error. The error names the type, the rule and the path of each finding.
   * The feature file loses the edge of `plan->plan-review`, and the debug file loses its cleanup edge.
   */
  it('BuiltInDefinitions_ABrokenRawSet_ThrowsAndNamesEachRuleAndPath', () => {
    const raws = cloneAll();
    delete recordAt(extensionOf(raws.feature).edges, 'edges')['plan->plan-review'];
    const debugExtension = extensionOf(raws.debug);
    debugExtension.universal = listAt(debugExtension.universal, 'universal').filter(
      (edge) => !isRecord(edge) || edge.edgeKind !== 'cleanup',
    );

    const message = thrownMessage(() => loadBuiltInDefinitions(raws));
    expect(message).toBeDefined();
    expect(message).toContain('feature edge-keys exarchos.edges');
    expect(message).toContain('debug built-in-universal exarchos.universal');
    expect(findingLines(message)).toEqual([
      'feature edge-keys exarchos.edges.plan->plan-review',
      'debug built-in-universal exarchos.universal',
    ]);
  });

  /** The loader gives the five definitions of the module load for unchanged clones of the five files, in roster order. */
  it('BuiltInDefinitions_TheFiveImports_LoadWithNoFinding', () => {
    const loaded = loadBuiltInDefinitions(cloneAll());
    expect([...loaded.keys()]).toEqual(BUILT_IN_WORKFLOW_TYPES);
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const definition = loaded.get(type);
      expect(definition, type).toStrictEqual(builtInDefinition(type));
      expect(Object.isFrozen(definition), type).toBe(true);
    }
  });

  /** The kernel schema accepts a terminal step id. A built-in definition holds none, so the load refuses the key and returns no map. */
  it('BuiltInDefinitions_ATerminalStepId_IsABuiltInEntryFinding', () => {
    const document = rawClone('feature');
    expect(Object.hasOwn(document, 'terminalStepId')).toBe(false);
    document.terminalStepId = 'completed';
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature built-in-entry terminalStepId'],
      loadedTypes: [],
    });
  });

  /** The kernel schema accepts any step type. The load refuses a step type that is not a phase kind or `final`, at the path of that step. */
  it('BuiltInDefinitions_AnUnknownStepType_IsAStepTypeFinding', () => {
    const document = rawClone('feature');
    const step = recordAt(listAt(document.steps, 'steps')[1], 'steps.1');
    expect(step.stepType).toBe('PLAN');
    step.stepType = 'bogus-kind';
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature built-in-step-type steps.1.stepType'],
      loadedTypes: [],
    });
  });

  /**
   * A fix-cycle edge leaves a member of a group. The extension schema accepts the flag on `plan->plan-review`.
   * The step `plan` is in no group, so the load refuses the flag.
   */
  it('BuiltInDefinitions_AFixCycleFlagOutsideTheFixLoop_IsAnEdgeFinding', () => {
    const document = rawClone('feature');
    const edge = recordAt(recordAt(extensionOf(document).edges, 'edges')['plan->plan-review'], 'edge');
    expect(edge.isFixCycle).toBeUndefined();
    edge.isFixCycle = true;
    expect(parseExtension(document).ok).toBe(true);

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature built-in-edge exarchos.edges.plan->plan-review.isFixCycle'],
      loadedTypes: [],
    });
  });

  /** A built-in edge omits the route that is always legal. The extension schema accepts that route when it is explicit, so the load refuses it. */
  it('BuiltInDefinitions_AnExplicitAlwaysLegalRoute_IsAnEdgeFinding', () => {
    const document = rawClone('feature');
    const edge = recordAt(recordAt(extensionOf(document).edges, 'edges')['plan->plan-review'], 'edge');
    expect(edge.route).toBeUndefined();
    edge.route = { kind: 'all', operands: [] };
    expect(parseExtension(document).ok).toBe(true);

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature built-in-edge exarchos.edges.plan->plan-review.route'],
      loadedTypes: [],
    });
  });

  /**
   * A document that fails the kernel parse gives a kernel-schema finding at the path of the schema issue.
   * The failed parse ends the checks of that document, so no finding of the built-in rules follows it.
   */
  it('BuiltInDefinitions_AKernelSchemaFinding_IsThrownAtLoad', () => {
    const document = rawClone('feature');
    delete document.steps;
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(false);
    expect(validateBuiltInDefinition('feature', document)).toEqual([
      { rule: 'built-in-step-keys', path: ['steps'] },
      { rule: 'built-in-entry', path: ['entryStepId'] },
    ]);

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature kernel-schema steps'],
      loadedTypes: [],
    });
  });

  /** A key outside the strict extension schema gives an extension-schema finding at its path. The built-in rules alone give no finding for that key. */
  it('BuiltInDefinitions_AnExtensionSchemaFinding_IsThrownAtLoad', () => {
    const document = rawClone('feature');
    extensionOf(document).bogus = 1;
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);
    expect(validateBuiltInDefinition('feature', document)).toEqual([]);

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature extension-schema exarchos.bogus'],
      loadedTypes: [],
    });
  });

  /**
   * One document with two faults gives one finding line for each fault. The finding of the reference rule comes first.
   * The feature file loses the edge of `plan->plan-review`, and one of its steps gets a stray key.
   */
  it('BuiltInDefinitions_TwoFindingsInOneDocument_AreBothNamed', () => {
    const document = rawClone('feature');
    delete recordAt(extensionOf(document).edges, 'edges')['plan->plan-review'];
    recordAt(listAt(document.steps, 'steps')[2], 'steps.2').note = 'free text';

    expect(loadWithFeature(document)).toEqual({
      findings: ['feature edge-keys exarchos.edges.plan->plan-review', 'feature built-in-step-keys steps.2.note'],
      loadedTypes: [],
    });
  });
});
