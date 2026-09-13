// Adjudication is judged against the CAPSULE, and every case here bends the
// capsule or the batch by exactly one thing.
//
// The corpus is the capsule contract's own fixture rather than a hand-written
// stand-in, so a change to the schema reaches these cases instead of leaving
// them asserting against a shape that no longer ships. Every capsule used below
// is one the published contract accepts — a case that also failed the schema
// would be proving the schema, not the adjudicator.
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

interface AdjudicationCase {
  readonly name: string;
  readonly kind: SettlementFindingKind;
  readonly at: string;
  readonly capsule: ExarchosCapsuleV1;
  readonly claims: readonly SettlementClaim[];
  readonly deviations?: readonly ProposedDeviation[];
}

function bend(
  name: string,
  kind: SettlementFindingKind,
  at: string,
  claims: readonly SettlementClaim[],
  mutate: (base: ExarchosCapsuleV1) => ExarchosCapsuleV1 = (b) => b,
  deviations?: readonly ProposedDeviation[],
): AdjudicationCase {
  return { name, kind, at, capsule: mutate(baseValidCapsule()), claims, deviations };
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
];

describe('settlement adjudication', () => {
  it('Adjudicate_ABatchSatisfyingTheCapsule_Settles', () => {
    // The denominator. An adjudicator that refused everything would satisfy
    // every rejecting case below without this one.
    const verdict = adjudicateSettlement(baseValidCapsule(), [passingClaim()]);
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
    expect(verdict.acceptedTasks).toEqual(['task-verify']);
  });

  it('Adjudicate_TheVerdict_CarriesItsOwnDenominator', () => {
    // A settlement that adjudicated nothing and one that adjudicated everything
    // both report zero findings. Only the census separates them, which is why
    // it travels with the verdict rather than being recomputable by a reader
    // who would have to hold the capsule to do it.
    const empty = adjudicateSettlement(
      { ...baseValidCapsule(), settlementContract: { requiredResults: ['task-verify'] } },
      [],
    );
    const full = adjudicateSettlement(baseValidCapsule(), [passingClaim()]);
    expect(empty.adjudicated.claims).toBe(0);
    expect(full.adjudicated.claims).toBe(1);
    expect(full.adjudicated.fields).toBeGreaterThan(0);
    expect(full.adjudicated.evidence).toBe(1);
    expect(full.adjudicated.requiredResults).toBe(1);
  });

  it.each(CASES)('Adjudicate_IsStructurallyValid_$name', ({ capsule }) => {
    // Every case is a capsule the published contract ACCEPTS. One the schema
    // also refused would be proving the schema rather than this module.
    const parsed = ExarchosCapsuleV1Schema.safeParse(capsule);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it.each(CASES)('Adjudicate_IsNamed_$name', ({ capsule, claims, deviations, kind, at }) => {
    const verdict = adjudicateSettlement(capsule, claims, deviations ?? []);
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

  it('Adjudicate_ADeviationInsideTheEnvelope_HoldsTheBatchRatherThanRefusingIt', () => {
    // The one non-blocking finding, and the reason it is non-blocking: refusing
    // a legitimate deviation pushes a worker toward silently complying with a
    // premise it has already disproved.
    const verdict = adjudicateSettlement(baseValidCapsule(), [passingClaim()], [
      { deviationKind: 'invalidated-assumption', statement: 'the store is not SQLite' },
    ]);
    expect(verdict.outcome).toBe('deviation-pending');
    expect(verdict.findings.map((f) => f.kind)).toEqual(['deviation-awaiting-approval']);
    expect(BLOCKING_SETTLEMENT_FINDING_KINDS).not.toContain('deviation-awaiting-approval');
    // And it is the ONLY one: a list that had quietly become "everything" would
    // make the distinction above vacuous.
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
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
  });

  it('Adjudicate_ManyDefects_AreAllReported', () => {
    // One pass, every reason. A caller fixing a rejected batch that had to
    // discover its defects one round trip at a time is exactly the interaction
    // cost this plane exists to remove.
    const verdict = adjudicateSettlement(baseValidCapsule(), [
      { taskId: 'task-verify', fields: { passed: 'yes', smuggled: 1 }, evidence: [{ kind: 'vibes', ref: 'r' }] },
      { taskId: 'task-ghost', fields: {}, evidence: [] },
    ]);
    expect(new Set(verdict.findings.map((f) => f.kind))).toEqual(
      new Set(['field-type-mismatch', 'undeclared-field', 'inadmissible-evidence', 'unknown-task']),
    );
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.acceptedTasks).toEqual([]);
  });

  it('Adjudicate_ADefectiveDuplicateClaim_IsRefusedOnlyAsADuplicate', () => {
    // The duplicate is refused whole. A second claim carrying its own defects
    // must not also report them: those would be findings against a claim that
    // was never going to be considered.
    const verdict = adjudicateSettlement(baseValidCapsule(), [
      passingClaim(),
      { taskId: 'task-verify', fields: { passed: 'yes', smuggled: 1 }, evidence: [{ kind: 'vibes', ref: 'r' }] },
    ]);
    expect(verdict.findings.map((f) => [f.kind, f.at])).toEqual([['duplicate-claim', 'claims[1].taskId']]);
    expect(verdict.outcome).toBe('rejected');
  });

  it('Adjudicate_AnOptionalFieldLeftOut_IsNotAFinding', () => {
    // `required: false` has to mean something, or the flag is decoration.
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
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.adjudicated.fields).toBe(2);
  });
});
