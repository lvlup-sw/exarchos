// These tests check the strict schema of the `exarchos` extension and the four reference rules.
// Each document is written by hand in this file, and each test states the findings that it expects.
// A finding names its rule and its path from the root of the document.
//
// @oracle-sources: ../../../../src/workflow/definitions/extension.ts, the hand-written documents and expected findings in this file

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { describe, expect, it } from 'vitest';

import {
  parseExtension,
  validateExtension,
  type DefinitionFinding,
  type EdgeCategory,
} from '../../../../src/workflow/definitions/extension.js';

/** The source file of the phase machine module. */
const STATE_MACHINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/workflow/state-machine.ts',
);

/** The five categories of an edge. */
const EDGE_CATEGORIES: readonly EdgeCategory[] = [
  'route-condition',
  'admission-requirement',
  'bounded-loop-rule',
  'approval',
  'obsolete-predicate',
];

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

/** The steps of the sample kernel, in kernel order. */
const STEPS: readonly Record<string, unknown>[] = [
  step('plan', 'PLAN'),
  step('delegate', 'IMPLEMENT'),
  step('review', 'REVIEW'),
  step('synthesize', 'SYNTHESIZE'),
  step('completed', 'final'),
  step('cancelled', 'final'),
];

/** The transitions of the sample kernel, in kernel order. */
const TRANSITIONS: readonly Record<string, unknown>[] = [
  transition('plan', 'delegate'),
  transition('delegate', 'review'),
  transition('review', 'delegate'),
  transition('review', 'synthesize'),
  transition('synthesize', 'completed'),
];

/** The one group of the sample extension. */
const IMPLEMENTATION_GROUP = {
  groupId: 'implementation',
  members: ['delegate', 'review'],
  initial: 'delegate',
  maxFixCycles: 3,
  history: 'shallow',
  onEntry: ['log'],
  onExit: ['log'],
};

/** The edge from `plan`, with a gate obligation and no route. */
const PLAN_EDGE = {
  guardId: 'plan-artifact-exists',
  category: 'admission-requirement',
  obligation: {
    kind: 'gate',
    gateId: 'plan-artifact',
    presence: {
      kind: 'any',
      operands: [
        { kind: 'factPresent', field: 'artifacts.plan' },
        { kind: 'factPresent', field: 'plan' },
      ],
    },
  },
};

/** The edge from `delegate`, with a gate obligation over a task count. */
const DELEGATE_EDGE = {
  guardId: 'all-tasks-complete',
  category: 'admission-requirement',
  obligation: {
    kind: 'gate',
    gateId: 'tasks-complete',
    presence: {
      kind: 'all',
      operands: [
        { kind: 'counterCompare', field: 'tasks.count', op: 'gte', value: 1 },
        { kind: 'factEquals', field: 'tasks.allComplete', value: true },
      ],
    },
  },
};

/** The fix-cycle edge from `review`, with a route and no obligation. */
const FIX_CYCLE_EDGE = {
  guardId: 'any-review-failed',
  category: 'route-condition',
  route: { kind: 'factEquals', field: 'reviews.anyFailed', value: true },
  obligation: { kind: 'none' },
  isFixCycle: true,
  effects: ['increment-fix-cycle'],
};

/** The forward edge from `review`, with an approval obligation. */
const REVIEW_EDGE = {
  guardId: 'all-reviews-passed',
  category: 'approval',
  obligation: {
    kind: 'approval',
    approvalClass: 'reviews',
    minimumApprovals: 1,
    presence: { kind: 'factEquals', field: 'reviews.requiredSatisfied', value: true },
  },
};

/** The edge from `synthesize`, with a gate obligation. */
const SYNTHESIZE_EDGE = {
  guardId: 'pr-url-exists',
  category: 'admission-requirement',
  obligation: {
    kind: 'gate',
    gateId: 'pr-url',
    presence: { kind: 'factPresent', field: 'synthesis.prUrl' },
  },
};

/** The edge of each sample transition, keyed by the kernel transition id. */
const SAMPLE_EDGES: Readonly<Record<string, unknown>> = {
  'plan->delegate': PLAN_EDGE,
  'delegate->review': DELEGATE_EDGE,
  'review->delegate': FIX_CYCLE_EDGE,
  'review->synthesize': REVIEW_EDGE,
  'synthesize->completed': SYNTHESIZE_EDGE,
};

/** The universal cancel edge. */
const CANCEL_EDGE = { edgeKind: 'cancel', to: 'cancelled' };

/** The universal cleanup edge. */
const CLEANUP_EDGE = { edgeKind: 'cleanup', to: 'completed', guardId: 'merge-verified' };

/** The parts of a sample document that a test replaces. */
interface SampleParts {
  readonly topLevel?: Readonly<Record<string, unknown>>;
  readonly extension?: Readonly<Record<string, unknown>>;
  readonly groups?: readonly unknown[];
  readonly edges?: Readonly<Record<string, unknown>>;
  readonly universal?: readonly unknown[];
}

/** A fresh copy of the valid sample document, with the parts that a test replaces. */
function sampleDocument(parts: SampleParts = {}): Record<string, unknown> {
  return structuredClone({
    schemaVersion: '1.0',
    name: 'exarchos.sample',
    steps: STEPS,
    transitions: TRANSITIONS,
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
    entryStepId: 'plan',
    ...parts.topLevel,
    exarchos: {
      extensionVersion: '1',
      groups: parts.groups ?? [IMPLEMENTATION_GROUP],
      edges: parts.edges ?? SAMPLE_EDGES,
      universal: parts.universal ?? [CANCEL_EDGE, CLEANUP_EDGE],
      ...parts.extension,
    },
  });
}

/** The findings of one document: the kernel parse, then the strict extension parse, then the reference rules. */
function findingsOf(document: Record<string, unknown>): readonly DefinitionFinding[] {
  const kernel = WorkflowDefinitionV1Schema.parse(document);
  const parsed = parseExtension(document);
  return parsed.ok ? validateExtension(document, kernel, parsed.extension) : parsed.findings;
}

/** One finding of the strict extension parse at a path. */
function schemaFinding(...findingPath: (string | number)[]): DefinitionFinding {
  return { rule: 'extension-schema', path: findingPath };
}

describe('the exarchos extension of a definition', () => {
  /**
   * The valid sample parses with the kernel schema and with the strict extension schema, and no reference rule refuses it.
   * The parse adds no field, so an absent optional field stays absent. Each of the five edge categories parses.
   */
  it('Extension_AValidDocument_Parses', () => {
    const document = sampleDocument();
    expect(WorkflowDefinitionV1Schema.safeParse(document).success).toBe(true);
    const parsed = parseExtension(document);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.extension).toStrictEqual(document.exarchos);
    expect(findingsOf(document)).toEqual([]);

    for (const category of EDGE_CATEGORIES) {
      const edges = { ...SAMPLE_EDGES, 'plan->delegate': { ...PLAN_EDGE, category } };
      expect(findingsOf(sampleDocument({ edges })), category).toEqual([]);
    }
    const unknownCategory = { ...SAMPLE_EDGES, 'plan->delegate': { ...PLAN_EDGE, category: 'advisory' } };
    expect(findingsOf(sampleDocument({ edges: unknownCategory }))).toEqual([
      schemaFinding('exarchos', 'edges', 'plan->delegate', 'category'),
    ]);
  });

  /** The kernel schema is a loose object. It accepts a broken extension and keeps it, so the strict parse is the only check of the extension. */
  it('Extension_TheKernelSchema_AcceptsABrokenExtension', () => {
    const broken = { extensionVersion: '2', groups: 'none', command: 'rm -rf /' };
    const document = sampleDocument();
    document.exarchos = broken;
    const kernel = WorkflowDefinitionV1Schema.safeParse(document);
    expect(kernel.success).toBe(true);
    expect(kernel.data).toMatchObject({ exarchos: broken });
    expect(parseExtension(document).ok).toBe(false);
  });

  /** An unknown key fails the strict parse in each object of the extension, and the finding path ends at the object or the key. */
  it('Extension_AnUnknownKey_IsRefusedAtEveryLevel', () => {
    const cases: readonly { readonly label: string; readonly parts: SampleParts; readonly path: (string | number)[] }[] = [
      { label: 'extension', parts: { extension: { extra: true } }, path: ['exarchos', 'extra'] },
      {
        label: 'group',
        parts: { groups: [{ ...IMPLEMENTATION_GROUP, extra: true }] },
        path: ['exarchos', 'groups', 0, 'extra'],
      },
      {
        label: 'edge',
        parts: { edges: { ...SAMPLE_EDGES, 'review->delegate': { ...FIX_CYCLE_EDGE, extra: true } } },
        path: ['exarchos', 'edges', 'review->delegate', 'extra'],
      },
      {
        label: 'route condition',
        parts: {
          edges: {
            ...SAMPLE_EDGES,
            'review->delegate': { ...FIX_CYCLE_EDGE, route: { ...FIX_CYCLE_EDGE.route, extra: true } },
          },
        },
        path: ['exarchos', 'edges', 'review->delegate', 'route'],
      },
      {
        label: 'none obligation',
        parts: {
          edges: { ...SAMPLE_EDGES, 'review->delegate': { ...FIX_CYCLE_EDGE, obligation: { kind: 'none', extra: true } } },
        },
        path: ['exarchos', 'edges', 'review->delegate', 'obligation', 'extra'],
      },
      {
        label: 'gate obligation',
        parts: {
          edges: { ...SAMPLE_EDGES, 'plan->delegate': { ...PLAN_EDGE, obligation: { ...PLAN_EDGE.obligation, extra: true } } },
        },
        path: ['exarchos', 'edges', 'plan->delegate', 'obligation', 'extra'],
      },
      {
        label: 'approval obligation',
        parts: {
          edges: {
            ...SAMPLE_EDGES,
            'review->synthesize': { ...REVIEW_EDGE, obligation: { ...REVIEW_EDGE.obligation, extra: true } },
          },
        },
        path: ['exarchos', 'edges', 'review->synthesize', 'obligation', 'extra'],
      },
      {
        label: 'cancel edge',
        parts: { universal: [{ ...CANCEL_EDGE, extra: true }, CLEANUP_EDGE] },
        path: ['exarchos', 'universal', 0, 'extra'],
      },
      {
        label: 'cleanup edge',
        parts: { universal: [CANCEL_EDGE, { ...CLEANUP_EDGE, extra: true }] },
        path: ['exarchos', 'universal', 1, 'extra'],
      },
    ];
    for (const { label, parts, path: findingPath } of cases) {
      expect(findingsOf(sampleDocument(parts)), label).toEqual([schemaFinding(...findingPath)]);
    }
  });

  /** A condition is a node of the closed AST. A `command` key fails the parse in a route and in a nested presence probe. */
  it('Extension_AConditionWithACommandKey_IsRefused', () => {
    const route = { ...FIX_CYCLE_EDGE, route: { ...FIX_CYCLE_EDGE.route, command: 'rm -rf /' } };
    expect(findingsOf(sampleDocument({ edges: { ...SAMPLE_EDGES, 'review->delegate': route } }))).toEqual([
      schemaFinding('exarchos', 'edges', 'review->delegate', 'route'),
    ]);

    const presence = {
      ...PLAN_EDGE,
      obligation: {
        ...PLAN_EDGE.obligation,
        presence: {
          kind: 'any',
          operands: [{ kind: 'factPresent', field: 'artifacts.plan', command: 'rm -rf /' }],
        },
      },
    };
    expect(findingsOf(sampleDocument({ edges: { ...SAMPLE_EDGES, 'plan->delegate': presence } }))).toEqual([
      schemaFinding('exarchos', 'edges', 'plan->delegate', 'obligation', 'presence'),
    ]);
  });

  /** An edge key that names no kernel transition is refused, and the path names that key. */
  it('Extension_AnEdgeWithNoTransition_IsRefused', () => {
    const edges = { ...SAMPLE_EDGES, 'plan->synthesize': PLAN_EDGE };
    expect(findingsOf(sampleDocument({ edges }))).toEqual([
      { rule: 'edge-keys', path: ['exarchos', 'edges', 'plan->synthesize'] },
    ]);
  });

  /**
   * A kernel transition with no edge is refused, and the path names the absent edge key.
   * A second transition with the same id has no edge of its own, so it is refused at its index.
   */
  it('Extension_ATransitionWithNoEdge_IsRefused', () => {
    const edges = Object.fromEntries(
      Object.entries(SAMPLE_EDGES).filter(([transitionId]) => transitionId !== 'synthesize->completed'),
    );
    expect(findingsOf(sampleDocument({ edges }))).toEqual([
      { rule: 'edge-keys', path: ['exarchos', 'edges', 'synthesize->completed'] },
    ]);

    const transitions = [...TRANSITIONS, transition('plan', 'delegate')];
    expect(findingsOf(sampleDocument({ topLevel: { transitions } }))).toEqual([
      { rule: 'edge-keys', path: ['transitions', 5, 'transitionId'] },
    ]);
  });

  /** A step in two groups is refused at its place in the second group. */
  it('Extension_AStepInTwoGroups_IsRefused', () => {
    const second = { groupId: 'review-loop', members: ['review'], initial: 'review', history: 'shallow' };
    expect(findingsOf(sampleDocument({ groups: [IMPLEMENTATION_GROUP, second] }))).toEqual([
      { rule: 'group-members', path: ['exarchos', 'groups', 1, 'members', 0] },
    ]);
  });

  /** The members of a group follow kernel order with no gap. A gap and a reversed order are each refused at the member that breaks the run. */
  it('Extension_ANonContiguousGroup_IsRefused', () => {
    const gap = { ...IMPLEMENTATION_GROUP, members: ['delegate', 'synthesize'] };
    expect(findingsOf(sampleDocument({ groups: [gap] }))).toEqual([
      { rule: 'group-members', path: ['exarchos', 'groups', 0, 'members', 1] },
    ]);

    const reversed = { ...IMPLEMENTATION_GROUP, members: ['review', 'delegate'] };
    expect(findingsOf(sampleDocument({ groups: [reversed] }))).toEqual([
      { rule: 'group-members', path: ['exarchos', 'groups', 0, 'members', 1] },
    ]);
  });

  /** The history of a group is required, and only `shallow` parses. */
  it('Extension_AHistoryOtherThanShallow_IsRefused', () => {
    const deep = { ...IMPLEMENTATION_GROUP, history: 'deep' };
    expect(findingsOf(sampleDocument({ groups: [deep] }))).toEqual([
      schemaFinding('exarchos', 'groups', 0, 'history'),
    ]);

    const { history: _history, ...absent } = IMPLEMENTATION_GROUP;
    expect(findingsOf(sampleDocument({ groups: [absent] }))).toEqual([
      schemaFinding('exarchos', 'groups', 0, 'history'),
    ]);
  });

  /** A universal edge goes to a terminal step. A non-terminal step and an unknown step are each refused at `to`. */
  it('Extension_AUniversalEdgeToANonTerminalStep_IsRefused', () => {
    expect(findingsOf(sampleDocument({ universal: [{ ...CANCEL_EDGE, to: 'synthesize' }, CLEANUP_EDGE] }))).toEqual([
      { rule: 'universal-targets', path: ['exarchos', 'universal', 0, 'to'] },
    ]);
    expect(findingsOf(sampleDocument({ universal: [CANCEL_EDGE, { ...CLEANUP_EDGE, to: 'archived' }] }))).toEqual([
      { rule: 'universal-targets', path: ['exarchos', 'universal', 1, 'to'] },
    ]);
  });

  /**
   * A top-level key that is not a kernel key or `exarchos` is refused, and the path names that key.
   * The rule reads the key set of the kernel schema, so each optional kernel key passes.
   */
  it('Extension_ATopLevelKeyOutsideTheKernel_IsRefused', () => {
    expect(findingsOf(sampleDocument({ topLevel: { notes: 'free text' } }))).toEqual([
      { rule: 'kernel-keys', path: ['notes'] },
    ]);

    const everyKernelKey = {
      gates: [],
      diagnosticForks: [],
      contentHash: 'a'.repeat(64),
      authority: { invariants: [] },
      terminalStepId: 'completed',
    };
    expect(findingsOf(sampleDocument({ topLevel: everyKernelKey }))).toEqual([]);
  });

  /** A composite guard id joins the ids of its inner guards with `+`. It parses on an edge and on a cleanup edge, and a malformed id fails. */
  it('Extension_ACompositeGuardId_IsAccepted', () => {
    const composite = { ...DELEGATE_EDGE, guardId: 'all-tasks-complete+team-disbanded' };
    const cleanup = { ...CLEANUP_EDGE, guardId: 'merge-verified+pr-merged' };
    expect(
      findingsOf(
        sampleDocument({ edges: { ...SAMPLE_EDGES, 'delegate->review': composite }, universal: [CANCEL_EDGE, cleanup] }),
      ),
    ).toEqual([]);

    for (const guardId of ['all-tasks-complete+', '+team-disbanded', 'All-Tasks-Complete', 'a++b']) {
      const malformed = { ...DELEGATE_EDGE, guardId };
      expect(findingsOf(sampleDocument({ edges: { ...SAMPLE_EDGES, 'delegate->review': malformed } })), guardId).toEqual([
        schemaFinding('exarchos', 'edges', 'delegate->review', 'guardId'),
      ]);
    }
  });

  /** A document with one fault of each reference rule gives the four rule ids in rule order, each with the path of its fault. */
  it('Extension_EachFinding_NamesItsRuleAndPath', () => {
    const document = sampleDocument({
      topLevel: { notes: 'free text' },
      edges: { ...SAMPLE_EDGES, 'plan->synthesize': PLAN_EDGE },
      groups: [{ ...IMPLEMENTATION_GROUP, initial: 'synthesize' }],
      universal: [CANCEL_EDGE, CLEANUP_EDGE, CANCEL_EDGE],
    });
    expect(findingsOf(document)).toEqual([
      { rule: 'kernel-keys', path: ['notes'] },
      { rule: 'edge-keys', path: ['exarchos', 'edges', 'plan->synthesize'] },
      { rule: 'group-members', path: ['exarchos', 'groups', 0, 'initial'] },
      { rule: 'universal-targets', path: ['exarchos', 'universal', 2, 'edgeKind'] },
    ]);
  });

  /** The phase machine module imports the `Effect` type from the extension, and it neither declares nor exports its own copy. */
  it('Extension_TheMachineModule_ImportsTheEffectType', () => {
    const source = fs.readFileSync(STATE_MACHINE_PATH, 'utf8');
    expect(source).toMatch(/import\s+type\s*\{\s*Effect\s*\}\s*from\s*'\.\/definitions\/extension\.js';/);
    expect(source).not.toMatch(/\btype\s+Effect\s*=/);
    expect(source).not.toMatch(/export\s+type\s*\{[^}]*\bEffect\b[^}]*\}/);
  });
});
