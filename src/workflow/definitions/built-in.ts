/**
 * The five built-in workflow definitions, loaded from their checked-in files.
 *
 * RESERVED(issue: #1927, owner: exarchos, expires: 2026-12-31)
 *
 * Each file is one kernel definition with one more top-level key, `exarchos`. At module load, the
 * loader parses each file with the loose kernel schema and with the strict extension schema. Then it
 * runs the reference rules and the built-in rules. A finding stops the load with one error that
 * names the type, the rule and the path of each finding. So a build with a bad file does not start.
 *
 * The built-in rules hold for these five definitions only. The kernel schema keeps a stray key in a
 * step or a transition, so the built-in rules require the exact key set of each.
 *
 * Each file maps to its type by one explicit import, and no other path builds a definition.
 */

import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@lvlup-sw/strategos-contracts';

import { builtInWorkflowAuthority } from '../../verbs/prepare/built-in-authority.js';
import { KIND_OBLIGATIONS, type PhaseKind } from '../phase-kind.js';
import {
  parseExtension,
  validateExtension,
  type DefinitionFinding,
  type ExarchosExtension,
} from './extension.js';
import debug from './debug.workflow.json' with { type: 'json' };
import discovery from './discovery.workflow.json' with { type: 'json' };
import feature from './feature.workflow.json' with { type: 'json' };
import oneshot from './oneshot.workflow.json' with { type: 'json' };
import refactor from './refactor.workflow.json' with { type: 'json' };

/** The name of a built-in workflow type. */
export type BuiltInWorkflowType = 'feature' | 'debug' | 'refactor' | 'oneshot' | 'discovery';

/** The roster of the built-in workflow types, in registry order. */
export const BUILT_IN_WORKFLOW_TYPES: readonly BuiltInWorkflowType[] = Object.freeze([
  'feature',
  'debug',
  'refactor',
  'oneshot',
  'discovery',
]);

/** A loaded built-in definition: the parsed kernel with its parsed extension. The loader deep-freezes it. */
export type BuiltInDefinition = WorkflowDefinitionV1 & { readonly exarchos: ExarchosExtension };

/** The key of the extension in a definition document. */
const EXTENSION_KEY = 'exarchos';

/** The exact key set of a built-in step. */
const STEP_KEYS: readonly string[] = ['kind', 'stepId', 'stepName', 'isTerminal', 'runtime', 'stepType'];

/** The exact key set of a built-in transition. */
const TRANSITION_KEYS: readonly string[] = ['transitionId', 'fromStepId', 'toStepId', 'isDefault'];

/** The optional kernel keys that a built-in definition does not hold. */
const ABSENT_KERNEL_KEYS: readonly string[] = ['terminalStepId', 'gates', 'diagnosticForks', 'contentHash'];

/** The kernel list keys that are empty in a built-in definition. */
const EMPTY_KERNEL_LISTS: readonly string[] = [
  'branchPoints',
  'loops',
  'forkPoints',
  'failureHandlers',
  'approvalPoints',
];

/** The route that is always legal. A built-in edge with this route omits the `route` key. */
const ALWAYS_LEGAL_ROUTE = { kind: 'all', operands: [] };

/** The two universal edges that the executor runs from each non-final state. */
const EXECUTOR_UNIVERSAL_EDGES: readonly Record<string, string>[] = [
  { edgeKind: 'cancel', to: 'cancelled' },
  { edgeKind: 'cleanup', to: 'completed', guardId: 'merge-verified' },
];

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as a list, or `undefined` when it is not a list. */
function listOf(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** True when the value is a phase kind, a key of the obligation table. */
function isPhaseKind(value: unknown): value is PhaseKind {
  return typeof value === 'string' && Object.hasOwn(KIND_OBLIGATIONS, value);
}

/** True when two JSON values are equal. The key order of an object does not matter. */
function sameJson(left: unknown, right: unknown): boolean {
  const leftItems = listOf(left);
  const rightItems = listOf(right);
  if (leftItems !== undefined || rightItems !== undefined) {
    if (leftItems === undefined || rightItems === undefined || leftItems.length !== rightItems.length) {
      return false;
    }
    return leftItems.every((item, index) => sameJson(item, rightItems[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

/** Converts one key of a zod issue path into a key of a finding path. */
function pathKey(key: PropertyKey): string | number {
  return typeof key === 'symbol' ? String(key) : key;
}

/**
 * Returns one finding for each key of an object that is not in the key set. It also returns one
 * finding for each key of the set that the object does not hold. A value that is not an object gives
 * one finding at its path.
 */
function exactKeyFindings(
  rule: string,
  value: unknown,
  keys: readonly string[],
  at: readonly (string | number)[],
): DefinitionFinding[] {
  if (!isRecord(value)) return [{ rule, path: at }];
  const stray = Object.keys(value).filter((key) => !keys.includes(key));
  const absent = keys.filter((key) => !Object.hasOwn(value, key));
  return [...stray, ...absent].map((key) => ({ rule, path: [...at, key] }));
}

/**
 * The `built-in-step-keys` and `built-in-step-type` rules. Each step has the exact key set, is a
 * `skill` step of the `exarchos` runtime, and has its id as its name. Its `stepType` is a phase kind
 * or `final`, and only a `final` step is terminal. A value check runs only when the step holds the key,
 * so an absent key gives one finding.
 */
function stepFindings(steps: readonly unknown[]): DefinitionFinding[] {
  const keyFindings: DefinitionFinding[] = [];
  const typeFindings: DefinitionFinding[] = [];
  steps.forEach((step, index) => {
    const at = ['steps', index];
    keyFindings.push(...exactKeyFindings('built-in-step-keys', step, STEP_KEYS, at));
    if (!isRecord(step)) return;
    const has = (key: string): boolean => Object.hasOwn(step, key);
    if (has('kind') && step.kind !== 'skill') keyFindings.push({ rule: 'built-in-step-keys', path: [...at, 'kind'] });
    if (has('runtime') && step.runtime !== 'exarchos') {
      keyFindings.push({ rule: 'built-in-step-keys', path: [...at, 'runtime'] });
    }
    if (has('stepName') && has('stepId') && step.stepName !== step.stepId) {
      keyFindings.push({ rule: 'built-in-step-keys', path: [...at, 'stepName'] });
    }
    const isFinal = step.stepType === 'final';
    if (has('stepType') && !isFinal && !isPhaseKind(step.stepType)) {
      typeFindings.push({ rule: 'built-in-step-type', path: [...at, 'stepType'] });
    }
    if (has('isTerminal') && step.isTerminal !== isFinal) {
      typeFindings.push({ rule: 'built-in-step-type', path: [...at, 'isTerminal'] });
    }
  });
  return [...keyFindings, ...typeFindings];
}

/**
 * The `built-in-transition` rule. Each transition has the exact key set, its id is
 * `<fromStepId>-><toStepId>`, and it is not a default transition. A value check runs only when the
 * transition holds its keys, so an absent key gives one finding.
 */
function transitionFindings(transitions: readonly unknown[]): DefinitionFinding[] {
  return transitions.flatMap((transition, index) => {
    const at = ['transitions', index];
    const findings = exactKeyFindings('built-in-transition', transition, TRANSITION_KEYS, at);
    if (!isRecord(transition)) return findings;
    const has = (key: string): boolean => Object.hasOwn(transition, key);
    const { transitionId, fromStepId, toStepId, isDefault } = transition;
    const endpointsHeld = has('transitionId') && has('fromStepId') && has('toStepId');
    if (endpointsHeld && transitionId !== `${String(fromStepId)}->${String(toStepId)}`) {
      findings.push({ rule: 'built-in-transition', path: [...at, 'transitionId'] });
    }
    if (has('isDefault') && isDefault !== false) {
      findings.push({ rule: 'built-in-transition', path: [...at, 'isDefault'] });
    }
    return findings;
  });
}

/**
 * The `built-in-entry` rule. The entry step is a non-terminal step. The definition holds no terminal
 * step id, no gates, no diagnostic forks and no content hash, and its five list keys are empty.
 */
function entryFindings(raw: Record<string, unknown>, steps: readonly unknown[]): DefinitionFinding[] {
  const findings: DefinitionFinding[] = [];
  const entry = steps.find((step) => isRecord(step) && step.stepId === raw.entryStepId);
  if (typeof raw.entryStepId !== 'string' || !isRecord(entry) || entry.isTerminal !== false) {
    findings.push({ rule: 'built-in-entry', path: ['entryStepId'] });
  }
  for (const key of ABSENT_KERNEL_KEYS) {
    if (Object.hasOwn(raw, key)) findings.push({ rule: 'built-in-entry', path: [key] });
  }
  for (const key of EMPTY_KERNEL_LISTS) {
    if (listOf(raw[key])?.length !== 0) findings.push({ rule: 'built-in-entry', path: [key] });
  }
  return findings;
}

/** Returns the source step id of the kernel transition with the given id, or `undefined`. */
function sourceOf(transitions: readonly unknown[], transitionId: string): unknown {
  const transition = transitions.find((entry) => isRecord(entry) && entry.transitionId === transitionId);
  return isRecord(transition) ? transition.fromStepId : undefined;
}

/**
 * The `built-in-edge` rule. Every edge has a guard id. A fix-cycle edge leaves a member of a group.
 * An edge with the route that is always legal omits the route.
 */
function edgeFindings(extension: Record<string, unknown>, transitions: readonly unknown[]): DefinitionFinding[] {
  const edges = extension.edges;
  if (!isRecord(edges)) return [{ rule: 'built-in-edge', path: [EXTENSION_KEY, 'edges'] }];
  const members = new Set(
    (listOf(extension.groups) ?? []).flatMap((group) => (isRecord(group) ? listOf(group.members) ?? [] : [])),
  );
  const findings: DefinitionFinding[] = [];
  for (const [transitionId, edge] of Object.entries(edges)) {
    const at = [EXTENSION_KEY, 'edges', transitionId];
    if (!isRecord(edge)) {
      findings.push({ rule: 'built-in-edge', path: at });
      continue;
    }
    if (typeof edge.guardId !== 'string') findings.push({ rule: 'built-in-edge', path: [...at, 'guardId'] });
    if (edge.isFixCycle === true && !members.has(sourceOf(transitions, transitionId))) {
      findings.push({ rule: 'built-in-edge', path: [...at, 'isFixCycle'] });
    }
    if (edge.route !== undefined && sameJson(edge.route, ALWAYS_LEGAL_ROUTE)) {
      findings.push({ rule: 'built-in-edge', path: [...at, 'route'] });
    }
  }
  return findings;
}

/**
 * Runs the built-in rules over one raw definition document and returns every finding, in rule order.
 * The rules read the raw document, so a stray key in a step or a transition is visible. A part of the
 * document that is absent or of the wrong shape gives a finding at its path.
 */
export function validateBuiltInDefinition(type: BuiltInWorkflowType, raw: unknown): readonly DefinitionFinding[] {
  const document = isRecord(raw) ? raw : {};
  const extensionValue = document[EXTENSION_KEY];
  const extension = isRecord(extensionValue) ? extensionValue : {};
  const steps = listOf(document.steps);
  const transitions = listOf(document.transitions);
  return [
    ...(document.name === `exarchos.${type}` ? [] : [{ rule: 'built-in-name', path: ['name'] }]),
    ...(steps === undefined ? [{ rule: 'built-in-step-keys', path: ['steps'] }] : stepFindings(steps)),
    ...(transitions === undefined
      ? [{ rule: 'built-in-transition', path: ['transitions'] }]
      : transitionFindings(transitions)),
    ...entryFindings(document, steps ?? []),
    ...(sameJson(document.authority, builtInWorkflowAuthority())
      ? []
      : [{ rule: 'built-in-authority', path: ['authority'] }]),
    ...edgeFindings(extension, transitions ?? []),
    ...(sameJson(extension.universal, EXECUTOR_UNIVERSAL_EDGES)
      ? []
      : [{ rule: 'built-in-universal', path: [EXTENSION_KEY, 'universal'] }]),
  ];
}

/** The result of the checks of one raw document: the definition, or the findings. */
type DocumentCheck =
  | { readonly ok: true; readonly definition: BuiltInDefinition }
  | { readonly ok: false; readonly findings: readonly DefinitionFinding[] };

/**
 * Checks one raw document: the kernel parse, the strict extension parse, the reference rules and the
 * built-in rules. A failed parse ends the checks of the document. The reference rules run after the
 * extension parse, because one function runs all four of them.
 */
function checkDocument(type: BuiltInWorkflowType, raw: unknown): DocumentCheck {
  const kernel = WorkflowDefinitionV1Schema.safeParse(raw);
  if (!kernel.success) {
    return {
      ok: false,
      findings: kernel.error.issues.map((issue) => ({ rule: 'kernel-schema', path: issue.path.map(pathKey) })),
    };
  }
  const parsed = parseExtension(raw);
  if (!parsed.ok) return { ok: false, findings: parsed.findings };
  const findings = [...validateExtension(raw, kernel.data, parsed.extension), ...validateBuiltInDefinition(type, raw)];
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, definition: { ...kernel.data, exarchos: parsed.extension } };
}

/** Freezes a value and every object and list inside it. */
function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  Object.freeze(value);
  const children: readonly unknown[] = Object.values(value);
  for (const child of children) deepFreeze(child);
}

/**
 * Checks the raw document of each built-in type, in roster order, and returns the five definitions.
 * The function collects the findings of all five documents. With no finding, it deep-freezes each
 * definition.
 * @throws When a document has a finding. The message holds one line `<type> <rule> <path>` for each
 * finding, with the path keys joined by `.`.
 */
export function loadBuiltInDefinitions(
  raws: Readonly<Record<BuiltInWorkflowType, unknown>>,
): ReadonlyMap<BuiltInWorkflowType, BuiltInDefinition> {
  const lines: string[] = [];
  const definitions = new Map<BuiltInWorkflowType, BuiltInDefinition>();
  for (const type of BUILT_IN_WORKFLOW_TYPES) {
    const checked = checkDocument(type, raws[type]);
    if (checked.ok) {
      definitions.set(type, checked.definition);
      continue;
    }
    for (const finding of checked.findings) lines.push(`${type} ${finding.rule} ${finding.path.join('.')}`);
  }
  if (lines.length > 0) {
    throw new Error(`the built-in workflow definitions fail their checks:\n${lines.join('\n')}`);
  }
  for (const definition of definitions.values()) deepFreeze(definition);
  return definitions;
}

/** The five built-in definitions. The module load checks the five files, so a bad file stops the load. */
const BUILT_IN_DEFINITIONS = loadBuiltInDefinitions({ feature, debug, refactor, oneshot, discovery });

/** True when the value names a built-in workflow type of the roster. */
export function isBuiltInDefinitionType(value: unknown): value is BuiltInWorkflowType {
  return BUILT_IN_WORKFLOW_TYPES.some((type) => type === value);
}

/**
 * Returns the frozen definition of a built-in workflow type.
 * @throws When the type has no loaded definition. The module load makes this impossible for a roster type.
 */
export function builtInDefinition(type: BuiltInWorkflowType): BuiltInDefinition {
  const definition = BUILT_IN_DEFINITIONS.get(type);
  if (definition === undefined) throw new Error(`the built-in workflow type '${type}' has no definition`);
  return definition;
}

/** Returns a deep copy of a definition without its `exarchos` key: the kernel part only. */
export function kernelOf(definition: BuiltInDefinition): WorkflowDefinitionV1 {
  const { exarchos: _extension, ...kernel } = definition;
  return structuredClone(kernel);
}
