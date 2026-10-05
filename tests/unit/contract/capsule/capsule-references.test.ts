// Structural validity and referential soundness are two different questions.
// This file proves that they are different.
//
// The schema must accept every case in `REFERENCE_CASES`. If the schema
// rejects a case, the resolver is redundant for that case. Thus each case has
// two tests: the schema accepts the document, and the resolver rejects it and
// names the broken reference.
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

/** A kernel definition that the published contract accepts, with one step for each id. */
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
    'verification terms for a task the graph does not declare',
    'dangling-task-ref',
    'settlementContract.taskVerification["task-ghost"]',
    (b) => ({
      ...b,
      settlementContract: {
        ...b.settlementContract,
        taskVerification: {
          ...b.settlementContract.taskVerification,
          'task-ghost': { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        },
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
  /**
   * The kernel accepts this definition by structure and rejects it by its own reference rule.
   * Only delegation to the kernel shows that defect.
   */
  bend(
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
  /** Without this test, a resolver that rejects every document satisfies each rejecting case. */
  it('CapsuleReferences_TheBaseFixture_IsSound', () => {
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

  /**
   * `$name` must end the title. Vitest reads `$name_Suffix` as one property path and renders `undefined`.
   * If this test fails, the schema already rejects the document, and the resolver verdict proves nothing.
   */
  it.each(REFERENCE_CASES)('CapsuleReferences_IsStructurallyValid_$name', ({ document }) => {
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

  /** The resolver does not stop at the first violation: one run reports every violation. */
  it('CapsuleReferences_ManyBrokenReferences_AreAllReported', () => {
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

  /** Every task in a cycle can reach that cycle. One report for each task reads as three defects. */
  it('CapsuleReferences_OneCycle_IsReportedOnce', () => {
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

  /** A self-edge on an undeclared task gets the dangling diagnosis for each endpoint and no cycle diagnosis. */
  it('CapsuleReferences_ADanglingEndpoint_IsNotAlsoReportedAsACycle', () => {
    const base = baseValidCapsule();
    const verdict = resolveCapsuleReferences({
      ...base,
      graph: { ...base.graph, dependencies: [{ from: 'task-ghost', to: 'task-ghost' }] },
    });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['dangling-task-ref', 'dangling-task-ref']);
  });

  /** A capsule pins its definition by digest. Without the definition, the resolver has no target for a step id. */
  it('CapsuleReferences_WithNoDefinitionSupplied_StepRefsAreNotResolved', () => {
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

  /**
   * The kernel builds its definition schema on `z.looseObject`, so an accepted definition can keep unknown objects.
   * A `stepId` in such an object must not resolve a capsule task: that reports a dangling reference as sound.
   */
  it('CapsuleReferences_AStepIdSmuggledOntoALooseObject_DoesNotResolve', () => {
    const base = baseValidCapsule();
    const definition = {
      ...(kernelDefinition(['step-compile']) as Record<string, unknown>),
      notes: { stepId: 'step-verify' },
    };
    const verdict = resolveCapsuleReferences(base, { definition });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['dangling-step-ref']);
    expect(verdict.violations[0]?.ref).toBe('step-verify');
  });

  /**
   * The unknown object holds a `steps` key, which is the name of a real step collection.
   * A walk that matches key names collects this step.
   * A walk that follows the kernel schema refuses it, because the kernel declares no `notes` field.
   */
  it('CapsuleReferences_AStepCollectionNestedInALooseObject_DoesNotResolve', () => {
    const base = baseValidCapsule();
    const definition = {
      ...(kernelDefinition(['step-compile']) as Record<string, unknown>),
      notes: { steps: [{ stepId: 'step-verify' }] },
    };
    const verdict = resolveCapsuleReferences(base, { definition });
    expect(verdict.violations.map((v) => v.kind)).toEqual(['dangling-step-ref']);
    expect(verdict.violations[0]?.ref).toBe('step-verify');
  });

  /**
   * The kernel nests steps in a loop body, so a task that names such a step must resolve.
   * A rule that reads only the top-level `steps` array reports this task as dangling.
   */
  it('CapsuleReferences_AStepNestedInsideTheKernelsOwnStructures_DoesResolve', () => {
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

  /**
   * A definition that fails the kernel contract is not a reference target.
   * A dangling-step report against it blames the capsule for the defect of the definition.
   */
  it('CapsuleReferences_AnUnsoundDefinition_SuppressesStepResolution', () => {
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
