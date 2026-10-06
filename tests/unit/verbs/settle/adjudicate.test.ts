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
  BLOCKING_SETTLEMENT_FINDING_KINDS,
  SETTLEMENT_FINDING_KINDS,
  acceptedMaterialDeviations,
  adjudicateSettlement,
  type AdjudicationContext,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementFindingKind,
  type TaskStanding,
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

interface AdjudicationCase {
  readonly name: string;
  readonly kind: SettlementFindingKind;
  readonly at: string;
  readonly capsule: ExarchosCapsuleV1;
  readonly claims: readonly SettlementClaim[];
  readonly deviations?: readonly ProposedDeviation[];
  readonly context?: AdjudicationContext;
}

function bend(
  name: string,
  kind: SettlementFindingKind,
  at: string,
  claims: readonly SettlementClaim[],
  mutate: (base: ExarchosCapsuleV1) => ExarchosCapsuleV1 = (b) => b,
  deviations?: readonly ProposedDeviation[],
  context?: AdjudicationContext,
): AdjudicationCase {
  return { name, kind, at, capsule: mutate(baseValidCapsule()), claims, deviations, context };
}

const CASES: readonly AdjudicationCase[] = [
  bend('a claim for a task the graph does not declare', 'unknown-task', 'claims[1].taskId', [
    passingClaim(),
    { taskId: 'task-ghost', fields: {}, evidence: [] },
  ]),
  bend(
    'a claim for a task with no declared result shape',
    'undeclared-result-shape',
    'claims[1].fields',
    [passingClaim(), { taskId: 'task-compile', fields: { anything: 1 }, evidence: [] }],
  ),
  bend('two claims for one task', 'duplicate-claim', 'claims[1].taskId', [
    passingClaim(),
    passingClaim(),
  ]),
  bend('a required result the batch does not carry', 'missing-claim', 'claims', []),
  bend('a required field the claim omits', 'missing-field', 'claims[0].fields', [
    { taskId: 'task-verify', fields: {}, evidence: [] },
  ]),
  bend(
    'a field arriving as the wrong type',
    'field-type-mismatch',
    'claims[0].fields.passed',
    [{ taskId: 'task-verify', fields: { passed: 'yes' }, evidence: [] }],
  ),
  bend(
    'a field the result contract does not declare',
    'undeclared-field',
    'claims[0].fields.smuggled',
    [{ taskId: 'task-verify', fields: { passed: true, smuggled: 1 }, evidence: [] }],
  ),
  bend(
    'evidence of a kind the capsule does not admit',
    'inadmissible-evidence',
    'claims[0].evidence[0].kind',
    [{ taskId: 'task-verify', fields: { passed: true }, evidence: [{ kind: 'vibes', ref: 'r' }] }],
  ),
  bend(
    'evidence of an admitted kind whose reference does not resolve',
    'inadmissible-evidence',
    'claims[0].evidence[0].ref',
    [passingClaim()],
    (b) => b,
    undefined,
    { evidenceResolves: () => false },
  ),
  bend(
    'an accepted claim whose verification halted',
    'verification-failed',
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
    'deviations[0].deviationKind',
    [passingClaim()],
    (b) => b,
    [{ deviationKind: 'rewrote-the-charter', statement: 'seemed fine' }],
  ),
  bend(
    'a deviation inside an envelope that requires approval',
    'deviation-awaiting-approval',
    'deviations[0].deviationKind',
    [passingClaim()],
    (b) => b,
    [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
  ),
  bend(
    'a proposed deviation the decision refused',
    'deviation-rejected',
    'deviations[0].deviationKind',
    [passingClaim()],
    (b) => b,
    [{ deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' }],
    { evidenceResolves: () => true, decided: () => 'rejected' },
  ),
  bend(
    'a deviation that names a task the plan does not hold',
    'deviation-unknown-task',
    'deviations[0].affectedTasks[1]',
    [passingClaim()],
    (b) => b,
    [affecting('task-later', 'task-ghost')],
    standing({ 'task-later': { kind: 'pending' } }),
  ),
  bend(
    'a deviation that names a finished task',
    'deviation-names-finished-task',
    'deviations[0].affectedTasks[0]',
    [passingClaim()],
    (b) => b,
    [affecting('task-done', 'task-later')],
    standing({ 'task-done': { kind: 'finished' }, 'task-later': { kind: 'pending' } }),
  ),
  bend(
    'a deviation that names a task the batch claims',
    'deviation-names-claimed-task',
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

  it('Adjudicate_EveryDeclaredFindingKind_HasACase', () => {
    const covered = new Set(CASES.map((c) => c.kind));
    const uncovered = SETTLEMENT_FINDING_KINDS.filter((kind) => !covered.has(kind));
    expect(
      uncovered,
      `these finding kinds are declared and never exercised: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * This is the one finding kind that does not block. A refusal of a valid deviation pushes a worker to comply with a premise that it disproved.
   * The length check proves that every other kind blocks.
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
    expect(BLOCKING_SETTLEMENT_FINDING_KINDS).not.toContain('deviation-awaiting-approval');
    expect(BLOCKING_SETTLEMENT_FINDING_KINDS.length).toBe(SETTLEMENT_FINDING_KINDS.length - 1);
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
    expect(BLOCKING_SETTLEMENT_FINDING_KINDS).toContain('deviation-rejected');

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
   * Each finding about an affected task blocks, so the batch is rejected and not held. The
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
    for (const kind of ['deviation-unknown-task', 'deviation-names-finished-task', 'deviation-names-claimed-task']) {
      expect(BLOCKING_SETTLEMENT_FINDING_KINDS).toContain(kind);
    }
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
