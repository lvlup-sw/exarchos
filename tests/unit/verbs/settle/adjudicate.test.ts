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
  INCOMPLETE_CLAIM_STATUSES,
  SETTLEMENT_FINDING_CLASSES,
  SETTLEMENT_FINDING_KINDS,
  SETTLEMENT_OUTCOMES,
  acceptedMaterialDeviations,
  adjudicateSettlement,
  outcomeVerifies,
  verificationRuns,
  type AdjudicationContext,
  type ClaimRationale,
  type IncompleteClaimStatus,
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

/** A claim that reports `task-verify` as not completed, in the normal form: a status, a reason, no fields and no evidence. */
function reporting(status: IncompleteClaimStatus, taskId = 'task-verify'): SettlementClaim {
  return { taskId, status, reason: `the worker says that the task is ${status}`, fields: {}, evidence: [] };
}

/**
 * The shape pass's context: every cited reference resolves, and no
 * verification has run. The cases that bend either say so themselves.
 */
const RESOLVING: AdjudicationContext = { evidenceResolves: () => true };

/**
 * The capsule with an id on two of its delegated decisions. The two ids are the ones that prepare compiles.
 * The third decision keeps the text of the fixture and has no id, as the kernel schema allows.
 */
function delegating(capsule: ExarchosCapsuleV1 = baseValidCapsule()): ExarchosCapsuleV1 {
  return {
    ...capsule,
    authority: {
      ...capsule.authority,
      delegatedDecisions: [
        { id: 'implementation-approach', statement: 'How a task is implemented, within its declared result shape.' },
        { id: 'execution-order', statement: 'The order and concurrency of tasks whose dependencies are satisfied.' },
        { statement: 'field naming inside a task result' },
      ],
    },
  };
}

/** A delegated choice under a decision that the delegating capsule lists by id. */
const CHOICE: ClaimRationale = {
  delegatedDecision: 'implementation-approach',
  statement: 'a table drives the parser, because the grammar has no recursion',
};

/** The claim with the given delegated choices. */
function choosing(claim: SettlementClaim, ...rationale: ClaimRationale[]): SettlementClaim {
  return { ...claim, rationale };
}

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
    'a rationale that names a decision the capsule does not delegate',
    'rationale-not-delegated',
    'refuse',
    'claims[0].rationale[0].delegatedDecision',
    [choosing(passingClaim(), { delegatedDecision: 'published-contract-change', statement: 'the event gained a field' })],
    (b) => delegating(b),
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
  bend('a claim that reports its task as failed', 'task-failed', 'unresolved', 'claims[0]', [reporting('failed')]),
  bend('a claim that reports its task as blocked', 'task-blocked', 'unresolved', 'claims[0]', [reporting('blocked')]),
  bend('a claim that reports its task as skipped', 'task-skipped', 'unresolved', 'claims[0]', [reporting('skipped')]),
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
   * The class table holds each declared kind and no other key. One kind is stale, and one holds.
   * Four leave a task unresolved: a failed verification, and one for each status of a claim that
   * is not completed. Each other kind refuses the batch.
   */
  it('Adjudicate_TheClassTable_CoversEachKindAndNamesTheSixThatDoNotRefuse', () => {
    expect(Object.keys(SETTLEMENT_FINDING_CLASSES).sort()).toEqual([...SETTLEMENT_FINDING_KINDS].sort());
    const kindsOf = (findingClass: SettlementFindingClass): SettlementFindingKind[] =>
      SETTLEMENT_FINDING_KINDS.filter((kind) => SETTLEMENT_FINDING_CLASSES[kind] === findingClass);
    expect(kindsOf('stale')).toEqual(['claim-superseded-by-revision']);
    expect(kindsOf('hold')).toEqual(['deviation-awaiting-approval']);
    expect(kindsOf('unresolved')).toEqual(['verification-failed', 'task-failed', 'task-blocked', 'task-skipped']);
    expect(kindsOf('refuse')).toHaveLength(SETTLEMENT_FINDING_KINDS.length - 6);
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
 * With `withRationale`, the one clean claim also records a choice that the capsule delegates.
 */
function verdictWith(classes: readonly SettlementFindingClass[], withRationale = false): SettlementVerdict {
  const stale = classes.includes('stale');
  const claims: SettlementClaim[] = [
    withRationale ? choosing(passingClaim(), CHOICE) : passingClaim(),
    ...(stale ? [compileClaim()] : []),
    ...(classes.includes('refuse') ? [{ taskId: 'task-ghost', fields: {}, evidence: [] }] : []),
  ];
  const deviations: ProposedDeviation[] = classes.includes('hold')
    ? [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }]
    : [];
  return adjudicateSettlement(delegating(capsuleWithTwoShapes()), claims, deviations, {
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

  /** The denominator of the cases below: without a rationale, no row of the matrix gives the outcome that a rationale gives. */
  it('Adjudicate_WithoutARationale_NoSetOfClassesGivesAcceptedWithRationale', () => {
    expect(SETTLEMENT_OUTCOMES).toContain('accepted-with-rationale');
    expect(PRECEDENCE.map(([classes]) => verdictWith(classes).outcome)).not.toContain('accepted-with-rationale');
  });

  /**
   * The same sixteen batches, and the one clean claim of each records a delegated choice. The choice
   * is one that the capsule delegates, so it adds no finding. The batch with no finding is accepted
   * with rationale. In each other row a finding class decides, and the outcome is that of the matrix.
   */
  it.each(PRECEDENCE)('Adjudicate_ARationaleBesideFindingsOfTheClasses_%j_DoesNotChangeTheOutcome_%s', (classes, outcome) => {
    const verdict = verdictWith(classes, true);
    expect(verdict.findings.map((f) => SETTLEMENT_FINDING_CLASSES[f.kind]).sort()).toEqual([...classes].sort());
    expect(verdict.findings).toEqual(verdictWith(classes).findings);
    expect(verdict.acceptedTasks).toEqual(verdictWith(classes).acceptedTasks);
    expect(verdict.outcome).toBe(classes.length === 0 ? 'accepted-with-rationale' : outcome);
  });

  /**
   * Only the row with no finding gives the outcome of a rationale, and only its verdict lists the choice.
   * In the eight rows with an unresolved finding, the claim that records the choice failed its verification.
   * The claim is not accepted there, so the verdict lists no choice.
   */
  it('Adjudicate_ARationale_GivesItsOutcomeOnlyToTheBatchWithNoFinding', () => {
    const verdicts = PRECEDENCE.map(([classes]) => verdictWith(classes, true));
    expect(verdicts.filter((verdict) => verdict.outcome === 'accepted-with-rationale')).toHaveLength(1);
    expect(verdicts[0]?.outcome).toBe('accepted-with-rationale');
    expect(verdicts[0]?.rationales).toEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);
    expect(verdicts.filter((verdict) => verdict.rationales.length > 0)).toHaveLength(1);
    for (const [classes] of PRECEDENCE.filter(([row]) => row.includes('unresolved'))) {
      expect(verdictWith(classes, true).acceptedTasks, classes.join('+')).not.toContain('task-verify');
    }
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

/**
 * A claim can report its task as failed, blocked or skipped. Such a claim returns no result, so
 * nothing of it is read against the result shape and nothing is verified. Its task is unresolved,
 * and the other claims of the batch are judged apart from it.
 */
describe('a claim that reports its task as not completed', () => {
  function findingsOf(verdict: SettlementVerdict): string[][] {
    return verdict.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  /** The denominator of the cases below: each status has one finding kind, and the kinds are distinct. */
  it('Adjudicate_EachIncompleteStatus_HasItsOwnFindingKind', () => {
    expect(INCOMPLETE_CLAIM_STATUSES).toEqual(['failed', 'blocked', 'skipped']);
    const kinds = INCOMPLETE_CLAIM_STATUSES.map(
      (status) => adjudicateSettlement(baseValidCapsule(), [reporting(status)], [], RESOLVING).findings[0]?.kind,
    );
    expect(kinds).toEqual(['task-failed', 'task-blocked', 'task-skipped']);
  });

  /**
   * The capsule requires `passed` of `task-verify`, and the claim carries no field. The one finding
   * is the status of the task. The finding names the task as its subject, so the task is unresolved,
   * and its message gives the reason of the worker. The required result is not a missing claim.
   */
  it.each([
    ['failed', 'task-failed', 'was attempted and has no result to verify'],
    ['blocked', 'task-blocked', 'cannot proceed until something outside the task changes'],
    ['skipped', 'task-skipped', 'was not attempted in this run'],
  ] satisfies [IncompleteClaimStatus, SettlementFindingKind, string][])(
    'Adjudicate_AClaimWithTheStatus_%s_GivesOneFindingAndLeavesItsTaskUnresolved',
    (status, kind, meaning) => {
      const verdict = adjudicateSettlement(baseValidCapsule(), [reporting(status)], [], RESOLVING);
      expect(findingsOf(verdict)).toEqual([[kind, 'task-verify', 'claims[0]']]);
      expect(verdict.findings[0]?.message).toContain(meaning);
      expect(verdict.findings[0]?.message).toContain(`the worker says that the task is ${status}`);
      expect(verdict.outcome).toBe('corrective-capsule');
      expect(verdict.unresolved).toEqual([{ taskId: 'task-verify', cause: kind }]);
      expect(verdict.acceptedTasks).toEqual([]);
      expect(verdict.adjudicated).toMatchObject({ claims: 1, requiredResults: 1, fields: 0, evidence: 0 });
      expect(verificationRuns(verdict.findings)).toBe(true);
    },
  );

  /**
   * One claim is blocked and one is completed. The shape pass accepts the completed claim and lets
   * verification run. On the final pass the completed task is accepted. The blocked task is not,
   * also when the outcomes hold a passing entry for it, and the census does not count that entry.
   */
  it('Adjudicate_ABlockedClaimBesideACompletedClaim_NeedsACorrectionAndKeepsTheCompletedTask', () => {
    const claims = [reporting('blocked', 'task-compile'), passingClaim()];
    const shape = adjudicateSettlement(requiringBothTasks(), claims, [], RESOLVING);
    expect(findingsOf(shape)).toEqual([['task-blocked', 'task-compile', 'claims[0]']]);
    expect(shape.acceptedTasks).toEqual(['task-verify']);
    expect(verificationRuns(shape.findings)).toBe(true);

    const final = adjudicateSettlement(requiringBothTasks(), claims, [], {
      ...RESOLVING,
      verification: new Map<string, TaskVerificationOutcome>([
        ['task-verify', { kind: 'verified' }],
        ['task-compile', { kind: 'verified' }],
      ]),
    });
    expect(findingsOf(final)).toEqual([['task-blocked', 'task-compile', 'claims[0]']]);
    expect(final.outcome).toBe('corrective-capsule');
    expect(final.acceptedTasks).toEqual(['task-verify']);
    expect(final.unresolved).toEqual([{ taskId: 'task-compile', cause: 'task-blocked' }]);
    expect(final.adjudicated).toMatchObject({ claims: 2, requiredResults: 2, verification: 1 });
  });

  /**
   * The stream shows the task complete, so the recorded completion is its result and the report
   * makes no finding. The shape pass accepts the claim. The final pass accepts it with the outcome
   * of a task that was complete before the batch. It refuses the claim when no outcome is supplied.
   */
  it.each([...INCOMPLETE_CLAIM_STATUSES])(
    'Adjudicate_AClaimWithTheStatus_%s_ForATaskTheStreamShowsComplete_MakesNoFinding',
    (status) => {
      const context = completeOnTheStream('task-verify');
      const shape = adjudicateSettlement(baseValidCapsule(), [reporting(status)], [], context);
      expect(shape.findings).toEqual([]);
      expect(shape.acceptedTasks).toEqual(['task-verify']);
      expect(shape.adjudicated).toMatchObject({ fields: 0, evidence: 0 });

      const final = adjudicateSettlement(baseValidCapsule(), [reporting(status)], [], {
        ...context,
        verification: new Map<string, TaskVerificationOutcome>([['task-verify', { kind: 'already-complete' }]]),
      });
      expect(final.findings).toEqual([]);
      expect(final.outcome).toBe('settled');
      expect(final.acceptedTasks).toEqual(['task-verify']);
      expect(final.unresolved).toEqual([]);
      expect(final.adjudicated.verification).toBe(1);

      const withoutOutcome = adjudicateSettlement(baseValidCapsule(), [reporting(status)], [], {
        ...context,
        verification: new Map(),
      });
      expect(findingsOf(withoutOutcome)).toEqual([['verification-failed', 'task-verify', 'claims[0]']]);
    },
  );

  /**
   * The checks that come before the status keep their place. A later revision that names the task
   * makes the claim stale, also when the stream shows the task complete. A task that the graph does
   * not declare is unknown, and a second claim for one task is a duplicate.
   */
  it('Adjudicate_AClaimThatIsNotCompleted_IsStillStaleUnknownOrDuplicateFirst', () => {
    const stale = adjudicateSettlement(baseValidCapsule(), [reporting('blocked')], [], {
      ...namedByALaterRevision({ 'task-verify': 3 }),
      taskComplete: () => true,
    });
    expect(findingsOf(stale)).toEqual([['claim-superseded-by-revision', 'task-verify', 'claims[0].taskId']]);
    expect(stale.outcome).toBe('recompile-required');

    const unknown = adjudicateSettlement(baseValidCapsule(), [passingClaim(), reporting('skipped', 'task-ghost')], [], RESOLVING);
    expect(findingsOf(unknown)).toEqual([['unknown-task', 'task-ghost', 'claims[1].taskId']]);
    expect(unknown.outcome).toBe('rejected');

    const twice = adjudicateSettlement(baseValidCapsule(), [passingClaim(), reporting('failed')], [], RESOLVING);
    expect(findingsOf(twice)).toEqual([['duplicate-claim', 'task-verify', 'claims[1].taskId']]);
    expect(twice.outcome).toBe('rejected');
  });

  /**
   * A stale, refusing or holding finding beside the report stops verification, and it decides the
   * outcome. The verdict then names no unresolved task, because nothing was verified.
   */
  it('Adjudicate_ABlockedClaimBesideAFindingOfAnotherClass_IsNotACorrection', () => {
    const held = adjudicateSettlement(
      requiringBothTasks(),
      [reporting('blocked', 'task-compile'), passingClaim()],
      [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
      RESOLVING,
    );
    expect(held.findings.map((f) => f.kind)).toEqual(['task-blocked', 'deviation-awaiting-approval']);
    expect(held.outcome).toBe('deviation-pending');
    expect(held.unresolved).toEqual([]);
    expect(verificationRuns(held.findings)).toBe(false);

    const refused = adjudicateSettlement(
      requiringBothTasks(),
      [reporting('blocked', 'task-compile'), { taskId: 'task-verify', fields: { passed: 'yes' }, evidence: [] }],
      [],
      RESOLVING,
    );
    expect(refused.findings.map((f) => f.kind)).toEqual(['task-blocked', 'field-type-mismatch']);
    expect(refused.outcome).toBe('rejected');
    expect(refused.unresolved).toEqual([]);
  });
});

/** The context of a final pass in which the verification of each listed task passed. */
function verified(...taskIds: string[]): AdjudicationContext {
  return {
    evidenceResolves: () => true,
    verification: new Map(taskIds.map((taskId): [string, TaskVerificationOutcome] => [taskId, { kind: 'verified' }])),
  };
}

/**
 * A completed claim can record a choice under a decision that the capsule delegates.
 * The choice changes the outcome of a batch with no finding, and it changes nothing else.
 * Each capsule of these cases gives an id to two delegated decisions.
 */
describe('a claim that records a delegated choice', () => {
  function findingsOf(verdict: SettlementVerdict): string[][] {
    return verdict.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  const ORDER_CHOICE: ClaimRationale = { delegatedDecision: 'execution-order', statement: 'the two tasks ran in sequence' };

  /**
   * The denominator. The batch without the choice settles, on the shape pass and on the final pass.
   * The same batch with the choice is accepted with rationale. It has no finding, the same accepted
   * task and the same counts, and its verdict names the task and the id of the decision.
   */
  it.each([
    ['the shape pass', RESOLVING],
    ['the final pass', verified('task-verify')],
  ] satisfies [string, AdjudicationContext][])(
    'Adjudicate_OnTheBatchOf_%s_ARecordedChoiceGivesAcceptedWithRationale',
    (_pass, context) => {
      const plain = adjudicateSettlement(delegating(), [passingClaim()], [], context);
      expect(plain.outcome).toBe('settled');
      expect(plain.rationales).toEqual([]);

      const chosen = adjudicateSettlement(delegating(), [choosing(passingClaim(), CHOICE)], [], context);
      expect(chosen.findings).toEqual([]);
      expect(chosen.outcome).toBe('accepted-with-rationale');
      expect(chosen.rationales).toEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);
      expect(chosen.acceptedTasks).toEqual(plain.acceptedTasks);
      expect(chosen.adjudicated).toEqual(plain.adjudicated);
      expect(chosen.unresolved).toEqual([]);
      expect(outcomeVerifies(chosen.outcome)).toBe(true);
    },
  );

  /**
   * The id is that of an escalation boundary in the capsule that prepare compiles. It is not a delegated decision.
   * The finding names the id as its subject, and its message lists the ids that the capsule delegates.
   * The batch is rejected, the claim is not accepted, and nothing is verified.
   */
  it('Adjudicate_ARationaleThatNamesADecisionTheCapsuleDoesNotDelegate_RefusesTheBatch', () => {
    const outside: ClaimRationale = { delegatedDecision: 'published-contract-change', statement: 'the event gained a field' };
    const verdict = adjudicateSettlement(delegating(), [choosing(passingClaim(), outside)], [], RESOLVING);
    expect(findingsOf(verdict)).toEqual([
      ['rationale-not-delegated', 'published-contract-change', 'claims[0].rationale[0].delegatedDecision'],
    ]);
    expect(verdict.findings[0]?.message).toContain('the capsule delegates no decision with that id');
    expect(verdict.findings[0]?.message).toContain('"execution-order", "implementation-approach"');
    expect(verdict.findings[0]?.message).toContain('`deviations`');
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.acceptedTasks).toEqual([]);
    expect(verdict.rationales).toEqual([]);
    expect(verificationRuns(verdict.findings)).toBe(false);

    const mixed = adjudicateSettlement(delegating(), [choosing(passingClaim(), CHOICE, outside, ORDER_CHOICE)], [], RESOLVING);
    expect(findingsOf(mixed)).toEqual([
      ['rationale-not-delegated', 'published-contract-change', 'claims[0].rationale[1].delegatedDecision'],
    ]);
    expect(mixed.outcome).toBe('rejected');
    expect(mixed.rationales).toEqual([]);
  });

  /**
   * The id of a capsule statement is optional. The third delegated decision of the capsule has no id.
   * A rationale that gives the text of that decision names nothing, and neither does an empty-id guess.
   * The base capsule gives no id to a delegated decision, so it admits no rationale, and the message says so.
   */
  it('Adjudicate_ADelegatedDecisionWithNoId_CannotBeNamed', () => {
    const byText: ClaimRationale = { delegatedDecision: 'field naming inside a task result', statement: 'the field is `passed`' };
    const withIds = adjudicateSettlement(delegating(), [choosing(passingClaim(), byText)], [], RESOLVING);
    expect(findingsOf(withIds)).toEqual([
      ['rationale-not-delegated', 'field naming inside a task result', 'claims[0].rationale[0].delegatedDecision'],
    ]);
    expect(withIds.outcome).toBe('rejected');

    expect(baseValidCapsule().authority.delegatedDecisions.map((decision) => decision.id)).toEqual([undefined]);
    for (const rationale of [byText, CHOICE]) {
      const noIds = adjudicateSettlement(baseValidCapsule(), [choosing(passingClaim(), rationale)], [], RESOLVING);
      expect(findingsOf(noIds).map(([kind]) => kind)).toEqual(['rationale-not-delegated']);
      expect(noIds.findings[0]?.message).toContain('It gives no id to a delegated decision');
      expect(noIds.outcome).toBe('rejected');
    }
  });

  /**
   * A rationale is no evidence. The verification of the claim halted, so the claim is not accepted
   * and its task is unresolved, with the choice or without it. A final pass with no outcome for the
   * task does not accept the claim. The verdict lists no choice in either case.
   */
  it('Adjudicate_ARationaleOnAClaimWhoseVerificationFailed_DoesNotAcceptTheClaim', () => {
    const finalPass = (claim: SettlementClaim, outcomes: readonly (readonly [string, TaskVerificationOutcome])[]): SettlementVerdict =>
      adjudicateSettlement(delegating(), [claim], [], { evidenceResolves: () => true, verification: new Map(outcomes) });

    const halted = finalPass(choosing(passingClaim(), CHOICE), [['task-verify', HALTED]]);
    expect(findingsOf(halted)).toEqual([['verification-failed', 'task-verify', 'claims[0]']]);
    expect(halted.outcome).toBe('corrective-capsule');
    expect(halted.acceptedTasks).toEqual([]);
    expect(halted.unresolved).toEqual([{ taskId: 'task-verify', cause: 'verification-failed' }]);
    expect(halted.rationales).toEqual([]);
    expect(halted).toEqual(finalPass(passingClaim(), [['task-verify', HALTED]]));

    const notRun = finalPass(choosing(passingClaim(), CHOICE), []);
    expect(findingsOf(notRun)).toEqual([['verification-failed', 'task-verify', 'claims[0]']]);
    expect(notRun.acceptedTasks).toEqual([]);
    expect(notRun.rationales).toEqual([]);
  });

  /**
   * One task passes with a recorded choice, and the other is unresolved. The unresolved task decides
   * the outcome, so the batch needs a correction. The task that passed is complete, and the verdict
   * still lists its choice. The cases are a blocked claim and a failed verification.
   */
  it('Adjudicate_ARationaleBesideAnUnresolvedTask_IsStillListedAndTheBatchNeedsACorrection', () => {
    const capsule = delegating(requiringBothTasks());
    const blocked = adjudicateSettlement(
      capsule,
      [choosing(passingClaim(), CHOICE), reporting('blocked', 'task-compile')],
      [],
      verified('task-verify'),
    );
    expect(blocked.outcome).toBe('corrective-capsule');
    expect(blocked.acceptedTasks).toEqual(['task-verify']);
    expect(blocked.unresolved).toEqual([{ taskId: 'task-compile', cause: 'task-blocked' }]);
    expect(blocked.rationales).toEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);

    const halted = adjudicateSettlement(
      capsule,
      [choosing(passingClaim(), CHOICE), choosing(compileClaim(), ORDER_CHOICE)],
      [],
      {
        evidenceResolves: () => true,
        verification: new Map<string, TaskVerificationOutcome>([
          ['task-verify', { kind: 'verified' }],
          ['task-compile', HALTED],
        ]),
      },
    );
    expect(halted.outcome).toBe('corrective-capsule');
    expect(halted.acceptedTasks).toEqual(['task-verify']);
    expect(halted.unresolved).toEqual([{ taskId: 'task-compile', cause: 'verification-failed' }]);
    expect(halted.rationales).toEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);
  });

  /**
   * The stream shows the task complete before the batch, so nothing runs again for it.
   * The round still records the task complete, and its claim records a choice. The batch is accepted with rationale.
   */
  it('Adjudicate_ARationaleOnATaskThatWasCompleteBeforeTheBatch_IsAcceptedWithRationale', () => {
    const verdict = adjudicateSettlement(delegating(), [choosing(passingClaim(), CHOICE)], [], {
      evidenceResolves: () => true,
      taskComplete: () => true,
      verification: new Map<string, TaskVerificationOutcome>([['task-verify', { kind: 'already-complete' }]]),
    });
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('accepted-with-rationale');
    expect(verdict.rationales).toEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);
  });

  /**
   * The claims come in the order `task-verify`, `task-compile`. The second claim names one decision twice, with two statements.
   * The list of the verdict is sorted by task id and then by decision id, and it holds each pair once.
   */
  it('Adjudicate_TheRationalesOfAVerdict_AreSortedByTaskAndDecisionAndHoldEachPairOnce', () => {
    const again: ClaimRationale = { delegatedDecision: 'implementation-approach', statement: 'the lexer is a second table' };
    const verdict = adjudicateSettlement(
      delegating(requiringBothTasks()),
      [choosing(passingClaim(), CHOICE), choosing(compileClaim(), CHOICE, ORDER_CHOICE, again)],
      [],
      verified('task-verify', 'task-compile'),
    );
    expect(verdict.outcome).toBe('accepted-with-rationale');
    expect(verdict.rationales).toEqual([
      { taskId: 'task-compile', delegatedDecision: 'execution-order' },
      { taskId: 'task-compile', delegatedDecision: 'implementation-approach' },
      { taskId: 'task-verify', delegatedDecision: 'implementation-approach' },
    ]);
  });

  /**
   * Nothing is verified under a held, a refused or a stale batch, so its verdict lists no choice.
   * The shape pass still finds no fault in the claim. The round that accepts the deviation verifies
   * the same batch, and that verdict lists the choice.
   */
  it('Adjudicate_UnderAnOutcomeThatStopsVerification_TheVerdictListsNoRationale', () => {
    const claims = [choosing(passingClaim(), CHOICE)];
    const deviation = { deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' };

    const held = adjudicateSettlement(delegating(), claims, [deviation], RESOLVING);
    expect(held.outcome).toBe('deviation-pending');
    expect(held.acceptedTasks).toEqual(['task-verify']);
    expect(held.rationales).toEqual([]);

    const refused = adjudicateSettlement(delegating(), claims, [deviation], { ...RESOLVING, decided: () => 'rejected' });
    expect(refused.outcome).toBe('rejected');
    expect(refused.rationales).toEqual([]);

    const stale = adjudicateSettlement(delegating(requiringBothTasks()), claims, [], {
      ...namedByALaterRevision({ 'task-compile': 2 }),
      taskComplete: () => false,
    });
    expect(stale.outcome).toBe('recompile-required');
    expect(stale.acceptedTasks).toEqual(['task-verify']);
    expect(stale.rationales).toEqual([]);

    const decided = adjudicateSettlement(delegating(), claims, [deviation], {
      ...verified('task-verify'),
      decided: () => 'accepted',
    });
    expect(decided.outcome).toBe('accepted-with-rationale');
    expect(decided.rationales).toEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);
  });

  /**
   * A rationale grants nothing. Each case of the corpus gets a delegated choice on each of its completed claims.
   * The findings, the accepted tasks, the counts and the outcome of each case do not change.
   * The one case that tests a rationale is left out, and the first assertion counts the cases that remain.
   */
  it('Adjudicate_ARationaleOnEachCompletedClaim_RemovesNoFindingOfTheCorpus', () => {
    const corpus = CASES.filter((c) => c.kind !== 'rationale-not-delegated');
    expect(corpus).toHaveLength(CASES.length - 1);
    expect(corpus.length).toBeGreaterThanOrEqual(SETTLEMENT_FINDING_KINDS.length - 1);
    for (const { name, capsule, claims, deviations, context } of corpus) {
      const without = adjudicateSettlement(delegating(capsule), claims, deviations ?? [], context ?? RESOLVING);
      const withChoices = adjudicateSettlement(
        delegating(capsule),
        claims.map((claim) => (claim.status === undefined ? choosing(claim, CHOICE) : claim)),
        deviations ?? [],
        context ?? RESOLVING,
      );
      expect(without.findings.length, name).toBeGreaterThan(0);
      expect(withChoices.findings, name).toEqual(without.findings);
      expect(withChoices.acceptedTasks, name).toEqual(without.acceptedTasks);
      expect(withChoices.adjudicated, name).toEqual(without.adjudicated);
      expect(withChoices.outcome, name).toBe(without.outcome);
      expect(withChoices.unresolved, name).toEqual(without.unresolved);
    }
  });
});

/**
 * A deviation cannot name a task that its batch claims as completed, because the batch returns a result for that task.
 * A claim that reports its task as not completed returns no result, so a deviation of the batch can name that task.
 * The capsule of these cases requires `task-verify` and `task-compile`.
 */
describe('a deviation that names a task of its own batch', () => {
  function findingsOf(verdict: SettlementVerdict): string[][] {
    return verdict.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  const PENDING = standing({ 'task-verify': { kind: 'pending' }, 'task-compile': { kind: 'pending' } });

  /**
   * The denominator of the cases below. The same deviation beside a completed claim for the task refuses the batch.
   * Thus the status of the claim is what admits the deviation in each case that follows.
   */
  it('Adjudicate_ADeviationNamingATaskThatItsBatchClaimsAsCompleted_RefusesTheBatch', () => {
    const verdict = adjudicateSettlement(
      requiringBothTasks(),
      [passingClaim(), compileClaim()],
      [affecting('task-compile')],
      PENDING,
    );
    expect(findingsOf(verdict)).toEqual([
      ['deviation-names-claimed-task', 'task-compile', 'deviations[0].affectedTasks[0]'],
    ]);
    expect(verdict.findings[0]?.message).toContain('this batch claims that task as completed');
    expect(verdict.outcome).toBe('rejected');
  });

  /**
   * The claim reports the task as not completed, and the deviation names that task. The deviation gets no finding
   * about the task, so it waits for its decision and the batch is held. The only other finding is that of the status.
   */
  it.each([
    ['failed', 'task-failed'],
    ['blocked', 'task-blocked'],
    ['skipped', 'task-skipped'],
  ] satisfies [IncompleteClaimStatus, SettlementFindingKind][])(
    'Adjudicate_ADeviationNamingATaskThatItsBatchReportsAs_%s_HoldsTheBatch',
    (status, kind) => {
      const verdict = adjudicateSettlement(
        requiringBothTasks(),
        [passingClaim(), reporting(status, 'task-compile')],
        [affecting('task-compile')],
        PENDING,
      );
      expect(findingsOf(verdict)).toEqual([
        [kind, 'task-compile', 'claims[1]'],
        ['deviation-awaiting-approval', 'invalidated-assumption', 'deviations[0].deviationKind'],
      ]);
      expect(verdict.outcome).toBe('deviation-pending');
      expect(verdict.acceptedTasks).toEqual(['task-verify']);
      expect(verdict.unresolved).toEqual([]);
      expect(verificationRuns(verdict.findings)).toBe(false);
    },
  );

  /** The three statuses of the cases above are each status that is not `completed`. */
  it('Adjudicate_TheStatusesThatAdmitAnOwnTaskDeviation_AreEachIncompleteStatus', () => {
    expect([...INCOMPLETE_CLAIM_STATUSES]).toEqual(['failed', 'blocked', 'skipped']);
  });

  /**
   * One deviation names both tasks of the batch. The finding is for the task that the batch claims as completed,
   * and the blocked task gets none. The batch is refused, so the deviation asks for no approval.
   */
  it('Adjudicate_ADeviationNamingACompletedTaskAndABlockedTask_RefusesOnlyForTheCompletedTask', () => {
    const verdict = adjudicateSettlement(
      requiringBothTasks(),
      [passingClaim(), reporting('blocked', 'task-compile')],
      [affecting('task-compile', 'task-verify')],
      PENDING,
    );
    expect(findingsOf(verdict)).toEqual([
      ['task-blocked', 'task-compile', 'claims[1]'],
      ['deviation-names-claimed-task', 'task-verify', 'deviations[0].affectedTasks[1]'],
    ]);
    expect(verdict.outcome).toBe('rejected');
  });

  /**
   * The other two checks on an affected task do not read the status of the claim.
   * A blocked task that the plan shows finished is still a finished task, and one that the plan does not hold is unknown.
   * Neither gets the finding for a claimed task.
   */
  it('Adjudicate_ABlockedTaskThatIsFinishedOrUnknown_StillRefusesTheDeviationThatNamesIt', () => {
    const claims = [passingClaim(), reporting('blocked', 'task-compile')];
    const finished = adjudicateSettlement(
      requiringBothTasks(),
      claims,
      [affecting('task-compile')],
      standing({ 'task-compile': { kind: 'finished' } }),
    );
    expect(findingsOf(finished)).toEqual([
      ['task-blocked', 'task-compile', 'claims[1]'],
      ['deviation-names-finished-task', 'task-compile', 'deviations[0].affectedTasks[0]'],
    ]);
    expect(finished.outcome).toBe('rejected');

    const unknown = adjudicateSettlement(requiringBothTasks(), claims, [affecting('task-compile')], standing({}));
    expect(findingsOf(unknown)).toEqual([
      ['task-blocked', 'task-compile', 'claims[1]'],
      ['deviation-unknown-task', 'task-compile', 'deviations[0].affectedTasks[0]'],
    ]);
    expect(unknown.outcome).toBe('rejected');
  });

  /**
   * The decision round reads the same batch with a decision and no standing. An accepted deviation leaves only the
   * finding of the status, so verification runs and the batch needs a correction for the blocked task.
   * A rejected deviation refuses the batch, so nothing is verified and the verdict names no unresolved task.
   */
  it('Adjudicate_TheDecisionOnAnOwnTaskDeviation_NeedsACorrectionWhenAcceptedAndRefusesWhenRejected', () => {
    const claims = [passingClaim(), reporting('blocked', 'task-compile')];
    const decide = (decision: 'accepted' | 'rejected'): SettlementVerdict =>
      adjudicateSettlement(requiringBothTasks(), claims, [affecting('task-compile')], {
        evidenceResolves: () => true,
        decided: () => decision,
      });

    const accepted = decide('accepted');
    expect(findingsOf(accepted)).toEqual([['task-blocked', 'task-compile', 'claims[1]']]);
    expect(accepted.outcome).toBe('corrective-capsule');
    expect(accepted.acceptedTasks).toEqual(['task-verify']);
    expect(accepted.unresolved).toEqual([{ taskId: 'task-compile', cause: 'task-blocked' }]);
    expect(verificationRuns(accepted.findings)).toBe(true);

    const rejected = decide('rejected');
    expect(rejected.findings.map((f) => f.kind)).toEqual(['task-blocked', 'deviation-rejected']);
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.unresolved).toEqual([]);
    expect(verificationRuns(rejected.findings)).toBe(false);
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
    expect(verificationRuns([finding('task-blocked'), finding('task-failed'), finding('task-skipped')])).toBe(true);
  });

  /** One finding of a stale, refusing or holding kind stops verification, alone or beside an unresolved task. */
  it.each(['claim-superseded-by-revision', 'unknown-task', 'deviation-awaiting-approval'] satisfies SettlementFindingKind[])(
    'VerificationRuns_WithAFindingOfKind_%s_IsFalse',
    (kind) => {
      expect(verificationRuns([finding(kind)])).toBe(false);
      expect(verificationRuns([finding('verification-failed'), finding(kind)])).toBe(false);
    },
  );

  /** Each declared kind but the four that leave a task unresolved stops verification. */
  it('VerificationRuns_ForEachDeclaredKind_IsTrueOnlyForAKindThatLeavesATaskUnresolved', () => {
    const letsItRun = SETTLEMENT_FINDING_KINDS.filter((kind) => verificationRuns([finding(kind)]));
    expect(letsItRun).toEqual(['verification-failed', 'task-failed', 'task-blocked', 'task-skipped']);
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
