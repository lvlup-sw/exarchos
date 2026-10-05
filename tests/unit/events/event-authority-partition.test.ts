// The governance and telemetry partition of the event catalog, and the canonical fold.
//
// @oracle-sources: ../../../src/events/partition/witnesses.ts, ../../../src/events/partition/demotions.ts, ../../../src/projections/views/workflow-state-projection.ts
//
// Claim 1: the partition is derived. A rebuild from the catalog, the annotations, the witnesses
// and the charter demotions gives exactly the shipped map. A population that the derivation
// cannot partition fails by name.
// Claim 2: telemetry is droppable. The canonical fold gives the same state with no telemetry
// events.
//
// Each corpus event carries a payload generated from its data schema, because a reducer arm that
// reads a field cannot fire on an empty payload. A type with no schema carries an explicit payload.
//
// The fold is `workflowStateProjection.init()` and `.apply()` directly, because the materializer
// cache skips the fold. The differential covers only this fold. A secondary view can derive a
// verdict from a telemetry event, so the suite bounds only what a retention policy drops from
// the canonical state.

import { describe, it, expect } from 'vitest';
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
import { EventTypes, type WorkflowEvent } from '../../../src/events/schemas.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import {
  CORPUS_PAYLOADS as PAYLOADS,
  CORPUS_SCHEMAS as SCHEMAS,
  UNSCHEMATIZED_PAYLOADS,
  buildAuthorityCorpus,
} from '../../../tools/test-helpers/authority-corpus.js';

/**
 * The shared corpus under the stream id of this suite. The helper builds it, so this differential
 * and the secondary-view differential measure the same population.
 */
const CORPUS = buildAuthorityCorpus('feat-authority-corpus');

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
 * The types that this corpus can see: the folded state changes when one is dropped.
 * The list is measured, and it is the denominator of each claim that the differential makes.
 */
const DISCRIMINATING: readonly string[] = EventTypes.filter(
  (type) => JSON.stringify(foldExcluding(new Set([type]))) !== FULL_FOLD,
);

/** The state that a realistic stream reaches. The tests fold one more event onto it. */
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
 * The types that the ratified charter names as telemetry examples. They are the tool and turn
 * records, the seven members of the team family, and four named types.
 * A demotion outside this set is a new decision. A member that is still governance is backlog.
 *
 * The set is a literal and not a family predicate. The charter did not name a member that joins
 * a family later, so the flip of that member is also a new decision.
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
  /** The denominator comes first: an empty rebuild makes each comparison vacuously true. */
  it('EventAuthority_LiveMap_IsTheDerivationOfEveryAnnotationWitnessAndDemotion', () => {
    const rebuilt = deriveEventAuthority(
      EventTypes,
      tierEmissionSourceOf,
      GOVERNANCE_WITNESSES,
      CHARTER_DEMOTIONS,
    );

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

  /**
   * A demotion row is the only way for an `auto` type to leave governance. The sibling with no
   * row stays governance, so the row does the work and not the tier.
   */
  it('EventAuthority_DemotionOfAnAutoTierType_ClassifiesItTelemetryAndOnlyIt', () => {
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

  /**
   * A flip has this shape when a new reader overtakes it: a witness arrives for a type that the
   * demotion table already holds. Neither table can win silently. The message must name the type
   * on both tiers, because a dead-cover arm otherwise claims it.
   */
  it('EventAuthority_WitnessAndDemotionOnOneType_IsNamedAsAContradictionNotResolved', () => {
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

  /**
   * The table must not be empty, because an empty table makes each filter vacuous.
   * The citation types reject a literal that is not an issue comment, but a cast gets past a type.
   * `assertCharterCitations` is the load-time check. It runs here on the live table and on two
   * seeded rows: one holds the placeholder, and one cites the issue and not the comment.
   */
  it('CharterDemotions_EveryLiveRow_IsACharterNamedTypeNowClassifiedTelemetryWithBothCitations', () => {
    const demoted = Object.keys(CHARTER_DEMOTIONS).sort();
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

  /**
   * A demotion row for a type that the canonical fold consumes must reach an oracle. Without one,
   * the table can drop governance events while each check is green.
   * The candidate is a discriminating `auto` type with no witness, so the row is admissible at load.
   * Control: the live telemetry set folds to the full state, and the seeded set adds only the
   * candidate. The divergence thus belongs to the seeded row.
   */
  it('CharterDemotions_SeededDemotionOfAFoldDiscriminatingType_IsCaughtByTheDifferentialFold', () => {
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

  /**
   * The corpus must hold each catalog type, and the telemetry filter must remove exactly the
   * telemetry types.
   */
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

    const missing = [...TELEMETRY_EVENTS].filter(
      (type) => !CORPUS.some((event) => event.type === type),
    );
    expect(missing).toEqual([]);

    const filtered = CORPUS.filter((event) => !TELEMETRY_EVENTS.has(event.type));
    expect(CORPUS.length - filtered.length).toBe(TELEMETRY_EVENTS.size);
  });

  /**
   * An arm can guard on the constraint that an invalid sample breaks. The corpus then reports the
   * arm as inert when the sampler is at fault. Each schema-sourced payload must thus pass its own
   * schema, and a failure names the types.
   */
  it('DifferentialFold_CorpusPayloads_ValidateUnderTheirOwnSchemas', () => {
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

  /**
   * The folded state changes when one of these types is dropped, so an equality over this corpus
   * is a real claim. The assertion is a floor and not an exact count, because an exact count
   * fails for each new folded event type.
   */
  it('DifferentialFold_CorpusDiscriminatingPower_IsAssertedNotAssumed', () => {
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

  /**
   * The charter names these types as telemetry examples, and the derivation still classifies nine
   * of them as governance. Some have a live reader outside the fold. Most derive `auto` from a
   * substrate tier, and only a charter demotion row moves such a type to telemetry.
   * The pinned set is the backlog. Each flip deletes its row here, so the list only shrinks and a
   * new disagreement cannot arrive silently.
   *
   * A demotion is a judgment against the tree and not against the charter text. The tree reads
   * `launch.executing_started` as the start claim of the launch liveness pair.
   */
  it('CharterTension_TelemetryExamplesStillClassifiedGovernance_AreThePinnedBacklog', () => {
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

  /**
   * A charter pin claims that no fold and no reader names the type. This test measures the fold
   * half of that negative claim. The raw-reader census measures the reader half over the same
   * table.
   */
  it('GovernanceWitnesses_CharterPinArm_ClaimsNoEvidenceItActuallyHas', () => {
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
