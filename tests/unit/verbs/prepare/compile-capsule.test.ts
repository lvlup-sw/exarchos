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

/** The accepted change of a deviation id. Its statement holds the id, so each statement is distinct. */
function acceptedChange(deviationId: string): AcceptedDesignChange {
  return { deviationId, actor: ACTOR, statement: `the finding of ${deviationId}` };
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
   * Ten revisions name eleven changes, because the newest revision covers two deviations.
   * Two old revisions name a task of the batch, so their changes come first, the newer one ahead.
   * The other changes follow from the newest revision down, and the two of one revision keep its order.
   * The compiler gets only the eight changes that it binds. The last statement counts the other three.
   *
   * The order of the rows in the input does not move the statements.
   * Seven revisions that name eight changes bind them all, with no count.
   */
  it('Compile_MoreThanEightChanges_BindsThoseThatNameItsTasksFirstAndCountsTheRest', () => {
    const designRevisions = [
      revisionRow(2, ['dev:v2']),
      revisionRow(3, ['dev:v3'], ['T-3']),
      revisionRow(4, ['dev:v4'], ['T-9']),
      revisionRow(5, ['dev:v5'], ['T-1', 'T-9']),
      revisionRow(6, ['dev:v6']),
      revisionRow(7, ['dev:v7']),
      revisionRow(8, ['dev:v8'], ['T-9']),
      revisionRow(9, ['dev:v9']),
      revisionRow(10, ['dev:v10']),
      revisionRow(11, ['dev:v11-b', 'dev:v11-a'], ['T-2']),
    ];
    expect(designRevisions.flatMap((row) => row.deviationIds)).toHaveLength(11);
    const bound: readonly (readonly [number, string])[] = [
      [5, 'dev:v5'],
      [3, 'dev:v3'],
      [11, 'dev:v11-b'],
      [11, 'dev:v11-a'],
      [10, 'dev:v10'],
      [9, 'dev:v9'],
      [8, 'dev:v8'],
      [7, 'dev:v7'],
    ];
    const overrides = {
      designVersion: 11,
      designRevisions,
      acceptedChanges: bound.map(([, deviationId]) => acceptedChange(deviationId)),
    };

    const rationale = rationaleOf(overrides);
    expect(rationale).toEqual([
      DESIGN_OF_RECORD,
      ...bound.map(([version, deviationId]) => changeStatement(version, deviationId)),
      '3 more accepted design change(s) are not stated in this capsule. ' +
        'The design.revised rows of the workflow stream name each one.',
    ]);
    expect(rationaleOf({ ...overrides, designRevisions: [...designRevisions].reverse() })).toEqual(rationale);

    const exactlyEight = designRevisions.slice(3);
    const ids = exactlyEight.flatMap((row) => row.deviationIds);
    expect(ids).toHaveLength(8);
    const whole = rationaleOf({
      ...overrides,
      designRevisions: exactlyEight,
      acceptedChanges: ids.map((deviationId) => acceptedChange(deviationId)),
    });
    expect(whole).toHaveLength(9);
    expect(whole.filter((statement) => statement.includes('more accepted design change'))).toEqual([]);
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
