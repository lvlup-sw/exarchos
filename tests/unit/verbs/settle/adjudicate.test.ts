// Tests for settlement adjudication against the capsule. Each case changes the capsule or the batch in one way.
//
// The cases start from the capsule contract's own fixture, so a schema change reaches them.
// The published contract accepts each capsule here. A case that also fails the schema tests the schema, not the adjudicator.
//
// @oracle-sources: ../../../../src/contract/capsule/exarchos-capsule-fixtures.ts, the capsule contract's own corpus which is authored for the schema round trip and not for this module, so a case here cannot be tuned to the assertion it feeds

import { describe, it, expect } from 'vitest';

import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import {
  SETTLEMENT_FINDING_CLASSES,
  SETTLEMENT_FINDING_KINDS,
  SETTLEMENT_OUTCOMES,
  acceptedMaterialDeviations,
  adjudicateSettlement,
  outcomeVerifies,
  verificationRuns,
  type AdjudicationContext,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementFinding,
  type SettlementFindingClass,
  type SettlementFindingKind,
  type SettlementOutcome,
  type SettlementVerdict,
  type TaskStanding,
  type TaskVerificationOutcome,
} from '../../../../src/verbs/settle/adjudicate.js';

/** The claim the base capsule's one required result is satisfied by. */
function passingClaim(): SettlementClaim {
  return {
    taskId: 'task-verify',
    fields: { passed: true },
    evidence: [{ kind: 'test', ref: 'run-1' }],
  };
}

/**
 * The shape pass's context: every cited reference resolves, and no
 * verification has run. The cases that bend either say so themselves.
 */
const RESOLVING: AdjudicationContext = { evidenceResolves: () => true };

/** A deviation inside the envelope of the base capsule that names the given tasks as affected. */
function affecting(...affectedTasks: string[]): ProposedDeviation {
  return { deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite', affectedTasks };
}

/**
 * The context of a first submission whose deviations name tasks. Each listed task stands as
 * given, and a task that is not listed is unknown to the plan.
 */
function standing(tasks: Readonly<Record<string, TaskStanding>>): AdjudicationContext {
  return {
    evidenceResolves: () => true,
    taskStanding: (taskId) => tasks[taskId] ?? { kind: 'unknown' },
  };
}

/**
 * The context of a batch on a capsule that later revisions followed. Each listed task is named by
 * a revision to the given design version, and no revision names a task that is not listed.
 */
function namedByALaterRevision(versions: Readonly<Record<string, number>>): AdjudicationContext {
  return {
    evidenceResolves: () => true,
    supersedingDesignVersion: (taskId) => versions[taskId],
  };
}

/**
 * The outcome that each finding class gives when no class before it is present. The list is in the
 * order of precedence, and it is written here apart from the table of the adjudicator.
 */
const OUTCOME_OF_CLASS: readonly (readonly [SettlementFindingClass, SettlementOutcome])[] = [
  ['stale', 'recompile-required'],
  ['refuse', 'rejected'],
  ['hold', 'deviation-pending'],
  ['unresolved', 'corrective-capsule'],
];

/** The outcome of a batch whose findings have exactly these classes. No class gives `settled`. */
function outcomeFor(classes: readonly SettlementFindingClass[]): SettlementOutcome {
  return OUTCOME_OF_CLASS.find(([findingClass]) => classes.includes(findingClass))?.[1] ?? 'settled';
}

interface AdjudicationCase {
  readonly name: string;
  readonly kind: SettlementFindingKind;
  /** The class that the kind must have. The batch of the case gives findings of this class only. */
  readonly findingClass: SettlementFindingClass;
  readonly at: string;
  readonly capsule: ExarchosCapsuleV1;
  readonly claims: readonly SettlementClaim[];
  readonly deviations?: readonly ProposedDeviation[];
  readonly context?: AdjudicationContext;
}

function bend(
  name: string,
  kind: SettlementFindingKind,
  findingClass: SettlementFindingClass,
  at: string,
  claims: readonly SettlementClaim[],
  mutate: (base: ExarchosCapsuleV1) => ExarchosCapsuleV1 = (b) => b,
  deviations?: readonly ProposedDeviation[],
  context?: AdjudicationContext,
): AdjudicationCase {
  return { name, kind, findingClass, at, capsule: mutate(baseValidCapsule()), claims, deviations, context };
}

const CASES: readonly AdjudicationCase[] = [
  bend('a claim for a task the graph does not declare', 'unknown-task', 'refuse', 'claims[1].taskId', [
    passingClaim(),
    { taskId: 'task-ghost', fields: {}, evidence: [] },
  ]),
  bend(
    'a claim for a task with no declared result shape',
    'undeclared-result-shape',
    'refuse',
    'claims[1].fields',
    [passingClaim(), { taskId: 'task-compile', fields: { anything: 1 }, evidence: [] }],
  ),
  bend('two claims for one task', 'duplicate-claim', 'refuse', 'claims[1].taskId', [
    passingClaim(),
    passingClaim(),
  ]),
  bend(
    'a claim for a task that a later revision names',
    'claim-superseded-by-revision',
    'stale',
    'claims[0].taskId',
    [passingClaim()],
    (b) => b,
    undefined,
    namedByALaterRevision({ 'task-verify': 2 }),
  ),
  bend('a required result the batch does not carry', 'missing-claim', 'refuse', 'claims', []),
  bend(
    'a required result the batch does not carry, for a task that a later revision names',
    'claim-superseded-by-revision',
    'stale',
    'claims',
    [passingClaim()],
    () => requiringBothTasks(),
    undefined,
    namedByALaterRevision({ 'task-compile': 2 }),
  ),
  bend('a required field the claim omits', 'missing-field', 'refuse', 'claims[0].fields', [
    { taskId: 'task-verify', fields: {}, evidence: [] },
  ]),
  bend(
    'a field arriving as the wrong type',
    'field-type-mismatch',
    'refuse',
    'claims[0].fields.passed',
    [{ taskId: 'task-verify', fields: { passed: 'yes' }, evidence: [] }],
  ),
  bend(
    'a field the result contract does not declare',
    'undeclared-field',
    'refuse',
    'claims[0].fields.smuggled',
    [{ taskId: 'task-verify', fields: { passed: true, smuggled: 1 }, evidence: [] }],
  ),
  bend(
    'evidence of a kind the capsule does not admit',
    'inadmissible-evidence',
    'refuse',
    'claims[0].evidence[0].kind',
    [{ taskId: 'task-verify', fields: { passed: true }, evidence: [{ kind: 'vibes', ref: 'r' }] }],
  ),
  bend(
    'evidence of an admitted kind whose reference does not resolve',
    'inadmissible-evidence',
    'refuse',
    'claims[0].evidence[0].ref',
    [passingClaim()],
    (b) => b,
    undefined,
    { evidenceResolves: () => false },
  ),
  bend(
    'an accepted claim whose verification halted',
    'verification-failed',
    'unresolved',
    'claims[0]',
    [passingClaim()],
    (b) => b,
    undefined,
    {
      evidenceResolves: () => true,
      verification: new Map([
        ['task-verify', { kind: 'failed', failedLeaf: 'task_complete', message: 'Required gates not passed' }],
      ]),
    },
  ),
  bend(
    'a deviation outside the envelope',
    'deviation-outside-envelope',
    'refuse',
    'deviations[0].deviationKind',
    [passingClaim()],
    (b) => b,
    [{ deviationKind: 'rewrote-the-charter', statement: 'seemed fine' }],
  ),
  bend(
    'a deviation inside an envelope that requires approval',
    'deviation-awaiting-approval',
    'hold',
    'deviations[0].deviationKind',
    [passingClaim()],
    (b) => b,
    [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
  ),
  bend(
    'a proposed deviation the decision refused',
    'deviation-rejected',
    'refuse',
    'deviations[0].deviationKind',
    [passingClaim()],
    (b) => b,
    [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
    { evidenceResolves: () => true, decided: () => 'rejected' },
  ),
  bend(
    'a deviation that names a task the plan does not hold',
    'deviation-unknown-task',
    'refuse',
    'deviations[0].affectedTasks[1]',
    [passingClaim()],
    (b) => b,
    [affecting('task-later', 'task-ghost')],
    standing({ 'task-later': { kind: 'pending' } }),
  ),
  bend(
    'a deviation that names a finished task',
    'deviation-names-finished-task',
    'refuse',
    'deviations[0].affectedTasks[0]',
    [passingClaim()],
    (b) => b,
    [affecting('task-done', 'task-later')],
    standing({ 'task-done': { kind: 'finished' }, 'task-later': { kind: 'pending' } }),
  ),
  bend(
    'a deviation that names a task the batch claims',
    'deviation-names-claimed-task',
    'refuse',
    'deviations[0].affectedTasks[0]',
    [passingClaim()],
    (b) => b,
    [affecting('task-verify', 'task-later')],
    standing({ 'task-verify': { kind: 'pending' }, 'task-later': { kind: 'pending' } }),
  ),
];

describe('settlement adjudication', () => {
  /** The denominator. Without this case, an adjudicator that refuses everything passes every rejecting case. */
  it('Adjudicate_ABatchSatisfyingTheCapsule_Settles', () => {
    const verdict = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [], RESOLVING);
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
    expect(verdict.acceptedTasks).toEqual(['task-verify']);
  });

  /**
   * A verdict with zero findings can come from a pass that adjudicated nothing or from a pass that adjudicated everything.
   * Only the census on the verdict tells them apart, and a reader cannot compute it without the capsule.
   * The shape pass reads no verification. The final pass reads one for each accepted claim.
   */
  it('Adjudicate_TheVerdict_CarriesItsOwnDenominator', () => {
    const empty = adjudicateSettlement(
      { ...baseValidCapsule(), settlementContract: { requiredResults: ['task-verify'] } },
      [],
      [],
      RESOLVING,
    );
    const full = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [], RESOLVING);
    expect(empty.adjudicated.claims).toBe(0);
    expect(full.adjudicated.claims).toBe(1);
    expect(full.adjudicated.fields).toBeGreaterThan(0);
    expect(full.adjudicated.evidence).toBe(1);
    expect(full.adjudicated.requiredResults).toBe(1);
    expect(full.adjudicated.verification).toBe(0);
    const final = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [], {
      ...RESOLVING,
      verification: new Map([['task-verify', { kind: 'verified' }]]),
    });
    expect(final.adjudicated.verification).toBe(1);
  });

  /** The published contract accepts each case, so each refusal comes from the adjudicator, not from the schema. */
  it.each(CASES)('Adjudicate_IsStructurallyValid_$name', ({ capsule }) => {
    const parsed = ExarchosCapsuleV1Schema.safeParse(capsule);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it.each(CASES)('Adjudicate_IsNamed_$name', ({ capsule, claims, deviations, kind, at, context }) => {
    const verdict = adjudicateSettlement(capsule, claims, deviations ?? [], context ?? RESOLVING);
    expect(verdict.findings.map((f) => f.kind)).toContain(kind);
    expect(verdict.findings.map((f) => f.at)).toContain(at);
    expect(verdict.outcome).not.toBe('settled');
  });

  /**
   * The batch of each case gives findings of one class, so its outcome is the outcome of that class.
   * The first assertion reads the class table. The other two read the verdict of the adjudicator.
   */
  it.each(CASES)('Adjudicate_HasItsClass_$name', ({ capsule, claims, deviations, kind, findingClass, context }) => {
    expect(SETTLEMENT_FINDING_CLASSES[kind]).toBe(findingClass);
    const verdict = adjudicateSettlement(capsule, claims, deviations ?? [], context ?? RESOLVING);
    expect(new Set(verdict.findings.map((f) => SETTLEMENT_FINDING_CLASSES[f.kind]))).toEqual(new Set([findingClass]));
    expect(verdict.outcome).toBe(outcomeFor([findingClass]));
  });

  /** A kind with no case fails here, so no kind gets its class without a batch that shows it. */
  it('Adjudicate_EveryDeclaredFindingKind_HasACase', () => {
    const covered = new Set(CASES.map((c) => c.kind));
    const uncovered = SETTLEMENT_FINDING_KINDS.filter((kind) => !covered.has(kind));
    expect(
      uncovered,
      `these finding kinds are declared and never exercised: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The class table holds each declared kind and no other key. One kind is stale, one holds, and one
   * leaves a task unresolved. Each other kind refuses the batch.
   */
  it('Adjudicate_TheClassTable_CoversEachKindAndNamesTheThreeThatDoNotRefuse', () => {
    expect(Object.keys(SETTLEMENT_FINDING_CLASSES).sort()).toEqual([...SETTLEMENT_FINDING_KINDS].sort());
    const kindsOf = (findingClass: SettlementFindingClass): SettlementFindingKind[] =>
      SETTLEMENT_FINDING_KINDS.filter((kind) => SETTLEMENT_FINDING_CLASSES[kind] === findingClass);
    expect(kindsOf('stale')).toEqual(['claim-superseded-by-revision']);
    expect(kindsOf('hold')).toEqual(['deviation-awaiting-approval']);
    expect(kindsOf('unresolved')).toEqual(['verification-failed']);
    expect(kindsOf('refuse')).toHaveLength(SETTLEMENT_FINDING_KINDS.length - 3);
  });

  /** The six outcome names. The first three are the names that stored rows, bundles and claims carry. */
  it('Adjudicate_TheOutcomeList_KeepsTheThreeStoredNamesAndAddsThree', () => {
    expect(SETTLEMENT_OUTCOMES).toEqual([
      'settled',
      'rejected',
      'deviation-pending',
      'recompile-required',
      'corrective-capsule',
      'accepted-with-rationale',
    ]);
  });

  /**
   * A refusal of a valid deviation pushes a worker to comply with a premise that it disproved.
   * Thus the finding holds the batch, and it is the one kind that does.
   */
  it('Adjudicate_ADeviationInsideTheEnvelope_HoldsTheBatchRatherThanRefusingIt', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
      RESOLVING,
    );
    expect(verdict.outcome).toBe('deviation-pending');
    expect(verdict.findings.map((f) => f.kind)).toEqual(['deviation-awaiting-approval']);
    expect(SETTLEMENT_FINDING_CLASSES['deviation-awaiting-approval']).toBe('hold');
  });

  it('Adjudicate_AnEnvelopeThatDoesNotRequireApproval_SettlesWithTheDeviation', () => {
    const base = baseValidCapsule();
    const verdict = adjudicateSettlement(
      {
        ...base,
        contracts: {
          ...base.contracts,
          deviationEnvelope: { ...base.contracts.deviationEnvelope, requiresApproval: false },
        },
      },
      [passingClaim()],
      [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
      RESOLVING,
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
  });

  /**
   * The decision round answers the same deviation. An accepted deviation lets the batch settle.
   * A rejected deviation refuses the batch, because a hold is only for a decision that is not made.
   * The claim stays in `acceptedTasks`, because the refusal is on the deviation. The census counts each decision that it reads.
   */
  it('Adjudicate_ADecidedDeviation_IsNoLongerAwaiting', () => {
    const deviation = { deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' };
    const decide = (decision: 'accepted' | 'rejected' | undefined) =>
      adjudicateSettlement(baseValidCapsule(), [passingClaim()], [deviation], {
        evidenceResolves: () => true,
        decided: () => decision,
      });

    const accepted = decide('accepted');
    expect(accepted.outcome).toBe('settled');
    expect(accepted.findings).toEqual([]);
    expect(accepted.adjudicated.decisions).toBe(1);

    const rejected = decide('rejected');
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.findings.map((f) => f.kind)).toEqual(['deviation-rejected']);
    expect(rejected.acceptedTasks).toEqual(['task-verify']);
    expect(rejected.adjudicated.decisions).toBe(1);
    expect(SETTLEMENT_FINDING_CLASSES['deviation-rejected']).toBe('refuse');

    const undecided = decide(undefined);
    expect(undecided.outcome).toBe('deviation-pending');
    expect(undecided.adjudicated.decisions).toBe(0);
  });

  /**
   * The denominator of the three findings about an affected task. Each named task is pending and
   * outside the batch, so the deviation holds the batch as a deviation with no task list does.
   */
  it('Adjudicate_ADeviationNamingPendingTasksOutsideTheBatch_HoldsTheBatch', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [affecting('task-later', 'task-other')],
      standing({ 'task-later': { kind: 'pending' }, 'task-other': { kind: 'pending' } }),
    );
    expect(verdict.outcome).toBe('deviation-pending');
    expect(verdict.findings.map((f) => f.kind)).toEqual(['deviation-awaiting-approval']);
    expect(verdict.acceptedTasks).toEqual(['task-verify']);
  });

  /**
   * Each finding about an affected task refuses, so the batch is rejected and not held. The
   * deviation gets no approval finding, because nothing waits for a decision.
   */
  it('Adjudicate_AFindingAboutAnAffectedTask_RejectsTheBatchAndAsksForNoApproval', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [affecting('task-done', 'task-ghost', 'task-later', 'task-verify')],
      standing({
        'task-done': { kind: 'finished' },
        'task-later': { kind: 'pending' },
        'task-verify': { kind: 'pending' },
      }),
    );
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['deviation-names-finished-task', 'task-done', 'deviations[0].affectedTasks[0]'],
      ['deviation-unknown-task', 'task-ghost', 'deviations[0].affectedTasks[1]'],
      ['deviation-names-claimed-task', 'task-verify', 'deviations[0].affectedTasks[3]'],
    ]);
    expect(verdict.findings[0]?.message).toContain('plan the rework as a new task');
    expect(verdict.findings.map((f) => SETTLEMENT_FINDING_CLASSES[f.kind])).toEqual(['refuse', 'refuse', 'refuse']);
  });

  /** A task that the batch claims and the stream shows complete gets both findings, so one correction covers both. */
  it('Adjudicate_AnAffectedTaskThatIsFinishedAndClaimed_GetsBothFindings', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [affecting('task-verify')],
      standing({ 'task-verify': { kind: 'finished' } }),
    );
    expect(verdict.findings.map((f) => f.kind)).toEqual([
      'deviation-names-finished-task',
      'deviation-names-claimed-task',
    ]);
    expect(verdict.outcome).toBe('rejected');
  });

  /** The plan holds an entry for the task, but the reader refused it. The finding gives the refusal. */
  it('Adjudicate_AnAffectedTaskWhosePlanEntryWasRefused_SaysTheEntryCouldNotBeRead', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [affecting('task-later')],
      standing({ 'task-later': { kind: 'unknown', unreadable: 'the stamp is outside its vocabulary' } }),
    );
    expect(verdict.findings.map((f) => f.kind)).toEqual(['deviation-unknown-task']);
    expect(verdict.findings[0]?.message).toContain('could not be read: the stamp is outside its vocabulary');
    expect(verdict.outcome).toBe('rejected');
  });

  /**
   * The decision round supplies no standing, so the affected tasks get no check. The same batch
   * with a standing is rejected, which shows that the absence of the standing is what admits it.
   */
  it('Adjudicate_WithNoTaskStanding_TheAffectedTasksGetNoCheck', () => {
    const deviation = affecting('task-ghost', 'task-verify');
    const decided = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [deviation], {
      evidenceResolves: () => true,
      decided: () => 'accepted',
    });
    expect(decided.findings).toEqual([]);
    expect(decided.outcome).toBe('settled');

    const first = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [deviation], standing({}));
    expect(first.outcome).toBe('rejected');
  });

  /** A deviation outside the envelope is refused whole, and its affected tasks get no findings. */
  it('Adjudicate_ADeviationOutsideTheEnvelope_GetsNoFindingAboutItsAffectedTasks', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [{ deviationKind: 'rewrote-the-charter', statement: 'seemed fine', affectedTasks: ['task-ghost'] }],
      standing({}),
    );
    expect(verdict.findings.map((f) => f.kind)).toEqual(['deviation-outside-envelope']);
  });

  /**
   * The superseded claim is also defective in its fields and its evidence, and it gets the one
   * finding. The sibling claim is clean, so the pass accepts it, and the batch needs a recompile all
   * the same. A revision that names no task of the batch changes nothing.
   */
  it('Adjudicate_AClaimForATaskALaterRevisionNamed_IsRefusedWholeAndTheBatchNeedsARecompile', () => {
    const base = baseValidCapsule();
    const capsule: ExarchosCapsuleV1 = {
      ...base,
      contracts: {
        ...base.contracts,
        taskResults: {
          ...base.contracts.taskResults,
          'task-compile': [{ name: 'passed', type: 'boolean', required: true }],
        },
      },
    };
    const sibling: SettlementClaim = { taskId: 'task-compile', fields: { passed: true }, evidence: [] };
    const superseded: SettlementClaim = {
      taskId: 'task-verify',
      fields: { passed: 'yes', smuggled: 1 },
      evidence: [{ kind: 'vibes', ref: 'r' }],
    };

    const verdict = adjudicateSettlement(capsule, [superseded, sibling], [], namedByALaterRevision({ 'task-verify': 3 }));
    expect(verdict.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['claim-superseded-by-revision', 'task-verify', 'claims[0].taskId'],
    ]);
    expect(verdict.findings[0]?.message).toContain('design version 3');
    expect(verdict.findings[0]?.message).toContain('capsule v7');
    expect(verdict.findings[0]?.message).toContain('prepare again');
    expect(verdict.outcome).toBe('recompile-required');
    expect(verdict.acceptedTasks).toEqual(['task-compile']);
    expect(SETTLEMENT_FINDING_CLASSES['claim-superseded-by-revision']).toBe('stale');

    const untouched = adjudicateSettlement(
      capsule,
      [passingClaim(), sibling],
      [],
      namedByALaterRevision({ 'task-later': 3 }),
    );
    expect(untouched.findings).toEqual([]);
    expect(untouched.outcome).toBe('settled');
    expect(untouched.acceptedTasks).toEqual(['task-compile', 'task-verify']);
  });

  /** One pass reports every defect, so a caller does not find the defects one round trip at a time. */
  it('Adjudicate_ManyDefects_AreAllReported', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [
        { taskId: 'task-verify', fields: { passed: 'yes', smuggled: 1 }, evidence: [{ kind: 'vibes', ref: 'r' }] },
        { taskId: 'task-ghost', fields: {}, evidence: [] },
      ],
      [],
      RESOLVING,
    );
    expect(new Set(verdict.findings.map((f) => f.kind))).toEqual(
      new Set(['field-type-mismatch', 'undeclared-field', 'inadmissible-evidence', 'unknown-task']),
    );
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.acceptedTasks).toEqual([]);
  });

  /** The duplicate is refused whole. The adjudicator does not report the defects of a claim that it does not consider. */
  it('Adjudicate_ADefectiveDuplicateClaim_IsRefusedOnlyAsADuplicate', () => {
    const verdict = adjudicateSettlement(
      baseValidCapsule(),
      [
        passingClaim(),
        { taskId: 'task-verify', fields: { passed: 'yes', smuggled: 1 }, evidence: [{ kind: 'vibes', ref: 'r' }] },
      ],
      [],
      RESOLVING,
    );
    expect(verdict.findings.map((f) => [f.kind, f.at])).toEqual([['duplicate-claim', 'claims[1].taskId']]);
    expect(verdict.outcome).toBe('rejected');
  });

  /** A field with `required: false` can be absent, and its absence is not a finding. */
  it('Adjudicate_AnOptionalFieldLeftOut_IsNotAFinding', () => {
    const base = baseValidCapsule();
    const verdict = adjudicateSettlement(
      {
        ...base,
        contracts: {
          ...base.contracts,
          taskResults: {
            'task-verify': [
              { name: 'passed', type: 'boolean', required: true },
              { name: 'notes', type: 'string', required: false },
            ],
          },
        },
      },
      [passingClaim()],
      [],
      RESOLVING,
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.adjudicated.fields).toBe(2);
  });
});

/** The base capsule with a result shape for `task-compile` too, so one batch can carry two clean claims. */
function capsuleWithTwoShapes(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    contracts: {
      ...base.contracts,
      taskResults: {
        ...base.contracts.taskResults,
        'task-compile': [{ name: 'passed', type: 'boolean', required: true }],
      },
    },
  };
}

/** The capsule with two shapes, with both of its tasks required. */
function requiringBothTasks(): ExarchosCapsuleV1 {
  const capsule = capsuleWithTwoShapes();
  return {
    ...capsule,
    settlementContract: { ...capsule.settlementContract, requiredResults: ['task-verify', 'task-compile'] },
  };
}

/** A clean claim for `task-compile` under the capsule with two shapes. */
function compileClaim(): SettlementClaim {
  return { taskId: 'task-compile', fields: { passed: true }, evidence: [] };
}

/** The verification outcome of a segment that halted on its completion leaf. */
const HALTED: TaskVerificationOutcome = {
  kind: 'failed',
  failedLeaf: 'task_complete',
  message: 'Required gates not passed',
};

/**
 * The verdict of one batch that gives one finding of each listed class, and no other finding.
 * The stale finding is a claim for a task that a later revision names. The refusing finding is a
 * claim for a task that the graph does not declare. The holding finding is a deviation with no
 * decision. The unresolved finding is the failed verification of the one clean claim.
 */
function verdictWith(classes: readonly SettlementFindingClass[]): SettlementVerdict {
  const stale = classes.includes('stale');
  const claims: SettlementClaim[] = [
    passingClaim(),
    ...(stale ? [compileClaim()] : []),
    ...(classes.includes('refuse') ? [{ taskId: 'task-ghost', fields: {}, evidence: [] }] : []),
  ];
  const deviations: ProposedDeviation[] = classes.includes('hold')
    ? [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }]
    : [];
  return adjudicateSettlement(capsuleWithTwoShapes(), claims, deviations, {
    evidenceResolves: () => true,
    supersedingDesignVersion: (taskId) => (stale && taskId === 'task-compile' ? 2 : undefined),
    verification: new Map<string, TaskVerificationOutcome>([
      ['task-verify', classes.includes('unresolved') ? HALTED : { kind: 'verified' }],
    ]),
  });
}

/**
 * Each set of finding classes with the outcome that it gives. The rows are written out, so the
 * expected outcome of a row does not come from the table of the adjudicator.
 */
const PRECEDENCE: readonly (readonly [readonly SettlementFindingClass[], SettlementOutcome])[] = [
  [[], 'settled'],
  [['unresolved'], 'corrective-capsule'],
  [['hold'], 'deviation-pending'],
  [['hold', 'unresolved'], 'deviation-pending'],
  [['refuse'], 'rejected'],
  [['refuse', 'unresolved'], 'rejected'],
  [['refuse', 'hold'], 'rejected'],
  [['refuse', 'hold', 'unresolved'], 'rejected'],
  [['stale'], 'recompile-required'],
  [['stale', 'unresolved'], 'recompile-required'],
  [['stale', 'hold'], 'recompile-required'],
  [['stale', 'hold', 'unresolved'], 'recompile-required'],
  [['stale', 'refuse'], 'recompile-required'],
  [['stale', 'refuse', 'unresolved'], 'recompile-required'],
  [['stale', 'refuse', 'hold'], 'recompile-required'],
  [['stale', 'refuse', 'hold', 'unresolved'], 'recompile-required'],
];

/**
 * The precedence of the finding classes. A stale finding beats a refusing one, which beats a holding
 * one, which beats an unresolved one, which beats none.
 */
describe('the outcome of a batch with findings of more than one class', () => {
  /** The denominator of the matrix: each subset of the four classes has one row. */
  it('Adjudicate_ThePrecedenceMatrix_HoldsEachSetOfClassesOnce', () => {
    const sets = PRECEDENCE.map(([classes]) => [...classes].sort().join('+'));
    expect(new Set(sets).size).toBe(2 ** 4);
    expect(sets).toHaveLength(2 ** 4);
  });

  /** The first assertion proves that the batch gives exactly the classes of its row. */
  it.each(PRECEDENCE)('Adjudicate_FindingsOfTheClasses_%j_GiveTheOutcome_%s', (classes, outcome) => {
    const verdict = verdictWith(classes);
    expect(verdict.findings.map((f) => SETTLEMENT_FINDING_CLASSES[f.kind]).sort()).toEqual([...classes].sort());
    expect(verdict.outcome).toBe(outcome);
    expect(outcome).toBe(outcomeFor(classes));
  });

  /**
   * Two clean claims go to the final pass, and the verification of one failed. The batch needs a
   * correction, and the claim that passed stays accepted. With both verified, the batch settles.
   */
  it('Adjudicate_OneFailedVerificationBesideAPassedOne_NeedsACorrectionAndKeepsThePassedTask', () => {
    const adjudicate = (compile: TaskVerificationOutcome): SettlementVerdict =>
      adjudicateSettlement(capsuleWithTwoShapes(), [passingClaim(), compileClaim()], [], {
        evidenceResolves: () => true,
        verification: new Map<string, TaskVerificationOutcome>([
          ['task-verify', { kind: 'verified' }],
          ['task-compile', compile],
        ]),
      });

    const partial = adjudicate(HALTED);
    expect(partial.outcome).toBe('corrective-capsule');
    expect(partial.acceptedTasks).toEqual(['task-verify']);
    expect(partial.findings.map((f) => [f.kind, f.subject])).toEqual([['verification-failed', 'task-compile']]);

    const whole = adjudicate({ kind: 'already-complete' });
    expect(whole.outcome).toBe('settled');
    expect(whole.acceptedTasks).toEqual(['task-compile', 'task-verify']);
  });

  /** No verdict of the adjudicator is the outcome that only a recorded rationale gives. */
  it('Adjudicate_NoSetOfClasses_GivesAcceptedWithRationale', () => {
    expect(SETTLEMENT_OUTCOMES).toContain('accepted-with-rationale');
    expect(PRECEDENCE.map(([classes]) => verdictWith(classes).outcome)).not.toContain('accepted-with-rationale');
  });

  /**
   * Eight rows of the matrix hold an unresolved finding, and the verification of `task-verify`
   * failed in each. Only the row with no other class names the task as unresolved. In the other
   * seven rows nothing was verified, so the verdict has an empty list.
   */
  it('Adjudicate_TheUnresolvedListOfAVerdict_HasEntriesOnlyWhenTheBatchNeedsACorrection', () => {
    const withUnresolvedFinding = PRECEDENCE.filter(([classes]) => classes.includes('unresolved'));
    expect(withUnresolvedFinding).toHaveLength(8);

    const lists = PRECEDENCE.map(([classes]) => verdictWith(classes).unresolved);
    const corrective = PRECEDENCE.findIndex(([, outcome]) => outcome === 'corrective-capsule');
    expect(lists[corrective]).toEqual([{ taskId: 'task-verify', cause: 'verification-failed' }]);
    expect(lists.filter((list) => list.length > 0)).toHaveLength(1);
    for (const [classes] of withUnresolvedFinding) {
      const verdict = verdictWith(classes);
      expect(verdict.findings.map((f) => [f.kind, f.subject])).toContainEqual(['verification-failed', 'task-verify']);
      expect(verdict.unresolved.length > 0, classes.join('+')).toBe(verdict.outcome === 'corrective-capsule');
    }
  });

  /**
   * The findings keep the order of the claims, and the unresolved list is sorted by task id.
   * A task that passed is not in the list, and a settled batch has an empty list.
   */
  it('Adjudicate_TheUnresolvedList_IsSortedByTaskIdAndHoldsOnlyTheTasksThatFailed', () => {
    const finalPass = (verify: TaskVerificationOutcome, compile: TaskVerificationOutcome): SettlementVerdict =>
      adjudicateSettlement(capsuleWithTwoShapes(), [passingClaim(), compileClaim()], [], {
        evidenceResolves: () => true,
        verification: new Map<string, TaskVerificationOutcome>([
          ['task-verify', verify],
          ['task-compile', compile],
        ]),
      });

    const both = finalPass(HALTED, HALTED);
    expect(both.findings.map((f) => f.subject)).toEqual(['task-verify', 'task-compile']);
    expect(both.unresolved).toEqual([
      { taskId: 'task-compile', cause: 'verification-failed' },
      { taskId: 'task-verify', cause: 'verification-failed' },
    ]);

    const one = finalPass(HALTED, { kind: 'verified' });
    expect(one.acceptedTasks).toEqual(['task-compile']);
    expect(one.unresolved).toEqual([{ taskId: 'task-verify', cause: 'verification-failed' }]);

    const none = finalPass({ kind: 'verified' }, { kind: 'verified' });
    expect(none.outcome).toBe('settled');
    expect(none.unresolved).toEqual([]);
  });
});

/** The context of a batch on a stream that shows exactly the listed tasks complete. */
function completeOnTheStream(...taskIds: string[]): AdjudicationContext {
  return { evidenceResolves: () => true, taskComplete: (taskId) => taskIds.includes(taskId) };
}

/**
 * A recorded completion satisfies a required result. The capsule of these cases requires
 * `task-verify` and `task-compile`, and each batch but the last claims `task-verify` only.
 */
describe('a required result that the batch does not claim', () => {
  function findingsOf(verdict: SettlementVerdict): string[][] {
    return verdict.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  /**
   * The denominator. The unclaimed task is a missing claim in each of three contexts. They are no
   * completion predicate, a predicate that says no, and a predicate that says yes for the other task only.
   */
  it.each([
    ['no completion predicate', RESOLVING],
    ['a stream that shows no task complete', completeOnTheStream()],
    ['a stream that shows only the claimed task complete', completeOnTheStream('task-verify')],
  ] satisfies [string, AdjudicationContext][])(
    'Adjudicate_AnUnclaimedRequiredTaskUnder_%s_IsAMissingClaim',
    (_name, context) => {
      const verdict = adjudicateSettlement(requiringBothTasks(), [passingClaim()], [], context);
      expect(findingsOf(verdict)).toEqual([['missing-claim', 'task-compile', 'claims']]);
      expect(verdict.outcome).toBe('rejected');
      expect(verdict.adjudicated.requiredResults).toBe(2);
    },
  );

  /**
   * The stream shows the unclaimed task complete, so the requirement has its result and the batch
   * gets no finding. The accepted tasks are the claimed tasks, so the unclaimed task is not in the list.
   */
  it('Adjudicate_AnUnclaimedRequiredTaskThatTheStreamShowsComplete_NeedsNoClaim', () => {
    const verdict = adjudicateSettlement(requiringBothTasks(), [passingClaim()], [], completeOnTheStream('task-compile'));
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
    expect(verdict.acceptedTasks).toEqual(['task-verify']);
    expect(verdict.adjudicated).toMatchObject({ claims: 1, requiredResults: 2, verification: 0 });
  });

  /**
   * On the final pass the census counts the recorded outcome of the unclaimed task beside the
   * outcome of the claim. A final pass that carries no outcome for the unclaimed task counts one.
   */
  it('Adjudicate_OnTheFinalPass_TheCensusCountsTheOutcomeOfTheUnclaimedCompleteTask', () => {
    const finalPass = (outcomes: readonly (readonly [string, TaskVerificationOutcome])[]): SettlementVerdict =>
      adjudicateSettlement(requiringBothTasks(), [passingClaim()], [], {
        ...completeOnTheStream('task-compile'),
        verification: new Map(outcomes),
      });

    const both = finalPass([
      ['task-compile', { kind: 'already-complete' }],
      ['task-verify', { kind: 'verified' }],
    ]);
    expect(both.findings).toEqual([]);
    expect(both.outcome).toBe('settled');
    expect(both.acceptedTasks).toEqual(['task-verify']);
    expect(both.adjudicated.verification).toBe(2);

    const claimOnly = finalPass([['task-verify', { kind: 'verified' }]]);
    expect(claimOnly.outcome).toBe('settled');
    expect(claimOnly.adjudicated.verification).toBe(1);
  });

  /**
   * The unclaimed task is not complete, and a later revision names it. The finding is stale and it
   * points at the claim list, so the capsule settles no new batch and nothing is verified.
   */
  it('Adjudicate_AnUnclaimedIncompleteTaskThatALaterRevisionNames_IsStale', () => {
    const verdict = adjudicateSettlement(requiringBothTasks(), [passingClaim()], [], {
      ...namedByALaterRevision({ 'task-compile': 4 }),
      taskComplete: () => false,
    });
    expect(findingsOf(verdict)).toEqual([['claim-superseded-by-revision', 'task-compile', 'claims']]);
    expect(verdict.findings[0]?.message).toContain('the batch carries none');
    expect(verdict.findings[0]?.message).toContain('design version 4');
    expect(verdict.findings[0]?.message).toContain('capsule v7');
    expect(verdict.findings[0]?.message).toContain('prepare again');
    expect(verdict.outcome).toBe('recompile-required');
    expect(verificationRuns(verdict.findings)).toBe(false);
    expect(verdict.acceptedTasks).toEqual(['task-verify']);
  });

  /**
   * A later revision names a task that the stream shows complete. Without a claim, the completion
   * is the result and the batch settles. With a claim, the revision check comes first and the claim is stale.
   */
  it('Adjudicate_ACompleteTaskThatALaterRevisionNames_NeedsNoClaimAndIsStaleWhenClaimed', () => {
    const context: AdjudicationContext = {
      ...namedByALaterRevision({ 'task-compile': 4 }),
      taskComplete: (taskId) => taskId === 'task-compile',
    };
    const unclaimed = adjudicateSettlement(requiringBothTasks(), [passingClaim()], [], context);
    expect(unclaimed.findings).toEqual([]);
    expect(unclaimed.outcome).toBe('settled');

    const claimed = adjudicateSettlement(requiringBothTasks(), [passingClaim(), compileClaim()], [], context);
    expect(findingsOf(claimed)).toEqual([['claim-superseded-by-revision', 'task-compile', 'claims[1].taskId']]);
    expect(claimed.outcome).toBe('recompile-required');
  });
});

/** Whether verification runs after a shape pass, as the handler asks it. */
describe('the findings that stop verification', () => {
  function finding(kind: SettlementFindingKind): SettlementFinding {
    return { kind, subject: 'task-verify', at: 'claims[0]', message: 'a finding' };
  }

  /** A shape pass with no finding lets verification run, and so does a task that is only unresolved. */
  it('VerificationRuns_WithNoFindingOrOnlyAnUnresolvedTask_IsTrue', () => {
    expect(verificationRuns([])).toBe(true);
    expect(verificationRuns([finding('verification-failed')])).toBe(true);
  });

  /** One finding of a stale, refusing or holding kind stops verification, alone or beside an unresolved task. */
  it.each(['claim-superseded-by-revision', 'unknown-task', 'deviation-awaiting-approval'] satisfies SettlementFindingKind[])(
    'VerificationRuns_WithAFindingOfKind_%s_IsFalse',
    (kind) => {
      expect(verificationRuns([finding(kind)])).toBe(false);
      expect(verificationRuns([finding('verification-failed'), finding(kind)])).toBe(false);
    },
  );

  /** Each declared kind but the one that leaves a task unresolved stops verification. */
  it('VerificationRuns_ForEachDeclaredKind_IsTrueOnlyForAFailedVerification', () => {
    const letsItRun = SETTLEMENT_FINDING_KINDS.filter((kind) => verificationRuns([finding(kind)]));
    expect(letsItRun).toEqual(['verification-failed']);
  });

  /**
   * The outcomes under which a batch reached verification, in the order of the outcome list.
   * Each other outcome is the outcome of a finding class that stops verification.
   */
  it('OutcomeVerifies_IsTrueForTheThreeOutcomesThatReachVerification', () => {
    expect(SETTLEMENT_OUTCOMES.filter((outcome) => outcomeVerifies(outcome))).toEqual([
      'settled',
      'corrective-capsule',
      'accepted-with-rationale',
    ]);
  });

  /** The shape pass of a real batch: a clean batch and a held batch, read through the adjudicator. */
  it('VerificationRuns_OnTheShapePassOfABatch_FollowsItsFindings', () => {
    const clean = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [], RESOLVING);
    const held = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
      RESOLVING,
    );
    const superseded = adjudicateSettlement(
      baseValidCapsule(),
      [passingClaim()],
      [],
      namedByALaterRevision({ 'task-verify': 2 }),
    );
    expect(verificationRuns(clean.findings)).toBe(true);
    expect(verificationRuns(held.findings)).toBe(false);
    expect(verificationRuns(superseded.findings)).toBe(false);
  });
});

/** The base capsule with the given list of material kinds on an envelope that admits two kinds. */
function withMaterialKinds(materialDeviationKinds: readonly string[]): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return ExarchosCapsuleV1Schema.parse({
    ...base,
    contracts: {
      ...base.contracts,
      deviationEnvelope: {
        allowedDeviationKinds: ['invalidated-assumption', 'missing-context'],
        materialDeviationKinds,
        requiresApproval: true,
      },
    },
  });
}

/**
 * The selector of the deviations that revise the design. It reads the material kinds from the
 * capsule and the decisions from the round, and it reads nothing else.
 */
describe('the accepted material deviations of a round', () => {
  /**
   * The round holds one deviation for each way to stay out of the list: rejected, undecided, and
   * accepted under a kind that is not material. The two that remain keep the order of the round.
   */
  it('AcceptedMaterialDeviations_AMixedRound_SelectsOnlyTheAcceptedMaterialOnes', () => {
    const accepted: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' };
    const rejected: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the branch is not main' };
    const undecided: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the cache is cold' };
    const notMaterial: ProposedDeviation = { deviationKind: 'missing-context', statement: 'the port is not named' };
    const alsoAccepted: ProposedDeviation = {
      deviationKind: 'invalidated-assumption',
      statement: 'the queue is not ordered',
      affectedTasks: ['task-later'],
    };
    const decisions = new Map<ProposedDeviation, 'accepted' | 'rejected'>([
      [accepted, 'accepted'],
      [rejected, 'rejected'],
      [notMaterial, 'accepted'],
      [alsoAccepted, 'accepted'],
    ]);

    const selected = acceptedMaterialDeviations(
      withMaterialKinds(['invalidated-assumption']),
      [accepted, rejected, undecided, notMaterial, alsoAccepted],
      (deviation) => decisions.get(deviation),
    );
    expect(selected).toEqual([accepted, alsoAccepted]);
  });

  /**
   * The base capsule carries no list, and a capsule can carry an empty one. Each selects none of a
   * round that accepts every deviation. The same round under a capsule that lists the kind selects
   * the deviation, so the list alone decides.
   */
  it('AcceptedMaterialDeviations_ACapsuleWithNoMaterialKinds_SelectsNone', () => {
    const deviation: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' };
    const acceptEach = (): 'accepted' => 'accepted';
    const withoutList = baseValidCapsule();
    expect(withoutList.contracts.deviationEnvelope).not.toHaveProperty('materialDeviationKinds');

    expect(acceptedMaterialDeviations(withoutList, [deviation], acceptEach)).toEqual([]);
    expect(acceptedMaterialDeviations(withMaterialKinds([]), [deviation], acceptEach)).toEqual([]);
    expect(acceptedMaterialDeviations(withMaterialKinds(['invalidated-assumption']), [deviation], acceptEach)).toEqual([
      deviation,
    ]);
  });
});
