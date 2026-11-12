// These tests check the rules of a user workflow definition. A user file passes the shape rules of
// the built-in files under the prefix `user`, and eight user rules.
// Each case changes one part of the fixture `release-check` and states the findings that it expects.
// A kernel-shape case first shows that the kernel parse and the extension parse accept its document.
//
// @oracle-sources: ../../../../src/workflow/definitions/user.ts, ../../../helpers/definitions/user-definition.ts

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { describe, expect, it } from 'vitest';

import debug from '../../../../src/workflow/definitions/debug.workflow.json' with { type: 'json' };
import discovery from '../../../../src/workflow/definitions/discovery.workflow.json' with { type: 'json' };
import {
  parseExtension,
  StepIdSchema,
  type DefinitionFinding,
} from '../../../../src/workflow/definitions/extension.js';
import feature from '../../../../src/workflow/definitions/feature.workflow.json' with { type: 'json' };
import oneshot from '../../../../src/workflow/definitions/oneshot.workflow.json' with { type: 'json' };
import refactor from '../../../../src/workflow/definitions/refactor.workflow.json' with { type: 'json' };
import { checkUserDefinition, validateUserDefinition } from '../../../../src/workflow/definitions/user.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

/** A kebab step id of 257 characters. It matches the step-id pattern and is one character above the bound. */
const LONG_STEP_ID = `build-${'x'.repeat(251)}`;

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

/** A fresh clone of the fixture document. */
function fixture(): Record<string, unknown> {
  return structuredClone(releaseCheckDefinition());
}

/** The extension of a raw document. */
function extensionOf(document: Record<string, unknown>): Record<string, unknown> {
  return recordAt(document.exarchos, 'exarchos');
}

/** The edge of a raw document with the transition id. */
function edgeAt(document: Record<string, unknown>, transitionId: string): Record<string, unknown> {
  return recordAt(recordAt(extensionOf(document).edges, 'exarchos.edges')[transitionId], transitionId);
}

/** The obligation of the edge with the transition id. */
function obligationAt(document: Record<string, unknown>, transitionId: string): Record<string, unknown> {
  return recordAt(edgeAt(document, transitionId).obligation, `${transitionId}.obligation`);
}

/** The step of a raw document at the index. */
function stepAt(document: Record<string, unknown>, index: number): Record<string, unknown> {
  return recordAt(listAt(document.steps, 'steps')[index], `steps.${index}`);
}

/** The transition of a raw document at the index. */
function transitionAt(document: Record<string, unknown>, index: number): Record<string, unknown> {
  return recordAt(listAt(document.transitions, 'transitions')[index], `transitions.${index}`);
}

/**
 * Renames one step in its step id, its step name, each transition, the entry and each edge key. So the
 * kernel parse, the extension parse and the reference rules still accept the document.
 */
function renameStep(document: Record<string, unknown>, from: string, to: string): void {
  const rename = (id: unknown): unknown => (id === from ? to : id);
  for (const item of listAt(document.steps, 'steps')) {
    const step = recordAt(item, 'step');
    if (step.stepId !== from) continue;
    step.stepId = to;
    step.stepName = to;
  }
  for (const item of listAt(document.transitions, 'transitions')) {
    const transition = recordAt(item, 'transition');
    transition.fromStepId = rename(transition.fromStepId);
    transition.toStepId = rename(transition.toStepId);
    transition.transitionId = `${String(transition.fromStepId)}->${String(transition.toStepId)}`;
  }
  document.entryStepId = rename(document.entryStepId);
  const extension = extensionOf(document);
  extension.edges = Object.fromEntries(
    Object.entries(recordAt(extension.edges, 'exarchos.edges')).map(([key, edge]) => [
      key
        .split('->')
        .map((part) => (part === from ? to : part))
        .join('->'),
      edge,
    ]),
  );
}

/** Asserts that the kernel parse and the strict extension parse both accept the document. */
function expectBothParsesPass(document: Record<string, unknown>): void {
  expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);
  expect(parseExtension(document).ok).toBe(true);
}

/** The result of a refused check with exactly the given findings. */
function refusedWith(...findings: DefinitionFinding[]): { ok: false; findings: DefinitionFinding[] } {
  return { ok: false, findings };
}

describe('the rules of a user workflow definition', () => {
  /** The fixture passes the check path with the user rules, and the user rules alone give no finding. */
  it('UserDefinition_TheFixture_PassesEveryRule', () => {
    const document = fixture();
    expectBothParsesPass(document);

    expect(validateUserDefinition(document)).toEqual([]);
    expect(checkUserDefinition(document)).toStrictEqual({ ok: true, definition: releaseCheckDefinition() });
  });

  /** A user file cannot take the name of a built-in type. */
  it('UserDefinition_ABuiltInName_IsRefused', () => {
    const document = fixture();
    document.name = 'feature';

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-name', path: ['name'] }));
  });

  /** The name of a user type is lowercase kebab case. */
  it('UserDefinition_ANameOutsideKebabCase_IsRefused', () => {
    for (const name of ['Release_Check', 'exarchos.release-check', 'release--check']) {
      const document = fixture();
      document.name = name;

      expect(checkUserDefinition(document), name).toStrictEqual(refusedWith({ rule: 'user-name', path: ['name'] }));
    }
  });

  /** `constructor` is kebab case, but a per-type table gives a function for it. So the rule refuses each own key of `Object.prototype`. */
  it('UserDefinition_APrototypeKeyName_IsRefused', () => {
    const document = fixture();
    document.name = 'constructor';

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-name', path: ['name'] }));
  });

  /**
   * A condition is a node of the closed AST. A `command` key in an operand of the gate presence fails the
   * extension parse. The union of strict arms refuses the outermost node of the presence.
   */
  it('UserDefinition_AConditionWithACommandKey_IsAnExtensionFinding', () => {
    const document = fixture();
    const presence = recordAt(obligationAt(document, 'build->verify').presence, 'presence');
    recordAt(listAt(presence.operands, 'operands')[0], 'operand').command = 'rm -rf /';
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'extension-schema', path: ['exarchos', 'edges', 'build->verify', 'obligation', 'presence'] }),
    );
  });

  /** A route over an undeclared event and a presence over an undeclared fact each give a condition finding at their path. */
  it('UserDefinition_AnUndeclaredFact_IsAConditionFinding', () => {
    const document = fixture();
    edgeAt(document, 'scope->build').route = { kind: 'eventObserved', event: 'release.requested' };
    obligationAt(document, 'verify->completed').presence = { kind: 'factEquals', field: 'release.approved', value: true };
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith(
        { rule: 'user-condition', path: ['exarchos', 'edges', 'scope->build', 'route'] },
        { rule: 'user-condition', path: ['exarchos', 'edges', 'verify->completed', 'obligation', 'presence'] },
      ),
    );
  });

  /** A user edge names no guard id, because a guard id binds a legacy guard. */
  it('UserDefinition_AGuardId_IsRefused', () => {
    const document = fixture();
    edgeAt(document, 'build->verify').guardId = 'all-tasks-complete';
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'user-edge', path: ['exarchos', 'edges', 'build->verify', 'guardId'] }),
    );
  });

  /** The schema requires a guard id on a `cleanup` universal edge. So a user file holds a `cancel` universal edge only. */
  it('UserDefinition_ACleanupUniversal_IsRefused', () => {
    const document = fixture();
    listAt(extensionOf(document).universal, 'universal').push({
      edgeKind: 'cleanup',
      to: 'completed',
      guardId: 'merge-verified',
    });
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'user-universal', path: ['exarchos', 'universal', 1, 'guardId'] }),
    );
  });

  /** The kernel accepts an empty authority category. The capsule refuses it, so the user rule refuses it at the read. */
  it('UserDefinition_AnEmptyAuthorityCategory_IsRefused', () => {
    const document = fixture();
    recordAt(document.authority, 'authority').delegatedDecisions = [];
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-authority', path: ['authority'] }));
  });

  /** Each step is a step of the `exarchos` runtime. The kernel accepts the `strategos` runtime. */
  it('UserDefinition_AStrategosRuntime_IsRefused', () => {
    const document = fixture();
    stepAt(document, 1).runtime = 'strategos';
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'user-step-keys', path: ['steps', 1, 'runtime'] }),
    );
  });

  /** The kernel keeps a `completion` key on a skill step. The exact step keys refuse it. */
  it('UserDefinition_ACompletionOnAStep_IsRefused', () => {
    const document = fixture();
    stepAt(document, 1).completion = { predicate: { kind: 'true' }, expression: 'true' };
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'user-step-keys', path: ['steps', 1, 'completion'] }),
    );
  });

  /** Each optional kernel key that a user file does not hold takes a kernel-valid value, and it gives one entry finding at its key. */
  it.each([
    ['terminalStepId', 'completed'],
    ['gates', []],
    ['diagnosticForks', []],
    ['contentHash', '0123456789abcdef'.repeat(4)],
  ])('UserDefinition_%s_AForbiddenKernelKey_IsRefused', (key, value) => {
    const document = fixture();
    document[key] = value;
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-entry', path: [key] }));
  });

  /** Each kernel list takes one item with the required fields of its kernel schema, and it gives one entry finding at its key. */
  it.each([
    ['branchPoints', { branchPointId: 'release-route', fromStepId: 'scope', paths: [] }],
    ['loops', { loopId: 'release-retry', loopName: 'release-retry', fromStepId: 'build', maxIterations: 3, bodySteps: [] }],
    ['forkPoints', { forkPointId: 'release-split', fromStepId: 'scope', paths: [], joinStepId: 'verify' }],
    ['failureHandlers', { handlerId: 'release-failure', scope: 'workflow', steps: [], isTerminal: false }],
    ['approvalPoints', { approvalPointId: 'release-approval', approverType: 'human', precedingStepId: 'verify' }],
  ])('UserDefinition_%s_ANonEmptyKernelList_IsRefused', (key, item) => {
    const document = fixture();
    document[key] = [item];
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-entry', path: [key] }));
  });

  /** The entry step is not terminal. */
  it('UserDefinition_ATerminalEntry_IsRefused', () => {
    const document = fixture();
    document.entryStepId = 'completed';
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-entry', path: ['entryStepId'] }));
  });

  /** Only a `final` step is terminal. */
  it('UserDefinition_ATerminalFlagOnANonFinalStep_IsRefused', () => {
    const document = fixture();
    stepAt(document, 1).isTerminal = true;
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'user-step-type', path: ['steps', 1, 'isTerminal'] }),
    );
  });

  /** No reader of a user type reads a group, so the group list is empty. The group of the case passes each reference rule. */
  it('UserDefinition_ANonEmptyGroupList_IsRefused', () => {
    const document = fixture();
    extensionOf(document).groups = [
      { groupId: 'release', members: ['build', 'verify'], initial: 'build', history: 'shallow' },
    ];
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(refusedWith({ rule: 'user-groups', path: ['exarchos', 'groups'] }));
  });

  /**
   * No reader of a user type reads an effect or an edge flag. A fix-cycle edge also leaves no group member,
   * because a user file holds no group. So that row also gives the edge finding at the same key.
   */
  it.each([
    ['effects', ['checkpoint'], ['user-edge-flags']],
    ['isFixCycle', true, ['user-edge', 'user-edge-flags']],
    ['isRevision', true, ['user-edge-flags']],
  ])('UserDefinition_%s_OnAnEdge_IsRefused', (key, value, rules) => {
    const document = fixture();
    edgeAt(document, 'build->verify')[key] = value;
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith(...rules.map((rule) => ({ rule, path: ['exarchos', 'edges', 'build->verify', key] }))),
    );
  });

  /** Each step id matches the step-id pattern with at most 256 characters, so the capsule can hold it as a stable id. */
  it.each([
    ['_build', '_build'],
    ['AKebabIdOf257Characters', LONG_STEP_ID],
  ])('UserDefinition_%s_AStepIdOutsideTheIdClass_IsRefused', (_label, stepId) => {
    expect(LONG_STEP_ID).toHaveLength(257);
    expect(StepIdSchema.safeParse(LONG_STEP_ID).success).toBe(true);
    const document = fixture();
    renameStep(document, 'build', stepId);
    expect(transitionAt(document, 0).transitionId).toBe(`scope->${stepId}`);
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith({ rule: 'user-step-id', path: ['steps', 1, 'stepId'] }),
    );
  });

  /**
   * Each built-in file passes each parse, each reference rule and each kernel-shape rule under the user
   * prefix. The user rules refuse only the parts of the extension that a user file does not hold.
   */
  it('UserDefinition_EachBuiltInFile_FailsNoKernelShapeRule', () => {
    const rules = new Set<string>();
    for (const raw of [feature, debug, refactor, oneshot, discovery]) {
      const checked = checkUserDefinition(structuredClone(raw));
      expect(checked.ok, raw.name).toBe(false);
      for (const finding of checked.ok ? [] : checked.findings) rules.add(finding.rule);
    }

    expect([...rules].sort()).toEqual(['user-edge', 'user-edge-flags', 'user-groups', 'user-name', 'user-universal']);
  });

  /**
   * One document breaks each user rule and each shape rule once. Each finding names its rule and its path.
   * The findings come in rule order: the name, the shape rules, the step ids and the authority. Then come
   * the edges, the edge flags, the groups, the universal edges and the conditions.
   */
  it('UserDefinition_EachFinding_NamesItsRuleAndPath', () => {
    const document = fixture();
    document.name = 'Release Check';
    stepAt(document, 0).note = 'free text';
    stepAt(document, 2).stepType = 'BOGUS';
    transitionAt(document, 0).isDefault = true;
    document.terminalStepId = 'completed';
    renameStep(document, 'scope', 'Scope');
    recordAt(document.authority, 'authority').delegatedDecisions = [];
    edgeAt(document, 'build->verify').guardId = 'all-tasks-complete';
    edgeAt(document, 'verify->completed').isRevision = true;
    extensionOf(document).groups = [
      { groupId: 'release', members: ['build', 'verify'], initial: 'build', history: 'shallow' },
    ];
    listAt(extensionOf(document).universal, 'universal').push({
      edgeKind: 'cleanup',
      to: 'completed',
      guardId: 'merge-verified',
    });
    edgeAt(document, 'Scope->build').route = { kind: 'factEquals', field: 'release.ready', value: true };
    expectBothParsesPass(document);

    expect(checkUserDefinition(document)).toStrictEqual(
      refusedWith(
        { rule: 'user-name', path: ['name'] },
        { rule: 'user-step-keys', path: ['steps', 0, 'note'] },
        { rule: 'user-step-type', path: ['steps', 2, 'stepType'] },
        { rule: 'user-transition', path: ['transitions', 0, 'isDefault'] },
        { rule: 'user-entry', path: ['terminalStepId'] },
        { rule: 'user-step-id', path: ['steps', 0, 'stepId'] },
        { rule: 'user-authority', path: ['authority'] },
        { rule: 'user-edge', path: ['exarchos', 'edges', 'build->verify', 'guardId'] },
        { rule: 'user-edge-flags', path: ['exarchos', 'edges', 'verify->completed', 'isRevision'] },
        { rule: 'user-groups', path: ['exarchos', 'groups'] },
        { rule: 'user-universal', path: ['exarchos', 'universal', 1, 'guardId'] },
        { rule: 'user-condition', path: ['exarchos', 'edges', 'Scope->build', 'route'] },
      ),
    );
  });
});
