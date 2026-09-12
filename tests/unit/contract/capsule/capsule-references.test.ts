// Structural validity and referential soundness are two different questions,
// and this file's job is to prove they are two.
//
// Every bend below is a document the SCHEMA accepts. If any of them were also
// rejected structurally, the resolver would be redundant and this module should
// not exist. Each test therefore asserts the pair — the schema says yes, the
// resolver says no, and names the one reference it broke.
//
// @oracle-sources: ../../../../src/contract/capsule/exarchos-capsule.ts, the published workflow kernel read from node_modules whose own graph rules decide every delegation case and are not reimplemented here

import { describe, it, expect } from 'vitest';

import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import {
  CAPSULE_REFERENCE_VIOLATION_KINDS,
  type CapsuleReferenceViolationKind,
  resolveCapsuleReferences,
} from '../../../../src/contract/capsule/capsule-references.js';

/** A kernel definition the published contract accepts, carrying one named step. */
function kernelDefinition(stepIds: readonly string[]): unknown {
  return {
    schemaVersion: '1.0',
    name: 'capsule-corpus',
    steps: stepIds.map((stepId, i) => ({
      kind: 'skill',
      stepId,
      stepName: stepId,
      isTerminal: i === stepIds.length - 1,
      stepType: 'work',
    })),
    transitions: [],
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
  };
}

interface ReferenceCase {
  readonly name: string;
  readonly kind: CapsuleReferenceViolationKind;
  readonly at: string;
  readonly document: ExarchosCapsuleV1;
  readonly definition?: unknown;
}

function bend(
  name: string,
  kind: CapsuleReferenceViolationKind,
  at: string,
  mutate: (base: ExarchosCapsuleV1) => ExarchosCapsuleV1,
  definition?: unknown,
): ReferenceCase {
  return { name, kind, at, document: mutate(baseValidCapsule()), definition };
}

const REFERENCE_CASES: readonly ReferenceCase[] = [
  bend(
    'two tasks sharing an id',
    'duplicate-task-id',
    'graph.tasks[1].taskId',
    (b) => ({
      ...b,
      graph: {
        ...b.graph,
        tasks: [b.graph.tasks[0]!, { ...b.graph.tasks[1]!, taskId: 'task-compile' }],
        dependencies: [],
        joins: [],
      },
      contracts: { ...b.contracts, taskResults: { 'task-compile': [] } },
      settlementContract: { ...b.settlementContract, requiredResults: ['task-compile'] },
    }),
  ),
  bend(
    'two joins sharing an id',
    'duplicate-join-id',
    'graph.joins[1].joinId',
    (b) => ({
      ...b,
      graph: {
        ...b.graph,
        joins: [b.graph.joins[0]!, { ...b.graph.joins[0]! }],
      },
    }),
  ),
  bend(
    'a dependency pointing at no task',
    'dangling-task-ref',
    'graph.dependencies[0].to',
    (b) => ({
      ...b,
      graph: { ...b.graph, dependencies: [{ from: 'task-compile', to: 'task-ghost' }] },
    }),
  ),
  bend(
    'a join waiting on no task',
    'dangling-task-ref',
    'graph.joins[0].waitsFor[1]',
    (b) => ({
      ...b,
      graph: {
        ...b.graph,
        joins: [{ joinId: 'join-all', waitsFor: ['task-compile', 'task-ghost'], mode: 'all' }],
      },
    }),
  ),
  bend(
    'an input contract keyed on no task',
    'dangling-task-ref',
    'contracts.taskInputs["task-ghost"]',
    (b) => ({
      ...b,
      contracts: {
        ...b.contracts,
        taskInputs: { 'task-ghost': [{ name: 'source', type: 'string', required: true }] },
      },
    }),
  ),
  bend(
    'a result contract keyed on no task',
    'dangling-task-ref',
    'contracts.taskResults["task-ghost"]',
    (b) => ({
      ...b,
      contracts: {
        ...b.contracts,
        taskResults: {
          'task-verify': [{ name: 'passed', type: 'boolean', required: true }],
          'task-ghost': [],
        },
      },
    }),
  ),
  bend(
    'settlement requiring a result from no task',
    'dangling-task-ref',
    'settlementContract.requiredResults[0]',
    (b) => ({
      ...b,
      settlementContract: { ...b.settlementContract, requiredResults: ['task-ghost'] },
    }),
  ),
  bend(
    'settlement requiring a result no contract declares',
    'unadjudicable-required-result',
    'settlementContract.requiredResults[0]',
    (b) => ({
      ...b,
      settlementContract: { ...b.settlementContract, requiredResults: ['task-compile'] },
    }),
  ),
  bend(
    'a two-task dependency cycle',
    'cyclic-dependency',
    'graph.dependencies',
    (b) => ({
      ...b,
      graph: {
        ...b.graph,
        dependencies: [
          { from: 'task-compile', to: 'task-verify' },
          { from: 'task-verify', to: 'task-compile' },
        ],
      },
    }),
  ),
  bend(
    'a task depending on itself',
    'cyclic-dependency',
    'graph.dependencies',
    (b) => ({
      ...b,
      graph: { ...b.graph, dependencies: [{ from: 'task-compile', to: 'task-compile' }] },
    }),
  ),
  bend(
    'a predicate reading an undeclared fact',
    'undeclared-fact',
    'graph.completionPredicate.condition.operands[1].field',
    (b) => ({
      ...b,
      graph: {
        ...b.graph,
        completionPredicate: {
          condition: {
            kind: 'all',
            operands: [
              { kind: 'factPresent', field: 'verified' },
              { kind: 'factPresent', field: 'smuggled' },
            ],
          },
          declares: { fields: { verified: 'boolean' }, events: [] },
        },
      },
    }),
  ),
  bend(
    'a predicate reading an undeclared event',
    'undeclared-event',
    'graph.completionPredicate.condition.operand.event',
    (b) => ({
      ...b,
      graph: {
        ...b.graph,
        completionPredicate: {
          condition: { kind: 'not', operand: { kind: 'eventObserved', event: 'never.declared' } },
          declares: { fields: {}, events: ['execution.settled'] },
        },
      },
    }),
  ),
  bend(
    'a task naming a step the pinned definition does not have',
    'dangling-step-ref',
    'graph.tasks[1].stepId',
    (b) => b,
    kernelDefinition(['step-compile']),
  ),
  bend(
    // The kernel accepts this document STRUCTURALLY and rejects it on its own
    // reference rule. Only delegation can see that, which is the point.
    'a pinned definition whose transition names no step',
    'unsound-kernel-definition',
    'identity.definitionVersion',
    (b) => b,
    {
      ...(kernelDefinition(['step-verify']) as Record<string, unknown>),
      transitions: [
        { transitionId: 't1', fromStepId: 'step-verify', toStepId: 'step-ghost', isDefault: true },
      ],
    },
  ),
];

describe('capsule reference integrity', () => {
  it('CapsuleReferences_TheBaseFixture_IsSound', () => {
    // The denominator. A resolver that reported everything broken would satisfy
    // every rejecting case below without this one.
    const verdict = resolveCapsuleReferences(baseValidCapsule());
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('CapsuleReferences_TheBaseFixtureAgainstItsDefinition_IsSound', () => {
    const verdict = resolveCapsuleReferences(baseValidCapsule(), {
      definition: kernelDefinition(['step-verify']),
    });
    expect(verdict.violations).toEqual([]);
  });

  // `$name` must END the title: vitest reads `$name_Suffix` as one property
  // path and renders it `undefined`, which silently erases every case name.
  it.each(REFERENCE_CASES)('CapsuleReferences_IsStructurallyValid_$name', ({ document }) => {
    // If this fails, the schema already refuses the document and the resolver
    // proves nothing by also refusing it.
    const parsed = ExarchosCapsuleV1Schema.safeParse(document);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it.each(REFERENCE_CASES)(
    'CapsuleReferences_IsNamedByTheResolver_$name',
    ({ document, definition, kind, at }) => {
      const verdict = resolveCapsuleReferences(document, { definition });
      expect(verdict.ok).toBe(false);
      const kinds = verdict.violations.map((v) => v.kind);
      expect(kinds).toContain(kind);
      expect(verdict.violations.map((v) => v.at)).toContain(at);
    },
  );

  it('CapsuleReferences_EveryDeclaredKind_HasAFixture', () => {
    const covered = new Set(REFERENCE_CASES.map((c) => c.kind));
    const uncovered = CAPSULE_REFERENCE_VIOLATION_KINDS.filter((kind) => !covered.has(kind));
    expect(
      uncovered,
      `these violation kinds are declared and never exercised: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('CapsuleReferences_ManyBrokenReferences_AreAllReported', () => {
    // The pass must not short-circuit: one run, every violation.
    const base = baseValidCapsule();
    const verdict = resolveCapsuleReferences({
      ...base,
      graph: {
        ...base.graph,
        dependencies: [
          { from: 'task-ghost-a', to: 'task-verify' },
          { from: 'task-compile', to: 'task-ghost-b' },
        ],
      },
    });
    expect(verdict.violations.map((v) => v.ref).sort()).toEqual(['task-ghost-a', 'task-ghost-b']);
  });

  it('CapsuleReferences_OneCycle_IsReportedOnce', () => {
    // Every member of a loop can reach it. Reporting the same loop three times
    // would read as three defects.
    const base = baseValidCapsule();
    const verdict = resolveCapsuleReferences({
      ...base,
      graph: {
        ...base.graph,
        tasks: [...base.graph.tasks, { taskId: 'task-third', title: 'third' }],
        dependencies: [
          { from: 'task-compile', to: 'task-verify' },
          { from: 'task-verify', to: 'task-third' },
          { from: 'task-third', to: 'task-compile' },
        ],
        joins: [],
      },
    });
    const cycles = verdict.violations.filter((v) => v.kind === 'cyclic-dependency');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain('task-compile');
    expect(cycles[0]?.message).toContain('task-third');
  });

  it('CapsuleReferences_ADanglingEndpoint_IsNotAlsoReportedAsACycle', () => {
    // A broken edge must produce ONE diagnosis, not two.
    const base = baseValidCapsule();
    const verdict = resolveCapsuleReferences({
      ...base,
      graph: { ...base.graph, dependencies: [{ from: 'task-ghost', to: 'task-ghost' }] },
    });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['dangling-task-ref', 'dangling-task-ref']);
  });

  it('CapsuleReferences_WithNoDefinitionSupplied_StepRefsAreNotResolved', () => {
    // Stated rather than incidental: a capsule pins its definition by digest,
    // so without the definition there is nothing to resolve a step id against.
    const base = baseValidCapsule();
    const document: ExarchosCapsuleV1 = {
      ...base,
      graph: {
        ...base.graph,
        tasks: base.graph.tasks.map((task) => ({ ...task, stepId: 'step-that-does-not-exist' })),
      },
    };
    expect(resolveCapsuleReferences(document).ok).toBe(true);
    expect(
      resolveCapsuleReferences(document, { definition: kernelDefinition(['step-verify']) }).ok,
    ).toBe(false);
  });

  it('CapsuleReferences_AStepIdSmuggledOntoALooseObject_DoesNotResolve', () => {
    // The kernel's definition schema is built on `z.looseObject`, so a
    // definition it ACCEPTS may retain arbitrary unknown objects. One carrying a
    // `stepId` must not make a capsule task resolvable — that would be a
    // dangling reference reported as sound, which is worse than no check.
    const base = baseValidCapsule();
    const definition = {
      ...(kernelDefinition(['step-compile']) as Record<string, unknown>),
      notes: { stepId: 'step-verify' },
    };
    const verdict = resolveCapsuleReferences(base, { definition });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['dangling-step-ref']);
    expect(verdict.violations[0]?.ref).toBe('step-verify');
  });

  it('CapsuleReferences_AStepCollectionNestedInALooseObject_DoesNotResolve', () => {
    // The same smuggling one level deeper, under a key that DOES name a step
    // collection. A walk that matched key names over the document would collect
    // this; only a walk that follows the kernel's schema refuses it, because
    // `notes` is no field the kernel declares.
    const base = baseValidCapsule();
    const definition = {
      ...(kernelDefinition(['step-compile']) as Record<string, unknown>),
      notes: { steps: [{ stepId: 'step-verify' }] },
    };
    const verdict = resolveCapsuleReferences(base, { definition });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['dangling-step-ref']);
    expect(verdict.violations[0]?.ref).toBe('step-verify');
  });

  it('CapsuleReferences_AStepNestedInsideTheKernelsOwnStructures_DoesResolve', () => {
    // And the narrowing is not over-tight: the kernel nests steps in a loop
    // body, so a task naming one of those has to resolve. A rule that only read
    // the top-level `steps` array would report this as dangling.
    const base = baseValidCapsule();
    const definition = {
      ...(kernelDefinition(['step-compile']) as Record<string, unknown>),
      loops: [
        {
          loopId: 'loop-1',
          loopName: 'retry',
          fromStepId: 'step-compile',
          maxIterations: 2,
          bodySteps: [
            {
              kind: 'skill',
              stepId: 'step-verify',
              stepName: 'step-verify',
              isTerminal: false,
              stepType: 'work',
            },
          ],
        },
      ],
    };
    expect(resolveCapsuleReferences(base, { definition }).violations).toEqual([]);
  });

  it('CapsuleReferences_AnUnsoundDefinition_SuppressesStepResolution', () => {
    // A definition that failed the kernel contract cannot be a reference target.
    // Reporting dangling steps against it too would blame the capsule for the
    // definition's defect.
    const verdict = resolveCapsuleReferences(baseValidCapsule(), {
      definition: {
        ...(kernelDefinition(['step-compile']) as Record<string, unknown>),
        transitions: [
          { transitionId: 't1', fromStepId: 'step-compile', toStepId: 'step-ghost', isDefault: true },
        ],
      },
    });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['unsound-kernel-definition']);
  });
});
