// These tests check the one check path of a definition document and the two shape exports of the
// built-in rules. The check path runs the kernel parse, the strict extension parse, the reference
// rules and the own rules of a source, in that order.
// Each document is written by hand in this file, and each test states the findings that it expects.
// The built-in loader must give the findings of the same check path, in the order of the built-in rules.
//
// @oracle-sources: ../../../../src/workflow/definitions/extension.ts, the hand-written documents and expected findings in this file

import { describe, expect, it } from 'vitest';

import {
  edgeShapeFindings,
  loadBuiltInDefinitions,
  shapeFindings,
  validateBuiltInDefinition,
} from '../../../../src/workflow/definitions/built-in.js';
import debug from '../../../../src/workflow/definitions/debug.workflow.json' with { type: 'json' };
import discovery from '../../../../src/workflow/definitions/discovery.workflow.json' with { type: 'json' };
import {
  checkDefinitionDocument,
  type DefinitionFinding,
} from '../../../../src/workflow/definitions/extension.js';
import oneshot from '../../../../src/workflow/definitions/oneshot.workflow.json' with { type: 'json' };
import refactor from '../../../../src/workflow/definitions/refactor.workflow.json' with { type: 'json' };

/** The one finding that the own rules of a case give. A case uses it to see whether the own rules ran. */
const OWN_FINDING: DefinitionFinding = { rule: 'own-rule', path: [] };

/** The edge keys of the sample document, in the order of its edge record. */
const EDGE_KEYS: readonly string[] = ['plan->build', 'build->review', 'review->build', 'review->completed'];

/** The universal cancel edge. */
const CANCEL_EDGE = { edgeKind: 'cancel', to: 'cancelled' };

/** The universal cleanup edge. */
const CLEANUP_EDGE = { edgeKind: 'cleanup', to: 'completed', guardId: 'merge-verified' };

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

/** One skill step of the sample kernel. A `final` step is the only terminal step. */
function step(stepId: string, stepType: string): Record<string, unknown> {
  return {
    kind: 'skill',
    stepId,
    stepName: stepId,
    isTerminal: stepType === 'final',
    runtime: 'exarchos',
    stepType,
  };
}

/** One transition of the sample kernel, with the id `<from>-><to>`. */
function transition(from: string, to: string): Record<string, unknown> {
  return { transitionId: `${from}->${to}`, fromStepId: from, toStepId: to, isDefault: false };
}

/** One edge with a guard id and no obligation. */
function edge(guardId: string): Record<string, unknown> {
  return { guardId, category: 'route-condition', obligation: { kind: 'none' } };
}

/**
 * A fresh copy of the sample document. It passes the kernel parse, the extension parse, the reference
 * rules and each shape rule. The fix-cycle edge leaves `review`, a member of the one group.
 */
function sampleDocument(): Record<string, unknown> {
  return structuredClone({
    schemaVersion: '1.0',
    name: 'exarchos.sample',
    steps: [
      step('plan', 'PLAN'),
      step('build', 'IMPLEMENT'),
      step('review', 'REVIEW'),
      step('completed', 'final'),
      step('cancelled', 'final'),
    ],
    transitions: [
      transition('plan', 'build'),
      transition('build', 'review'),
      transition('review', 'build'),
      transition('review', 'completed'),
    ],
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
    entryStepId: 'plan',
    exarchos: {
      extensionVersion: '1',
      groups: [{ groupId: 'implementation', members: ['build', 'review'], initial: 'build', history: 'shallow' }],
      edges: {
        'plan->build': edge('plan-ready'),
        'build->review': edge('build-done'),
        'review->build': { ...edge('review-failed'), isFixCycle: true },
        'review->completed': edge('review-passed'),
      },
      universal: [CANCEL_EDGE, CLEANUP_EDGE],
    },
  });
}

/** The extension of a raw document. */
function extensionOf(document: Record<string, unknown>): Record<string, unknown> {
  return recordAt(document.exarchos, 'exarchos');
}

/** The edge record of a raw document. */
function edgesOf(document: Record<string, unknown>): Record<string, unknown> {
  return recordAt(extensionOf(document).edges, 'exarchos.edges');
}

/** The step of a raw document at the index. */
function stepAt(document: Record<string, unknown>, index: number): Record<string, unknown> {
  return recordAt(listAt(document.steps, 'steps')[index], `steps.${index}`);
}

/** The transition of a raw document at the index. */
function transitionAt(document: Record<string, unknown>, index: number): Record<string, unknown> {
  return recordAt(listAt(document.transitions, 'transitions')[index], `transitions.${index}`);
}

/** The findings at the guard id of each edge of the sample document, in edge order. */
function guardIdFindings(rule: string): readonly DefinitionFinding[] {
  return EDGE_KEYS.map((key) => ({ rule, path: ['exarchos', 'edges', key, 'guardId'] }));
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

describe('the one check path of a definition document', () => {
  /** A valid document gives the parsed kernel with the parsed extension. The own rules run once, on the raw document. */
  it('CheckPath_AValidDocument_GivesTheKernelWithItsExtension', () => {
    const document = sampleDocument();
    const received: unknown[] = [];
    const checked = checkDefinitionDocument(document, (raw) => {
      received.push(raw);
      return [];
    });

    expect(checked).toStrictEqual({ ok: true, definition: sampleDocument() });
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(document);
  });

  /**
   * A failed kernel parse ends the checks of the document. The document also has an extension fault,
   * and its own rules always give one finding. So the findings hold the kernel finding only.
   */
  it('CheckPath_AKernelFault_EndsTheChecksOfTheDocument', () => {
    const document = sampleDocument();
    document.schemaVersion = '2.0';
    extensionOf(document).bogus = 1;
    let calls = 0;
    const checked = checkDefinitionDocument(document, () => {
      calls += 1;
      return [OWN_FINDING];
    });

    expect(checked).toStrictEqual({ ok: false, findings: [{ rule: 'kernel-schema', path: ['schemaVersion'] }] });
    expect(calls).toBe(0);
  });

  /**
   * A failed extension parse ends the checks of the document. The document has an extension fault only,
   * and its own rules always give one finding. So the findings hold the extension finding only.
   */
  it('CheckPath_AnExtensionFault_EndsTheChecksOfTheDocument', () => {
    const document = sampleDocument();
    extensionOf(document).bogus = 1;
    let calls = 0;
    const checked = checkDefinitionDocument(document, () => {
      calls += 1;
      return [OWN_FINDING];
    });

    expect(checked).toStrictEqual({ ok: false, findings: [{ rule: 'extension-schema', path: ['exarchos', 'bogus'] }] });
    expect(calls).toBe(0);
  });

  /**
   * The findings of the reference rules come first, then the findings of the own rules. A finding of the
   * own rules alone refuses a document that passes each other check.
   */
  it('CheckPath_TheOwnRules_RunAfterTheReferenceRules', () => {
    const document = sampleDocument();
    document.notes = 'free text';

    expect(checkDefinitionDocument(document, () => [OWN_FINDING])).toStrictEqual({
      ok: false,
      findings: [{ rule: 'kernel-keys', path: ['notes'] }, OWN_FINDING],
    });
    expect(checkDefinitionDocument(sampleDocument(), () => [OWN_FINDING])).toStrictEqual({
      ok: false,
      findings: [OWN_FINDING],
    });
  });

  /**
   * Each shape rule takes the prefix of its source. One document breaks each shape rule once, and each
   * finding names the `user` prefix. The prefix changes the rule id only, so the paths stay.
   */
  it('CheckPath_TheUserPrefix_NamesEachShapeRule', () => {
    const document = sampleDocument();
    stepAt(document, 0).note = 'free text';
    stepAt(document, 1).stepType = 'BUILD';
    transitionAt(document, 0).isDefault = true;
    document.terminalStepId = 'completed';
    recordAt(edgesOf(document)['plan->build'], 'plan->build').route = { kind: 'all', operands: [] };

    const shape = shapeFindings(document, 'user');
    expect(shape).toEqual([
      { rule: 'user-step-keys', path: ['steps', 0, 'note'] },
      { rule: 'user-step-type', path: ['steps', 1, 'stepType'] },
      { rule: 'user-transition', path: ['transitions', 0, 'isDefault'] },
      { rule: 'user-entry', path: ['terminalStepId'] },
    ]);
    expect(edgeShapeFindings(document, 'user', 'required')).toEqual([
      { rule: 'user-edge', path: ['exarchos', 'edges', 'plan->build', 'route'] },
    ]);
    expect(shapeFindings(document, 'built-in').map((finding) => finding.path)).toEqual(
      shape.map((finding) => finding.path),
    );
  });

  /**
   * With the `refused` policy, each edge that holds a guard id gives one finding at that key. An edge with
   * no guard id passes. The `required` policy gives the opposite findings for the same two documents.
   */
  it('CheckPath_ARefusedGuardIdPolicy_NamesEachEdgeGuardId', () => {
    const held = sampleDocument();
    const stripped = sampleDocument();
    for (const key of EDGE_KEYS) delete recordAt(edgesOf(stripped)[key], key).guardId;

    expect(edgeShapeFindings(held, 'user', 'refused')).toEqual(guardIdFindings('user-edge'));
    expect(edgeShapeFindings(stripped, 'user', 'refused')).toEqual([]);
    expect(edgeShapeFindings(held, 'user', 'required')).toEqual([]);
    expect(edgeShapeFindings(stripped, 'user', 'required')).toEqual(guardIdFindings('user-edge'));
  });

  /**
   * One document breaks one rule of each built-in rule set, and it passes each parse and each reference rule.
   * The throw lines of the loader equal the findings of the check path with the built-in rules. They follow
   * the order name, steps, transitions, entry, authority, edges and universal edges.
   */
  it('CheckPath_TheBuiltInLoader_GivesTheFindingsOfTheSharedCheckInOrder', () => {
    const document = sampleDocument();
    stepAt(document, 2).note = 'free text';
    transitionAt(document, 0).isDefault = true;
    document.terminalStepId = 'completed';
    delete recordAt(edgesOf(document)['plan->build'], 'plan->build').guardId;
    extensionOf(document).universal = [CANCEL_EDGE];

    const message = thrownMessage(() =>
      loadBuiltInDefinitions({
        feature: document,
        debug: structuredClone(debug),
        refactor: structuredClone(refactor),
        oneshot: structuredClone(oneshot),
        discovery: structuredClone(discovery),
      }),
    );
    const [heading, ...lines] = (message ?? '').split('\n');
    const shared = checkDefinitionDocument(document, (raw) => validateBuiltInDefinition('feature', raw));
    const sharedLines = shared.ok ? [] : shared.findings.map((finding) => `feature ${finding.rule} ${finding.path.join('.')}`);

    expect(heading).toBe('the built-in workflow definitions fail their checks:');
    expect(shared.ok).toBe(false);
    expect(lines).toEqual(sharedLines);
    expect(lines).toEqual([
      'feature built-in-name name',
      'feature built-in-step-keys steps.2.note',
      'feature built-in-transition transitions.0.isDefault',
      'feature built-in-entry terminalStepId',
      'feature built-in-authority authority',
      'feature built-in-edge exarchos.edges.plan->build.guardId',
      'feature built-in-universal exarchos.universal',
    ]);
  });
});
