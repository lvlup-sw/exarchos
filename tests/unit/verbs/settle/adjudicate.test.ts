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
  adjudicateSettlement,
  type AdjudicationContext,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementFindingKind,
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
   * A settlement that adjudicated nothing and one that adjudicated everything both report zero findings.
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
