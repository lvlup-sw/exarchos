// Compiling a delegation batch into a capsule, validated against the definition
// it pins — and, as the denominator, adjudicated by the real settlement pass.
//
// @oracle-sources: ../../../../src/verbs/prepare/compile-capsule.ts, the real settlement adjudicator's verdict on the compiled capsule and task ids and edges worked out by hand from each fixture plan

import { describe, it, expect } from 'vitest';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { resolveCapsuleReferences } from '../../../../src/contract/capsule/capsule-references.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { DesignRevisedData, type DesignRevised } from '../../../../src/events/schemas.js';
import { bindCatalogInvariants } from '../../../../src/verbs/prepare/bind-authority.js';
import { builtInWorkflowAuthority } from '../../../../src/verbs/prepare/built-in-authority.js';
import {
  compileDelegationCapsule,
  PREPARE_COMPILER_VERSION,
  selectDesignChanges,
  type AcceptedDesignChange,
  type CompileCapsuleInput,
} from '../../../../src/verbs/prepare/compile-capsule.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import {
  partitionDelegationBatch,
  type DelegationBatch,
} from '../../../../src/verbs/prepare/partition-tasks.js';
import { adjudicateSettlement } from '../../../../src/verbs/settle/adjudicate.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';

function featureDefinition(): NonNullable<ReturnType<typeof lowerBuiltInDefinition>> {
  const lowered = lowerBuiltInDefinition('feature');
  if (lowered === undefined) throw new Error('the feature workflow did not lower');
  return lowered;
}

function batchOf(tasks: readonly unknown[]): DelegationBatch {
  const outcome = partitionDelegationBatch(tasks);
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome.batch;
}

/** The design reference of the fixture workflow. */
const DESIGN_REF = 'docs/specs/feature.md';

function input(overrides: Partial<CompileCapsuleInput> = {}): CompileCapsuleInput {
  return {
    workflowId: 'feat-prepare-unit',
    capsuleVersion: 1,
    lowered: featureDefinition(),
    batch: batchOf([
      { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
      { id: 'T-2', title: 'second', status: 'pending', blockedBy: ['T-1'] },
      { id: 'T-3', title: 'third', status: 'pending', blockedBy: [] },
    ]),
    catalogInvariants: [],
    designRef: DESIGN_REF,
    designVersion: 1,
    designRevisions: [],
    acceptedChanges: [],
    compilerVersion: PREPARE_COMPILER_VERSION,
    baseRef: 'feature/prepare-unit',
    executionProfile: { capabilities: ['fs:read', 'shell:exec'] },
    verificationSequence: (riskTier, boundaryTouching) => resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
    compiledAt: '2026-09-12T00:00:00Z',
    ...overrides,
  };
}

/** The statement that binds the design reference of the fixture workflow. */
const DESIGN_OF_RECORD = `The design of record is ${DESIGN_REF}.`;

/** The actor of each accepted change in the fixtures. */
const ACTOR = 'human:reviewer';

/** The most characters that a capsule keeps of a deviation statement, and of a proposed change. */
const TEXT_LIMIT = 280;

/** The mark that ends a text that the compiler cut. */
const CUT_MARK = '...';

/**
 * One design revision row, as `settle` records it for a decision round. The revision moves the
 * design to `nextDesignVersion`, and it names the given deviation ids and affected tasks.
 * Each version has its own bundle reference. No case of this file resolves it.
 */
function revisionRow(
  nextDesignVersion: number,
  deviationIds: readonly string[],
  affectedTasks: readonly string[] = [],
): DesignRevised {
  return DesignRevisedData.parse({
    operationId: `settle:round-of-version-${nextDesignVersion}`,
    workflowId: 'feat-prepare-unit',
    capsuleVersion: 1,
    batchId: `batch-of-version-${nextDesignVersion}`,
    priorDesignVersion: nextDesignVersion - 1,
    nextDesignVersion,
    deviationIds,
    affectedTasks,
    bundleRefs: [
      {
        artifactId: `run-bundle:settlement-adjudication:batch-of-version-${nextDesignVersion}:1`,
        digest: { algorithm: 'sha256', value: nextDesignVersion.toString(16).padStart(64, '0') },
      },
    ],
  });
}

/**
 * The accepted change of a deviation id. Its statement holds the id, so each statement is distinct.
 * The change names the given tasks as affected, as the settlement bundle of its revision holds them.
 */
function acceptedChange(deviationId: string, affectedTasks: readonly string[] = []): AcceptedDesignChange {
  return {
    deviationId,
    actor: ACTOR,
    statement: `the finding of ${deviationId}`,
    ...(affectedTasks.length > 0 ? { affectedTasks } : {}),
  };
}

/** The statement that a capsule binds for `acceptedChange(deviationId)` at a design version. */
function changeStatement(nextDesignVersion: number, deviationId: string): string {
  return (
    `Design version ${nextDesignVersion} holds an accepted change. Decided by "${ACTOR}". ` +
    `Deviation: "the finding of ${deviationId}".`
  );
}

/** The rationale statements of a compiled capsule. A refused compilation fails the case. */
function rationaleOf(overrides: Partial<CompileCapsuleInput>): string[] {
  const outcome = compileDelegationCapsule(input(overrides));
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome.capsule.knowledge.rationale.map((entry) => entry.statement);
}

/** The tasks of the fixture batch. The second task of the fixture plan waits on the first, so the batch lacks it. */
const ORDERING_BATCH: readonly string[] = ['T-1', 'T-3'];

/** The tasks that each change of the ordering fixture names as affected. A change that is absent here names none. */
const ORDERING_TASKS: Readonly<Record<string, readonly string[]>> = {
  'dev:v3': ['T-3'],
  'dev:v4': ['T-9'],
  'dev:v5-a': ['T-1'],
  'dev:v5-b': ['T-9'],
  'dev:v8': ['T-9'],
  'dev:v11-b': ['T-2'],
};

/** One row of the ordering fixture. As `settle` records it, the row names each task that its changes name. */
function orderingRow(nextDesignVersion: number, deviationIds: readonly string[]): DesignRevised {
  const affectedTasks = [...new Set(deviationIds.flatMap((deviationId) => ORDERING_TASKS[deviationId] ?? []))].sort();
  return revisionRow(nextDesignVersion, deviationIds, affectedTasks);
}

/**
 * Ten revisions that name twelve changes. Two changes name a task of the batch.
 * They are the second deviation of version 5 and the one deviation of version 3.
 */
const ORDERING_ROWS: readonly DesignRevised[] = [
  orderingRow(2, ['dev:v2']),
  orderingRow(3, ['dev:v3']),
  orderingRow(4, ['dev:v4']),
  orderingRow(5, ['dev:v5-b', 'dev:v5-a']),
  orderingRow(6, ['dev:v6']),
  orderingRow(7, ['dev:v7']),
  orderingRow(8, ['dev:v8']),
  orderingRow(9, ['dev:v9']),
  orderingRow(10, ['dev:v10']),
  orderingRow(11, ['dev:v11-b', 'dev:v11-a']),
];

/** The design versions of the revisions that the selection reads from the ordering fixture, in read order. */
const ORDERING_READ: readonly number[] = [5, 3, 11, 10, 9, 8, 7];

/** The eight changes that a capsule binds from the ordering fixture, in statement order. */
const ORDERING_BOUND: readonly (readonly [number, string])[] = [
  [5, 'dev:v5-a'],
  [3, 'dev:v3'],
  [11, 'dev:v11-b'],
  [11, 'dev:v11-a'],
  [10, 'dev:v10'],
  [9, 'dev:v9'],
  [8, 'dev:v8'],
  [7, 'dev:v7'],
];

/** The accepted changes of the fixture revisions with the given design versions, as their bundles hold them. */
function orderingChangesOf(versions: readonly number[]): AcceptedDesignChange[] {
  return ORDERING_ROWS.filter((row) => versions.includes(row.nextDesignVersion)).flatMap((row) =>
    row.deviationIds.map((deviationId) => acceptedChange(deviationId, ORDERING_TASKS[deviationId])),
  );
}

describe('delegation capsule compilation', () => {
  /** The test checks the schema and the references itself, so a compiler that skips its own validation still fails here. */
  it('Compile_ARealBatch_ParsesAndResolvesAgainstThePinnedDefinition', () => {
    const outcome = compileDelegationCapsule(input());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    const { capsule } = outcome;
    expect(ExarchosCapsuleV1Schema.safeParse(capsule).success).toBe(true);
    expect(resolveCapsuleReferences(capsule, { definition: featureDefinition().definition }).ok).toBe(true);
    expect(capsule.identity.definitionVersion).toBe(featureDefinition().definitionVersion);
    expect(capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-1', 'T-3']);
    expect(capsule.graph.dependencies).toEqual([]);
    expect(capsule.graph.joins).toEqual([{ joinId: 'batch-complete', waitsFor: ['T-1', 'T-3'], mode: 'all' }]);
    expect(capsule.settlementContract.requiredResults).toEqual(['T-1', 'T-3']);
  });

  it('Compile_TheCompletionPredicate_IsTheTaskObligationWithoutTeamTeardown', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { declares } = outcome.capsule.graph.completionPredicate;
    const fields = Object.keys(declares.fields).sort();
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.startsWith('tasks.'))).toBe(true);
    expect(fields).not.toContain('team.disbandedOk');
  });

  /**
   * A runtime returns where it worked and what it produced, but no evidence and no verified flag.
   * Settlement derives both from the task verification against that worktree, so a result cannot certify itself.
   * The evidence kinds are the ladder gate classes from the registry.
   */
  it('Compile_EveryTaskResult_RequiresTheWorktree_AndCarriesNoEvidence', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const results = outcome.capsule.contracts.taskResults;
    expect(Object.keys(results).sort()).toEqual(['T-1', 'T-3']);
    for (const fields of Object.values(results)) {
      expect(fields.find((field) => field.name === 'worktreePath')).toEqual({
        name: 'worktreePath',
        type: 'string',
        required: true,
      });
      expect(fields.find((field) => field.name === 'branch')).toEqual({
        name: 'branch',
        type: 'string',
        required: false,
      });
      const names = fields.map((field) => field.name);
      expect(names).not.toContain('taskId');
      expect(names).not.toContain('evidence');
      expect(names).not.toContain('verified');
      expect(names).toEqual(expect.arrayContaining(['artifacts', 'files', 'tests', 'implements', 'duration']));
    }
    expect(outcome.capsule.contracts.evidenceKinds).toEqual([
      'static-analysis',
      'test-adequacy',
      'integration-suite',
      'contract-drift',
      'mock-boundary',
    ]);
  });

  /**
   * The planner stamp wins. Otherwise the file-and-layer heuristic decides, and a task with no signal is medium and not boundary-touching.
   * The terms live in the settlement contract and not on the graph node. The tier chooses the gates, so a runtime must not choose its own.
   */
  it('Compile_EveryTask_CarriesTheVerificationTermsThePlanResolves', () => {
    const outcome = compileDelegationCapsule(
      input({
        batch: batchOf([
          { id: 'T-1', title: 'stamped', status: 'pending', blockedBy: [], riskTier: 'high', boundaryTouching: false },
          { id: 'T-2', title: 'plain', status: 'pending', blockedBy: [] },
          { id: 'T-3', title: 'adapter', status: 'pending', blockedBy: [], testLayer: 'integration' },
        ]),
      }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.settlementContract.taskVerification).toEqual({
      'T-1': { riskTier: 'high', boundaryTouching: false, baseRef: 'feature/prepare-unit' },
      'T-2': { riskTier: 'medium', boundaryTouching: false, baseRef: 'feature/prepare-unit' },
      'T-3': { riskTier: 'medium', boundaryTouching: true, baseRef: 'feature/prepare-unit' },
    });
    expect(outcome.capsule.graph.tasks[0]).toEqual({ taskId: 'T-1', title: 'stamped', stepId: 'delegate' });
  });

  /** An empty profile says nothing, so the compiler omits the optional section. */
  it('Compile_TheExecutionProfile_IsAttachedAsHandedIn_AndOmittedWhenEmpty', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.executionProfile).toEqual({ capabilities: ['fs:read', 'shell:exec'] });
    const bare = compileDelegationCapsule(input({ executionProfile: { capabilities: [] } }));
    if (!bare.ok) throw new Error(bare.refusal.message);
    expect(bare.capsule.executionProfile).toBeUndefined();
  });

  /** One statement for each distinct profile in the batch, in profile order, from the policy resolver. */
  it('Compile_TheBoundKnowledge_NamesTheGatesEachTierIsVerifiedBy', () => {
    const outcome = compileDelegationCapsule(
      input({
        batch: batchOf([
          { id: 'T-1', title: 'stamped', status: 'pending', blockedBy: [], riskTier: 'high', boundaryTouching: true },
          { id: 'T-2', title: 'plain', status: 'pending', blockedBy: [] },
          { id: 'T-3', title: 'plain too', status: 'pending', blockedBy: [] },
        ]),
      }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.knowledge.patterns.map((p) => p.statement)).toEqual([
      'A task at riskTier=high, boundaryTouching=true is verified at settlement by: check_static_analysis, check_test_adequacy, check_integration_suite, check_contract_drift, check_mock_boundary.',
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_static_analysis, check_test_adequacy.',
    ]);
  });

  /** Settlement reads the material kinds from the pinned capsule, so the compiler must write them there. */
  it('Compile_TheEnvelope_PinsTheMaterialKinds', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.contracts.deviationEnvelope.materialDeviationKinds).toEqual(['invalidated-assumption']);
  });

  /**
   * The envelope refuses a deviation of a kind that is not allowed, so a material kind outside the allowed kinds never applies.
   * The length assertion keeps the comparison from passing on an empty list.
   */
  it('Compile_EachMaterialKind_IsAlsoAnAllowedKind', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { allowedDeviationKinds, materialDeviationKinds } = outcome.capsule.contracts.deviationEnvelope;
    const material = materialDeviationKinds ?? [];
    expect(material.length).toBeGreaterThan(0);
    expect(material.filter((kind) => !allowedDeviationKinds.includes(kind))).toEqual([]);
  });

  /**
   * The identity carries the id of the counter that the caller passes in, and no part of the design reference.
   * The digest of the reference is a provenance source, and a new counter does not move it.
   * The last comparison puts the first id back, so the counter changes nothing else in the capsule.
   */
  it('Compile_TheDesignVersion_IsTheIdOfTheCounterAndTheReferenceDigestStaysInProvenance', () => {
    const first = compileDelegationCapsule(input());
    const revised = compileDelegationCapsule(input({ designVersion: 2 }));
    const unbound = compileDelegationCapsule(input({ designRef: undefined }));
    if (!first.ok) throw new Error(first.refusal.message);
    if (!revised.ok) throw new Error(revised.refusal.message);
    if (!unbound.ok) throw new Error(unbound.refusal.message);

    expect(first.capsule.identity.designVersion).toBe('design-v1');
    expect(revised.capsule.identity.designVersion).toBe('design-v2');
    expect(unbound.capsule.identity.designVersion).toBe('design-v1');

    const designRecords = (outcome: typeof first): unknown[] =>
      outcome.capsule.provenance.sources.filter((source) => source.sourceId === 'design-record');
    expect(designRecords(first)).toEqual([{ sourceId: 'design-record', digest: contentDigest(DESIGN_REF) }]);
    expect(designRecords(revised)).toEqual(designRecords(first));
    expect(designRecords(unbound)).toEqual([]);

    expect({
      ...revised.capsule,
      identity: { ...revised.capsule.identity, designVersion: first.capsule.identity.designVersion },
    }).toEqual(first.capsule);
  });

  /** The handler keys its replay claim on the same name, so the provenance must carry the name that the caller passes. */
  it('Compile_TheProvenance_NamesTheCompilerThatTheCallerPasses', () => {
    const current = compileDelegationCapsule(input());
    const earlier = compileDelegationCapsule(input({ compilerVersion: 'exarchos-prepare-earlier' }));
    if (!current.ok) throw new Error(current.refusal.message);
    if (!earlier.ok) throw new Error(earlier.refusal.message);
    expect(current.capsule.provenance.compilerVersion).toBe(PREPARE_COMPILER_VERSION);
    expect(earlier.capsule.provenance.compilerVersion).toBe('exarchos-prepare-earlier');
  });

  /**
   * This case is the denominator for the refusal cases below.
   * A compiler that emits terms that cannot settle passes the structural tests in this file.
   */
  it('Compile_ACompiledCapsule_IsOneTheRealAdjudicatorCanSettle', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const claims = ['T-1', 'T-3'].map((taskId) => ({
      taskId,
      fields: { worktreePath: `/worktrees/${taskId}`, files: ['src/a.ts'] },
      evidence: [],
    }));
    const verdict = adjudicateSettlement(outcome.capsule, claims, [], { evidenceResolves: () => true });
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
  });

  it('Compile_ACyclicBatch_IsRefusedAsUnsound', () => {
    const terms = { riskTier: 'medium', boundaryTouching: false } as const;
    const outcome = compileDelegationCapsule(
      input({
        batch: {
          tasks: [
            { taskId: 'T-1', title: 'first', stepId: 'delegate', verification: terms },
            { taskId: 'T-2', title: 'second', stepId: 'delegate', verification: terms },
          ],
          dependencies: [
            { from: 'T-1', to: 'T-2' },
            { from: 'T-2', to: 'T-1' },
          ],
          joins: [],
          requiredResults: ['T-1', 'T-2'],
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('CAPSULE_UNSOUND');
      expect(outcome.refusal.message).toContain('cycle');
    }
  });

  /** Tasks name the step `delegate`, so a pinned definition without that step cannot be the one they ran under. */
  it('Compile_ADefinitionWithoutTheDelegationStep_IsRefusedAsUnsound', () => {
    const lowered = featureDefinition();
    const withoutDelegate = {
      ...lowered,
      definition: {
        ...lowered.definition,
        steps: lowered.definition.steps.filter((step) => step.stepId !== 'delegate'),
        transitions: lowered.definition.transitions.filter(
          (t) => t.fromStepId !== 'delegate' && t.toStepId !== 'delegate',
        ),
      },
    };
    const outcome = compileDelegationCapsule(input({ lowered: withoutDelegate }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('CAPSULE_UNSOUND');
      expect(outcome.refusal.message).toContain('delegate');
    }
  });

  it('Compile_CatalogInvariants_AreBoundOnTopOfTheBuiltInAuthority', () => {
    const outcome = compileDelegationCapsule(
      input({ catalogInvariants: [{ id: 'INV-1', summary: 'a catalog statement' }] }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const ids = outcome.capsule.authority.invariants.map((i) => i.id);
    expect(ids).toContain('INV-1');
    expect(ids).toContain('append-only-history');
  });

  it('Compile_TheSameInputs_CompileTheSameCapsule', () => {
    const first = compileDelegationCapsule(input());
    const second = compileDelegationCapsule(input());
    expect(second).toEqual(first);
  });
});

/**
 * A capsule under a revised design states the accepted changes that the revision rows name.
 * The batch of the fixture holds the first task and the third task of its plan.
 * Thus a row that names one of the two names a task of the capsule.
 */
describe('delegation capsule compilation — the accepted design changes', () => {
  /**
   * A capsule that an earlier compiler recorded holds no statement of an accepted change.
   * The handler keys its replay claim on this name, so the raised name compiles that capsule again.
   */
  it('Compile_TheCompilerVersion_IsRaisedWithTheStatementBinding', () => {
    expect(PREPARE_COMPILER_VERSION).toBe('exarchos-prepare-3');

    const outcome = compileDelegationCapsule(
      input({
        designVersion: 2,
        designRevisions: [revisionRow(2, ['dev:one'])],
        acceptedChanges: [acceptedChange('dev:one')],
      }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.provenance.compilerVersion).toBe('exarchos-prepare-3');
    expect(outcome.capsule.knowledge.rationale.map((entry) => entry.statement)).toEqual([
      DESIGN_OF_RECORD,
      changeStatement(2, 'dev:one'),
    ]);
  });

  /** A capsule with no design of record still states the change. A stream with no revision states none. */
  it('Compile_ARevisionWithNoDesignOfRecord_StillStatesTheChange', () => {
    const revised = { designRevisions: [revisionRow(2, ['dev:one'])], acceptedChanges: [acceptedChange('dev:one')] };
    expect(rationaleOf({ ...revised, designRef: undefined })).toEqual([changeStatement(2, 'dev:one')]);
    expect(rationaleOf({ acceptedChanges: [acceptedChange('dev:one')] })).toEqual([DESIGN_OF_RECORD]);
  });

  /**
   * The texts of the first change are far over the limit, and those of the second are one character over it.
   * A cut text keeps its start and ends with the mark, and the mark counts in the limit.
   * The texts of the third change are at the limit, and they stay whole.
   * Each statement holds the proposed change and the deviation.
   */
  it('Compile_ALongStatementAndALongProposedChange_AreEachCutAndBothKept', () => {
    const kept = TEXT_LIMIT - CUT_MARK.length;
    expect(kept).toBe(277);
    const changeOf = (deviationId: string, length: number): AcceptedDesignChange => ({
      deviationId,
      actor: ACTOR,
      statement: 's'.repeat(length),
      proposedChange: 'p'.repeat(length),
    });
    const changes = [
      changeOf('dev:far-over', 5000),
      changeOf('dev:one-over', TEXT_LIMIT + 1),
      changeOf('dev:at-the-limit', TEXT_LIMIT),
    ];
    const cut =
      `Design version 2 holds an accepted change. Decided by "${ACTOR}". ` +
      `Proposed change: "${'p'.repeat(kept)}${CUT_MARK}". Deviation: "${'s'.repeat(kept)}${CUT_MARK}".`;
    const whole =
      `Design version 2 holds an accepted change. Decided by "${ACTOR}". ` +
      `Proposed change: "${'p'.repeat(TEXT_LIMIT)}". Deviation: "${'s'.repeat(TEXT_LIMIT)}".`;

    const rationale = rationaleOf({
      designVersion: 2,
      designRevisions: [revisionRow(2, changes.map((change) => change.deviationId))],
      acceptedChanges: changes,
    });
    expect(rationale).toEqual([DESIGN_OF_RECORD, cut, cut, whole]);
  });

  /**
   * The words of a worker stay in JSON quotes, so a line feed or a quote in them does not end the statement.
   * A cut does not split a surrogate pair. A long actor name is cut by its own limit.
   */
  it('Compile_ATextWithALineFeedOrAPairAtTheCut_StaysOneWellFormedLine', () => {
    const pair = String.fromCodePoint(0x1f600);
    const [statement] = rationaleOf({
      designRef: undefined,
      designRevisions: [revisionRow(2, ['dev:one'])],
      acceptedChanges: [
        {
          deviationId: 'dev:one',
          actor: 'a'.repeat(200),
          statement: `${'s'.repeat(276)}${pair}${'s'.repeat(40)}`,
          proposedChange: 'line one\nline "two"',
        },
      ],
    });
    expect(statement).toBe(
      `Design version 2 holds an accepted change. Decided by "${'a'.repeat(77)}${CUT_MARK}". ` +
        `Proposed change: "line one\\nline \\"two\\"". Deviation: "${'s'.repeat(276)}${CUT_MARK}".`,
    );
    expect(statement).not.toMatch(/[\r\n]/);
  });

  /**
   * Ten revisions name twelve changes, because two revisions cover two deviations each.
   * Two changes name a task of the batch, so they come first, the one of the newer revision ahead.
   * One of them is the second deviation of its row, and the first deviation of that row is not bound.
   * The other changes follow from the newest revision down, and the two of one revision keep its order.
   * The compiler gets only the changes of the seven revisions that it binds. The last statement counts the other four.
   *
   * The order of the rows in the input does not move the statements.
   * Seven revisions that name eight changes bind them all, with no count.
   */
  it('Compile_MoreThanEightChanges_BindsThoseThatNameItsTasksFirstAndCountsTheRest', () => {
    expect(ORDERING_ROWS.flatMap((row) => row.deviationIds)).toHaveLength(12);
    expect(ORDERING_ROWS.find((row) => row.nextDesignVersion === 5)?.deviationIds).toEqual(['dev:v5-b', 'dev:v5-a']);
    const overrides = {
      designVersion: 11,
      designRevisions: ORDERING_ROWS,
      acceptedChanges: orderingChangesOf(ORDERING_READ),
    };
    expect(overrides.acceptedChanges).toHaveLength(9);

    const rationale = rationaleOf(overrides);
    expect(rationale).toEqual([
      DESIGN_OF_RECORD,
      ...ORDERING_BOUND.map(([version, deviationId]) => changeStatement(version, deviationId)),
      '4 more accepted design change(s) are not stated in this capsule. ' +
        'The design.revised rows of the workflow stream name each one.',
    ]);
    expect(rationaleOf({ ...overrides, designRevisions: [...ORDERING_ROWS].reverse() })).toEqual(rationale);

    const exactlyEight = ORDERING_ROWS.filter((row) => ![2, 4, 5].includes(row.nextDesignVersion));
    const versions = exactlyEight.map((row) => row.nextDesignVersion);
    expect(exactlyEight.flatMap((row) => row.deviationIds)).toHaveLength(8);
    expect(rationaleOf({ ...overrides, designRevisions: exactlyEight, acceptedChanges: orderingChangesOf(versions) })).toEqual([
      DESIGN_OF_RECORD,
      changeStatement(3, 'dev:v3'),
      changeStatement(11, 'dev:v11-b'),
      changeStatement(11, 'dev:v11-a'),
      changeStatement(10, 'dev:v10'),
      changeStatement(9, 'dev:v9'),
      changeStatement(8, 'dev:v8'),
      changeStatement(7, 'dev:v7'),
      changeStatement(6, 'dev:v6'),
    ]);
  });

  /**
   * The walk starts with no read revision. Each answer names one revision, and the case gives the
   * changes of that revision, as the handler does after it reads the bundle.
   * The walk asks first for the two revisions that name a task of the batch, the newer one ahead.
   * Then it asks for the other revisions from the newest down, until eight changes are bound.
   * It asks for no revision twice, and it never asks for the three revisions that it does not bind.
   */
  it('SelectDesignChanges_FromNoReadRevision_AsksForEachBoundRevisionOnceAndForNoOther', () => {
    const asked: number[] = [];
    const given: AcceptedDesignChange[] = [];
    let selection = selectDesignChanges(ORDERING_ROWS, ORDERING_BATCH, given);
    for (let step = 0; step < ORDERING_ROWS.length && !selection.complete; step += 1) {
      asked.push(selection.unread.nextDesignVersion);
      expect(selection.unread.deviationIds).toContain(selection.lacking);
      given.push(...orderingChangesOf([selection.unread.nextDesignVersion]));
      selection = selectDesignChanges(ORDERING_ROWS, ORDERING_BATCH, given);
    }

    expect(asked).toEqual(ORDERING_READ);
    if (!selection.complete) throw new Error('the selection is not complete after each revision that it asked for');
    expect(selection.bound.map(({ revision, change }) => [revision.nextDesignVersion, change.deviationId])).toEqual(
      ORDERING_BOUND,
    );
    expect(selection.leftOut).toBe(4);
  });

  /**
   * Nine revisions each name a task of the batch, and a newer one names none.
   * The first group alone fills the eight places, so the walk stops in its first pass.
   * It asks for the eight newest of the nine, and it never asks for the ninth or for the other revision.
   * Changes of a revision that the walk did not ask for give the same selection.
   */
  it('SelectDesignChanges_MoreRevisionsThatNameABatchTaskThanPlaces_BindsTheNewestAndAsksForNoOther', () => {
    const naming = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    const rows = [
      ...naming.map((version) => revisionRow(version, [`dev:names-${version}`], ['T-1'])),
      revisionRow(11, ['dev:names-none']),
    ];
    const changesOf = (version: number): AcceptedDesignChange[] =>
      version === 11
        ? [acceptedChange('dev:names-none')]
        : [acceptedChange(`dev:names-${version}`, ['T-1'])];
    const newestEight = [10, 9, 8, 7, 6, 5, 4, 3];

    const asked: number[] = [];
    const given: AcceptedDesignChange[] = [];
    let selection = selectDesignChanges(rows, ORDERING_BATCH, given);
    for (let step = 0; step < rows.length && !selection.complete; step += 1) {
      asked.push(selection.unread.nextDesignVersion);
      given.push(...changesOf(selection.unread.nextDesignVersion));
      selection = selectDesignChanges(rows, ORDERING_BATCH, given);
    }

    expect(asked).toEqual(newestEight);
    if (!selection.complete) throw new Error('the selection is not complete after each revision that it asked for');
    const boundOf = (bound: typeof selection.bound): number[] => bound.map(({ revision }) => revision.nextDesignVersion);
    expect(boundOf(selection.bound)).toEqual(newestEight);
    expect(selection.leftOut).toBe(2);

    const withSurplus = selectDesignChanges(rows, ORDERING_BATCH, [...changesOf(11), ...changesOf(2), ...given]);
    if (!withSurplus.complete) throw new Error('the selection is not complete with surplus changes');
    expect(boundOf(withSurplus.bound)).toEqual(newestEight);
    expect(withSurplus.leftOut).toBe(2);
  });

  /**
   * A row that `settle` records names each task that its changes name. Two rows here do not.
   * The change of version 3 names a task of the batch, and its row names no task.
   * The row of version 4 names a task of the batch, and its change names none.
   * A change is in the first group only when its row and the change both name a task of the batch.
   * Thus both changes are bound with the rest, from the newest revision down, and none is lost.
   */
  it('SelectDesignChanges_ARowThatDisagreesWithItsChangeAboutABatchTask_BindsTheChangeWithTheRest', () => {
    const rows = [
      revisionRow(2, ['dev:both-name'], ['T-1']),
      revisionRow(3, ['dev:change-names'], []),
      revisionRow(4, ['dev:row-names'], ['T-3']),
    ];
    const changes = [
      acceptedChange('dev:both-name', ['T-1']),
      acceptedChange('dev:change-names', ['T-1']),
      acceptedChange('dev:row-names'),
    ];

    const selection = selectDesignChanges(rows, ORDERING_BATCH, changes);

    if (!selection.complete) throw new Error('the selection is not complete with each change given');
    expect(selection.bound.map(({ revision, change }) => [revision.nextDesignVersion, change.deviationId])).toEqual([
      [2, 'dev:both-name'],
      [4, 'dev:row-names'],
      [3, 'dev:change-names'],
    ]);
    expect(selection.leftOut).toBe(0);
  });

  /**
   * A text of 300 characters keeps its first 277 characters and gets the mark, so it is 280 long.
   * A text of 280 characters stays whole.
   *
   * In each other text, the last kept position holds a code unit at an edge of the high surrogate range.
   * The first and the last high surrogate are each cut with the pair that they start.
   * The unit before the range stays, and so does a low surrogate, which ends a pair that is whole.
   */
  it('Compile_ACutAtTheLimit_KeepsExactlyTheLimitAndNeverHalfAPair', () => {
    const kept = TEXT_LIMIT - CUT_MARK.length;
    const statedFor = (statement: string): string => {
      const [stated] = rationaleOf({
        designRef: undefined,
        designRevisions: [revisionRow(2, ['dev:one'])],
        acceptedChanges: [{ deviationId: 'dev:one', actor: ACTOR, statement }],
      });
      if (stated === undefined) throw new Error('the capsule states no change');
      return stated;
    };
    const stating = (text: string): string =>
      `Design version 2 holds an accepted change. Decided by "${ACTOR}". Deviation: "${text}".`;

    expect(statedFor('s'.repeat(300))).toBe(stating(`${'s'.repeat(277)}${CUT_MARK}`));
    expect(`${'s'.repeat(277)}${CUT_MARK}`).toHaveLength(TEXT_LIMIT);
    expect(statedFor('s'.repeat(TEXT_LIMIT))).toBe(stating('s'.repeat(TEXT_LIMIT)));

    const unit = (code: number): string => String.fromCharCode(code);
    const head = 's'.repeat(kept - 1);
    const tail = 's'.repeat(40);
    const firstPair = `${unit(0xd800)}${unit(0xdc00)}`;
    const lastPair = `${unit(0xdbff)}${unit(0xdfff)}`;
    expect(statedFor(`${head}${firstPair}${tail}`)).toBe(stating(`${head}${CUT_MARK}`));
    expect(statedFor(`${head}${lastPair}${tail}`)).toBe(stating(`${head}${CUT_MARK}`));
    expect(statedFor(`${head}${unit(0xd7ff)}${tail}`)).toBe(stating(`${head}${unit(0xd7ff)}${CUT_MARK}`));
    const pairThatEndsAtTheCut = `${'s'.repeat(kept - 2)}${firstPair}`;
    expect(pairThatEndsAtTheCut).toHaveLength(kept);
    expect(statedFor(`${pairThatEndsAtTheCut}${tail}`)).toBe(stating(`${pairThatEndsAtTheCut}${CUT_MARK}`));
  });

  /** The compiler states no placeholder. A bound change that the caller did not pass refuses the compilation. */
  it('Compile_ABoundChangeThatTheInputLacks_IsRefusedAsUnreadable', () => {
    const outcome = compileDelegationCapsule(
      input({
        designVersion: 3,
        designRevisions: [revisionRow(2, ['dev:read']), revisionRow(3, ['dev:not-read'])],
        acceptedChanges: [acceptedChange('dev:read')],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('REVISION_UNREADABLE');
      expect(outcome.refusal.message).toContain('"dev:not-read"');
      expect(outcome.refusal.message).toContain('design version 3');
    }
  });

  /**
   * The source pins each revision row of the stream, and not only the rows that the capsule binds.
   * A stream with no revision has no such source. The other sources do not move with the rows.
   */
  it('Compile_ACapsuleAfterARevision_NamesTheRevisionsInItsProvenance', () => {
    const one = [revisionRow(2, ['dev:one'], ['T-1'])];
    const two = [...one, revisionRow(3, ['dev:two'])];
    const changes = [acceptedChange('dev:one'), acceptedChange('dev:two')];
    const sourcesOf = (overrides: Partial<CompileCapsuleInput>): { sourceId: string; digest: string }[] => {
      const outcome = compileDelegationCapsule(input(overrides));
      if (!outcome.ok) throw new Error(outcome.refusal.message);
      return [...outcome.capsule.provenance.sources];
    };
    const revisionsIn = (sources: readonly { sourceId: string; digest: string }[]): unknown[] =>
      sources.filter((source) => source.sourceId === 'design-revisions');

    const none = sourcesOf({});
    const first = sourcesOf({ designVersion: 2, designRevisions: one, acceptedChanges: changes });
    const second = sourcesOf({ designVersion: 3, designRevisions: two, acceptedChanges: changes });

    expect(revisionsIn(none)).toEqual([]);
    expect(revisionsIn(first)).toEqual([{ sourceId: 'design-revisions', digest: contentDigest(one) }]);
    expect(revisionsIn(second)).toEqual([{ sourceId: 'design-revisions', digest: contentDigest(two) }]);
    expect(contentDigest(two)).not.toBe(contentDigest(one));
    expect(first.filter((source) => source.sourceId !== 'design-revisions')).toEqual(none);
    expect(second.filter((source) => source.sourceId !== 'design-revisions')).toEqual(none);
  });
});

describe('catalog invariant binding', () => {
  it('BindCatalog_AppendsInCatalogOrderAndBindsEachIdOnce', () => {
    const base = builtInWorkflowAuthority();
    const bound = bindCatalogInvariants(base, [
      { id: 'INV-2', summary: 'second' },
      { id: 'INV-2', summary: 'duplicate' },
      { id: 'append-only-history', summary: 'already in the base' },
      { id: 'INV-3', summary: '   ' },
      { id: 'INV-4', summary: 'fourth' },
    ]);
    const added = bound.invariants.slice(base.invariants.length);
    expect(added).toEqual([
      { id: 'INV-2', statement: 'second' },
      { id: 'INV-4', statement: 'fourth' },
    ]);
  });

  it('BindCatalog_AnEmptyCatalog_LeavesTheBaseAsItIs', () => {
    const base = builtInWorkflowAuthority();
    expect(bindCatalogInvariants(base, [])).toEqual(base);
  });
});
