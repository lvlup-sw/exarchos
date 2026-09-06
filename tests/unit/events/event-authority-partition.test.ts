// ─── The governance/telemetry partition, and the fold it has to survive ──────
//
// @oracle-sources: ../../../src/events/partition/witnesses.ts, ../../../src/events/partition/demotions.ts, ../../../src/projections/views/workflow-state-projection.ts
//
// Two claims, and neither is checkable without the other.
//
// The first is that the partition is DERIVED: rebuild it from the catalog, the
// annotations and the two override tables — witnesses and charter demotions —
// and you get exactly the shipped map, and a population it cannot partition
// fails by name rather than defaulting.
//
// The second is what the partition MEANS. "Telemetry" is only a real claim if
// dropping every telemetry event leaves the canonical fold's answer unchanged.
//
// ## Why the corpus payloads are generated, not empty
//
// The corpus once carried `data: {}` for every type, and that made the second
// claim nearly unfalsifiable: a reducer arm that reads a field before it mutates
// cannot fire on an empty bag, so 168 of 178 catalog types folded to a no-op for
// a reason that had nothing to do with their classification. A mutating arm
// added for a telemetry-classified type would have been invisible.
//
// So each corpus event carries the richest payload its own data schema admits,
// generated from that schema rather than transcribed. The handful of types that
// declare no schema carry an explicit payload here, and the coverage is asserted
// BOTH ways: a type with neither is named, and a hand-written payload for a type
// whose schema already produces one is named as dead cover.
//
// ## What the differential actually asserts
//
//   • per telemetry type, that its arm is IDENTITY — applied to a fresh state
//     and to a realistic folded state, it changes nothing. This is the claim,
//     stated one type at a time so a failure names the type;
//   • that the whole governance-filtered corpus folds to the full corpus's state;
//   • that misclassifying ANY type the corpus can discriminate makes the two
//     folds diverge — the discriminating set is measured, not a pair of
//     hand-picked witnesses, and its size is asserted so a corpus that went inert
//     again cannot pass.
//
// The fold is `workflowStateProjection.init()`/`.apply()` directly, never
// through the materializer, whose cache would skip the fold. It is deliberately
// this ONE fold: view projections such as the telemetry view exist precisely to
// consume telemetry, so a differential over every view would be red by design
// and would say nothing about governance. That scoping has a KNOWN limit worth
// stating: a secondary view can derive a verdict from a telemetry event without
// the canonical fold noticing — the synthesis-readiness view computes its
// blockers from test and typecheck results — so this differential bounds what a
// retention policy may drop from the canonical state, not from every view.

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  deriveEventAuthority,
  type AuthorityWitness,
  type CharterDemotion,
  type EventAuthority,
} from '../../../src/events/partition/authority.js';
import {
  CHARTER_DEMOTIONS,
  assertCharterCitations,
} from '../../../src/events/partition/demotions.js';
import { GOVERNANCE_WITNESSES } from '../../../src/events/partition/witnesses.js';
import {
  EVENT_AUTHORITY,
  GOVERNANCE_EVENTS,
  TELEMETRY_EVENTS,
  classifyEventAuthority,
  tierEmissionSourceOf,
} from '../../../src/events/partition/event-authority.js';
import {
  EVENT_DATA_SCHEMAS,
  EventTypes,
  type WorkflowEvent,
} from '../../../src/events/schemas.js';
import { buildEvent } from '../../../src/events/event-factory.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import { sampleEventData } from '../../../tools/test-helpers/event-payload-sample.js';

/**
 * Payloads for the catalog types that declare no data schema, so the corpus has
 * no empty-bag holes for a fold arm to hide behind. `state.patched` is the one
 * that matters — its patch bag is hash-unrecoverable by construction, which is
 * exactly why it has no schema and exactly why it must not fold as a no-op.
 */
const UNSCHEMATIZED_PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  'state.patched': { patch: { 'oneshot.synthesisPolicy': 'always' } },
  'pr.created': { prNumber: 1, url: 'https://example.invalid/pr/1' },
  'pr.merged': { prNumber: 1, mergedAt: '2026-01-01T00:00:00.000Z' },
  'pr.commented': { prNumber: 1, body: 'sample comment' },
  'issue.created': { issueNumber: 1, url: 'https://example.invalid/issue/1' },
  'checkpoint.enforced': { reason: 'sample reason' },
  'checkpoint.state_missing': { featureId: 'feat-authority-corpus' },
  'preflight.executed': { check: 'sample check', passed: true },
  'preflight.blocked': { check: 'sample check', reason: 'sample reason' },
};

const SCHEMAS: Readonly<Record<string, z.ZodType | undefined>> = EVENT_DATA_SCHEMAS;

/**
 * Constraints a schema states as a refinement, which JSON Schema cannot carry
 * and the sampler therefore cannot see: a workflow type must be a registered
 * name, and a migration source path must be state-dir relative. These are
 * merged over the sampled payload; the validity assertion below is what keeps
 * this table honest, because a refinement the sampler can suddenly satisfy
 * makes its row here dead cover that the next reader should delete.
 */
const REFINEMENT_OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = {
  'workflow.started': { workflowType: 'feature' },
  'migration.legacy_jsonl_imported': { sourcePath: 'legacy/events.jsonl' },
};

/** The payload the corpus uses for a type, and where it came from. */
interface CorpusPayload {
  readonly data: Record<string, unknown>;
  readonly source: 'schema' | 'unschematized' | 'none';
}

function payloadFor(eventType: string): CorpusPayload {
  const sampled = sampleEventData(SCHEMAS[eventType]);
  if (sampled !== undefined && Object.keys(sampled).length > 0) {
    return { data: { ...sampled, ...REFINEMENT_OVERRIDES[eventType] }, source: 'schema' };
  }
  const supplied = UNSCHEMATIZED_PAYLOADS[eventType];
  if (supplied !== undefined) return { data: supplied, source: 'unschematized' };
  return { data: {}, source: 'none' };
}

const PAYLOADS: ReadonlyMap<string, CorpusPayload> = new Map(
  EventTypes.map((type) => [type, payloadFor(type)] as const),
);

/**
 * One event of every catalog type, in catalog order. Total over the catalog by
 * construction, so it cannot go vacuous when a type is added — a new event type
 * joins the corpus without anyone editing this file.
 *
 * The timestamp is fixed so the two folds compare a state whose time fields
 * came from the events rather than from the clock.
 */
const CORPUS: readonly WorkflowEvent[] = EventTypes.map((type, index) =>
  buildEvent('feat-authority-corpus', index + 1, {
    type,
    data: PAYLOADS.get(type)?.data ?? {},
    timestamp: '2026-01-01T00:00:00.000Z',
  }),
);

type FoldedState = ReturnType<typeof workflowStateProjection.init>;

function fold(events: readonly WorkflowEvent[]): FoldedState {
  return events.reduce(
    (state, event) => workflowStateProjection.apply(state, event),
    workflowStateProjection.init(),
  );
}

function foldExcluding(excluded: ReadonlySet<string>): FoldedState {
  return fold(CORPUS.filter((event) => !excluded.has(event.type)));
}

const FULL_FOLD = JSON.stringify(fold(CORPUS));

/**
 * The types this corpus can actually SEE: dropping one changes the folded
 * state. Measured, never listed — it is the honest denominator of every claim
 * the differential makes, and asserting its size is what stops a corpus that
 * quietly went inert from passing.
 */
const DISCRIMINATING: readonly string[] = EventTypes.filter(
  (type) => JSON.stringify(foldExcluding(new Set([type]))) !== FULL_FOLD,
);

/** The state a realistic stream reaches, for folding one more event onto. */
const GOVERNANCE_STATE = foldExcluding(TELEMETRY_EVENTS);

const A_GOVERNANCE_WITNESS: AuthorityWitness = {
  arm: 'charter-pin',
  evidence: ['lvlup-sw/exarchos#1876 ratified event-authority decision record'],
  because: 'A seeded witness, standing in for a real promotion.',
};

const A_CHARTER_DEMOTION: CharterDemotion = {
  act: 'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-1',
  record: 'https://github.com/lvlup-sw/exarchos/issues/1876#issuecomment-1',
  because: 'A seeded demotion, standing in for a real charter act.',
};

/**
 * The bucket the ratified charter names as telemetry EXAMPLES, enumerated as
 * the catalog stood when the first act was made — the per-tool and turn
 * records, the team family's seven members, and four named types. A demotion
 * outside this bucket would be a new decision wearing a flip's clothes, and a
 * member of it still classified governance is the backlog the charter
 * schedules.
 *
 * A LITERAL set, not a family predicate: a member added to the tool or team
 * family later was not named by the record, so its flip is a new decision too,
 * and a `startsWith` would have admitted it as if the act had covered it.
 */
const CHARTER_TELEMETRY_EXAMPLES: ReadonlySet<string> = new Set([
  'tool.invoked',
  'tool.completed',
  'tool.errored',
  'tool.action_errored',
  'turn.completed',
  'subagent.tokens_used',
  'launch.executing_started',
  'team.spawned',
  'team.disbanded',
  'team.task.planned',
  'team.task.assigned',
  'team.teammate.dispatched',
  'team.task.completed',
  'team.task.failed',
  'shepherd.iteration',
  'stack.submitted',
]);

describe('EventAuthority — the partition is derived, and telemetry means droppable', () => {
  it('EventAuthority_LiveMap_IsTheDerivationOfEveryAnnotationWitnessAndDemotion', () => {
    const rebuilt = deriveEventAuthority(
      EventTypes,
      tierEmissionSourceOf,
      GOVERNANCE_WITNESSES,
      CHARTER_DEMOTIONS,
    );

    // The denominator first: an empty rebuild would make every comparison below
    // vacuously true.
    expect(Object.keys(rebuilt).length).toBe(EventTypes.length);
    expect(Object.keys(rebuilt).length).toBeGreaterThan(0);

    const disagreements = EventTypes.filter(
      (type) => rebuilt[type] !== EVENT_AUTHORITY[type],
    ).map((type) => `${type}: shipped=${EVENT_AUTHORITY[type]} derived=${rebuilt[type]}`);
    expect(disagreements).toEqual([]);
  });

  it('EventAuthority_EmptyPopulation_Throws', () => {
    expect(() => deriveEventAuthority([], () => 'auto', {})).toThrow(
      /empty event-type population/,
    );
  });

  it('EventAuthority_UnannotatedType_IsNamedInTheThrow', () => {
    expect(() =>
      deriveEventAuthority(['ghost.unannotated', 'other.unannotated'], () => undefined, {}),
    ).toThrow(/ghost\.unannotated, other\.unannotated/);
  });

  it('EventAuthority_WitnessForAnUnknownEventType_IsNamedInTheThrow', () => {
    expect(() =>
      deriveEventAuthority(['live.telemetry'], () => 'model', {
        'renamed.away': A_GOVERNANCE_WITNESS,
      }),
    ).toThrow(/renamed\.away/);
  });

  it('EventAuthority_WitnessOnATypeAlreadyGovernanceByTier_IsNamedAsDeadCover', () => {
    expect(() =>
      deriveEventAuthority(['already.governance'], () => 'auto', {
        'already.governance': A_GOVERNANCE_WITNESS,
      }),
    ).toThrow(/already\.governance/);
  });

  it('EventAuthority_DemotionOfAnAutoTierType_ClassifiesItTelemetryAndOnlyIt', () => {
    // The one way an `auto` type leaves governance. The sibling with no row
    // stays where the tier put it, so the row is doing the work and not the
    // tier.
    const derived = deriveEventAuthority(
      ['flipped.record', 'kept.record'],
      () => 'auto',
      {},
      { 'flipped.record': A_CHARTER_DEMOTION },
    );
    expect(derived).toEqual({ 'flipped.record': 'telemetry', 'kept.record': 'governance' });
  });

  it('EventAuthority_DemotionForAnUnknownEventType_IsNamedInTheThrow', () => {
    expect(() =>
      deriveEventAuthority(['live.record'], () => 'auto', {}, {
        'renamed.away': A_CHARTER_DEMOTION,
      }),
    ).toThrow(/charter demotion\(s\) name an event type that is not in the population: renamed\.away/);
  });

  it('EventAuthority_DemotionOnATypeAlreadyTelemetryByTier_IsNamedAsDeadCover', () => {
    expect(() =>
      deriveEventAuthority(['already.telemetry'], () => 'model', {}, {
        'already.telemetry': A_CHARTER_DEMOTION,
      }),
    ).toThrow(/whose tier already derives telemetry: already\.telemetry/);
  });

  it('EventAuthority_WitnessAndDemotionOnOneType_IsNamedAsAContradictionNotResolved', () => {
    // This is the shape a flip takes when a new reader overtakes it: someone
    // adds a raw-reader witness for a type the demotion table already holds.
    // Neither table may win silently, and the message must say which type —
    // on BOTH tiers, because the dead-cover arms would otherwise claim it.
    for (const tier of ['auto', 'model'] as const) {
      expect(() =>
        deriveEventAuthority(
          ['contested.record'],
          () => tier,
          { 'contested.record': A_GOVERNANCE_WITNESS },
          { 'contested.record': A_CHARTER_DEMOTION },
        ),
      ).toThrow(/BOTH a governance witness and a charter demotion: contested\.record/);
    }
  });

  it('CharterDemotions_EveryLiveRow_IsACharterNamedTypeNowClassifiedTelemetryWithBothCitations', () => {
    const demoted = Object.keys(CHARTER_DEMOTIONS).sort();
    // The denominator: an empty table makes every filter below vacuous, and
    // this slice is the one that put the first rows in.
    expect(demoted.length).toBeGreaterThan(0);

    const outsideTheCharter = demoted.filter((type) => !CHARTER_TELEMETRY_EXAMPLES.has(type));
    expect(
      outsideTheCharter,
      'A demotion of a type the ratified charter never called telemetry is a new decision, not ' +
        'a flip. Take it to the roadmap first, then add the type to CHARTER_TELEMETRY_EXAMPLES ' +
        'with the new act as its citation.',
    ).toEqual([]);

    const notTelemetry = demoted.filter((type) => classifyEventAuthority(type) !== 'telemetry');
    expect(notTelemetry).toEqual([]);

    // The act on the roadmap made the flip land; the decision record is what
    // it executes. Both citations are TYPED, so a literal that is not a comment
    // on #1599 or #1876 does not compile (the self-tests in demotions.ts pin the
    // placeholder shape the first draft carried). The load-time check is what a
    // cast cannot get past; it is exercised here on the live table and, through
    // the same function, on a seeded row that still carries the placeholder.
    expect(() => assertCharterCitations(CHARTER_DEMOTIONS)).not.toThrow();
    expect(() =>
      assertCharterCitations({
        'seeded.record': {
          act: 'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-CHARTER_ACT_COMMENT_ID',
          record: 'https://github.com/lvlup-sw/exarchos/issues/1876#issuecomment-5465417502',
          because: 'A row that never had its placeholder filled in.',
        },
      }),
    ).toThrow(/seeded\.record \(act: .*CHARTER_ACT_COMMENT_ID/);
    expect(() =>
      assertCharterCitations({
        'seeded.record': {
          act: 'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-5555387087',
          record: 'https://github.com/lvlup-sw/exarchos/issues/1876',
          because: 'A row citing the issue rather than the comment that ratified the record.',
        },
      }),
    ).toThrow(/seeded\.record/);
  });

  it('CharterDemotions_SeededDemotionOfAFoldDiscriminatingType_IsCaughtByTheDifferentialFold', () => {
    // A wrong demotion — a row for a type the canonical fold consumes — must
    // reach an oracle, or the demotion table is a way to drop governance
    // events with every check green. Take a discriminating type whose tier is
    // `auto` and that carries no witness (so the row is admissible at load),
    // derive with it demoted, and show the governance-filtered fold diverges.
    const candidate = DISCRIMINATING.find(
      (type) => tierEmissionSourceOf(type) === 'auto' && GOVERNANCE_WITNESSES[type] === undefined,
    );
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    const seeded = deriveEventAuthority(EventTypes, tierEmissionSourceOf, GOVERNANCE_WITNESSES, {
      ...CHARTER_DEMOTIONS,
      [candidate]: A_CHARTER_DEMOTION,
    });
    expect(seeded[candidate]).toBe('telemetry');

    // Control: the LIVE telemetry set folds back to the full state, and the
    // seeded set is that set plus exactly the candidate — so the divergence
    // below is the seeded row's, not some already-telemetry type's.
    const liveTelemetry: ReadonlySet<string> = TELEMETRY_EVENTS;
    expect(JSON.stringify(foldExcluding(liveTelemetry))).toBe(FULL_FOLD);
    const seededTelemetry = new Set<string>(
      EventTypes.filter((type) => seeded[type] === 'telemetry'),
    );
    expect([...seededTelemetry].filter((type) => !liveTelemetry.has(type))).toEqual([candidate]);
    expect(JSON.stringify(foldExcluding(seededTelemetry))).not.toBe(FULL_FOLD);
  });

  it('EventAuthority_TelemetrySet_IsNonEmptyAndDerivedFromTheMap', () => {
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);
    expect(GOVERNANCE_EVENTS.size).toBeGreaterThan(0);
    expect(TELEMETRY_EVENTS.size + GOVERNANCE_EVENTS.size).toBe(EventTypes.length);

    const misfiled = [...TELEMETRY_EVENTS].filter(
      (type) => classifyEventAuthority(type) !== 'telemetry',
    );
    expect(misfiled).toEqual([]);
    const misfiledGovernance = [...GOVERNANCE_EVENTS].filter(
      (type) => classifyEventAuthority(type) !== 'governance',
    );
    expect(misfiledGovernance).toEqual([]);
  });

  it('DifferentialFold_Corpus_CarriesARealisticPayloadForEveryCatalogType', () => {
    expect(CORPUS.length).toBe(EventTypes.length);

    const empty = EventTypes.filter((type) => PAYLOADS.get(type)?.source === 'none');
    expect(
      empty,
      'A type whose corpus event carries an empty payload cannot exercise a fold arm that reads ' +
        'a field, so its inertness in this corpus proves nothing. Give it a data schema, or a ' +
        'payload in UNSCHEMATIZED_PAYLOADS.',
    ).toEqual([]);

    const deadCover = Object.keys(UNSCHEMATIZED_PAYLOADS).filter(
      (type) => PAYLOADS.get(type)?.source !== 'unschematized',
    );
    expect(
      deadCover,
      'A hand-written payload for a type whose schema already generates one changes nothing and ' +
        'so is checked by nothing — delete it.',
    ).toEqual([]);

    // The corpus is total over the catalog, telemetry side included.
    const missing = [...TELEMETRY_EVENTS].filter(
      (type) => !CORPUS.some((event) => event.type === type),
    );
    expect(missing).toEqual([]);

    const filtered = CORPUS.filter((event) => !TELEMETRY_EVENTS.has(event.type));
    // The filter must actually remove something, and exactly the telemetry side.
    expect(CORPUS.length - filtered.length).toBe(TELEMETRY_EVENTS.size);
  });

  it('DifferentialFold_CorpusPayloads_ValidateUnderTheirOwnSchemas', () => {
    // The fold is fed schema-generated payloads so that every arm has a real
    // event to run on. A payload the type's own schema rejects — one item
    // where two are required, a bare string where a timestamp is — is not
    // that: the arm it was meant to exercise may guard on exactly the
    // constraint the sample broke, and the corpus would then report the arm
    // inert while the sampler was the thing at fault. Validity is asserted
    // here for the whole catalog, so a sampler regression names its types.
    const rejected: string[] = [];
    let validated = 0;
    for (const [type, payload] of PAYLOADS) {
      if (payload.source !== 'schema') continue;
      const schema = SCHEMAS[type];
      if (schema === undefined) continue;
      const result = schema.safeParse(payload.data);
      validated += 1;
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 2)
          .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
          .join('; ');
        rejected.push(`${type} — ${issues}`);
      }
    }
    expect(validated, 'no schema-sourced payload reached validation').toBeGreaterThan(100);
    expect(rejected, 'schema-generated payloads the schema itself rejects').toEqual([]);
  });

  it('DifferentialFold_CorpusDiscriminatingPower_IsAssertedNotAssumed', () => {
    // Dropping any one of these changes the folded state, so an equality over
    // this corpus is a claim about something. The floor is a floor, never the
    // number: pinning the count would make every new folded event type a failure
    // of this oracle rather than a check by it.
    expect(
      DISCRIMINATING.length,
      'The corpus can no longer tell any event from a no-op, so every fold comparison below is ' +
        'satisfiable by an empty projection.',
    ).toBeGreaterThan(10);
    expect(DISCRIMINATING.every((type) => classifyEventAuthority(type) === 'governance')).toBe(
      true,
    );
  });

  it('DifferentialFold_EveryTelemetryType_FoldsToIdentity', () => {
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);

    const initial = JSON.stringify(workflowStateProjection.init());
    const governance = JSON.stringify(GOVERNANCE_STATE);
    const mutating: string[] = [];
    for (const type of [...TELEMETRY_EVENTS].sort()) {
      const event = CORPUS.find((candidate) => candidate.type === type);
      expect(event).toBeDefined();
      if (event === undefined) continue;
      const ontoInit = JSON.stringify(
        workflowStateProjection.apply(workflowStateProjection.init(), event),
      );
      const ontoGovernance = JSON.stringify(
        workflowStateProjection.apply(GOVERNANCE_STATE, event),
      );
      if (ontoInit !== initial) mutating.push(`${type} (on a fresh state)`);
      if (ontoGovernance !== governance) mutating.push(`${type} (on a folded state)`);
    }
    expect(
      mutating,
      'A telemetry-classified event changed the canonical fold. Either the arm is wrong or the ' +
        'classification is — the partition says nothing depends on these events.',
    ).toEqual([]);
  });

  it('DifferentialFold_GovernanceFilteredCorpus_FoldsIdenticallyToTheFullCorpus', () => {
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);
    expect(foldExcluding(TELEMETRY_EVENTS)).toEqual(fold(CORPUS));
  });

  it('DifferentialFold_MisclassifyingAnyDiscriminatingType_DivergesFromTheFullFold', () => {
    expect(DISCRIMINATING.length).toBeGreaterThan(10);

    const undetected: string[] = [];
    for (const type of DISCRIMINATING) {
      const misclassified = new Set([...TELEMETRY_EVENTS, type]);
      if (JSON.stringify(foldExcluding(misclassified)) === FULL_FOLD) undetected.push(type);
    }
    expect(undetected).toEqual([]);
  });

  it('GovernanceWitnesses_ProjectionFoldArm_ChangesTheCanonicalFoldState', () => {
    const declared = Object.entries(GOVERNANCE_WITNESSES).filter(
      ([, witness]) => witness.arm === 'projection-fold',
    );
    expect(declared.length).toBeGreaterThan(0);

    const inert: string[] = [];
    const notGovernance: string[] = [];
    for (const [type] of declared) {
      const seeded = CORPUS.find((event) => event.type === type);
      expect(seeded).toBeDefined();
      const applied = seeded === undefined
        ? workflowStateProjection.init()
        : workflowStateProjection.apply(workflowStateProjection.init(), seeded);
      if (JSON.stringify(applied) === JSON.stringify(workflowStateProjection.init())) {
        inert.push(type);
      }
      const classification: EventAuthority | undefined = classifyEventAuthority(type);
      if (classification !== 'governance') notGovernance.push(type);
    }
    expect(inert).toEqual([]);
    expect(notGovernance).toEqual([]);
  });

  it('CharterTension_TelemetryExamplesStillClassifiedGovernance_AreThePinnedBacklog', () => {
    // The ratified charter names a bucket of types as telemetry EXAMPLES. The
    // derivation disagrees with it for most of them, and for two different
    // reasons: some carry a live fold-external reader (a demotion would be
    // false), and most derive `auto` from a substrate tier, which the
    // promotion-only rule refuses to override with an instrument that cannot
    // prove a universal absence.
    //
    // Neither reason is an argument for leaving the disagreement in a comment.
    // The charter schedules those flips as later, independently-landable work,
    // and each one has to delete its expectation row in the same commit — so the
    // gap is a BACKLOG, and a backlog is a thing you count. Pinning the exact
    // set makes every flip a visible shrink and makes a new disagreement
    // impossible to add silently.
    //
    // The first flips landed with the 2026-09-05 charter act: the per-tool and
    // turn records and the token self-report are demoted by charter row, and
    // `stack.submitted` left the expectation table that was its only reader.
    // Nine remain, each for a measured reason — the team family carries the
    // canonical fold (spawned/disbanded), the stop hook's teammate resolution
    // (assigned/dispatched), the saga verifier (planned/completed/failed) and
    // the agent-event validator; `shepherd.iteration` is the escalation bound's
    // event-sourced count; and `launch.executing_started`, which the decision
    // record filed beside the hook-tier self-reports, is on the tree the START
    // claim of the launch liveness pair — read raw by the `worktrees@v1`
    // reducer that `ps` and the phantom-launch heal fold, so the reader census
    // names it, and paired by the descriptor the declaration conjunct's
    // liveness arm names. That last one is why a demotion is a judgment made
    // against the tree and never against the charter's text.
    const catalog = new Set<string>(EventTypes);
    const renamedAway = [...CHARTER_TELEMETRY_EXAMPLES].filter((type) => !catalog.has(type));
    expect(
      renamedAway,
      'A charter example is no longer a catalog type — the list outlived a rename or a retirement.',
    ).toEqual([]);
    const charterExamples = EventTypes.filter((type) => CHARTER_TELEMETRY_EXAMPLES.has(type));
    expect(charterExamples.length).toBe(CHARTER_TELEMETRY_EXAMPLES.size);
    expect(charterExamples.length).toBeGreaterThan(10);

    const stillGovernance = charterExamples
      .filter((type) => classifyEventAuthority(type) === 'governance')
      .sort();

    expect(
      stillGovernance,
      'The charter calls these telemetry and the derivation still calls them governance. Each ' +
        'flip is its own change — it deletes the expectation row and the description row with ' +
        'the demotion — so this list may only SHRINK, and a new entry means a type was promoted ' +
        'against the charter without saying so.',
    ).toEqual([
      'launch.executing_started',
      'shepherd.iteration',
      'team.disbanded',
      'team.spawned',
      'team.task.assigned',
      'team.task.completed',
      'team.task.failed',
      'team.task.planned',
      'team.teammate.dispatched',
    ]);
  });

  it('GovernanceWitnesses_CharterPinArm_ClaimsNoEvidenceItActuallyHas', () => {
    // A charter pin says: no fold names this, and no reader does. That is a
    // NEGATIVE claim, and an unchecked negative claim is how a promotion with
    // real evidence ends up filed under the one arm no oracle re-measures. The
    // fold half is measurable right here; the reader half is measured by the
    // raw-reader census, which checks the same table.
    const pinned = Object.entries(GOVERNANCE_WITNESSES)
      .filter(([, witness]) => witness.arm === 'charter-pin')
      .map(([type]) => type);
    expect(pinned.length).toBeGreaterThan(0);

    const contradicted = pinned.filter((type) => DISCRIMINATING.includes(type));
    expect(
      contradicted,
      'A charter-pin row claims the canonical fold does not name its type, but dropping the type ' +
        'changes the fold. Move the row to the projection-fold arm, which is measured.',
    ).toEqual([]);
  });
});
