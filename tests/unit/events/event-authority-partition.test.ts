// ─── The governance/telemetry partition, and the fold it has to survive ──────
//
// @oracle-sources: ../../../src/events/partition/authority.ts,
// ../../../src/events/partition/witnesses.ts,
// ../../../src/projections/views/workflow-state-projection.ts
//
// Two claims, and neither is checkable without the other.
//
// The first is that the partition is DERIVED: rebuild it from the catalog, the
// annotations and the witness table and you get exactly the shipped map, and a
// population it cannot partition fails by name rather than defaulting.
//
// The second is what the partition MEANS. "Telemetry" is only a real claim if
// dropping every telemetry event leaves the canonical fold's answer unchanged.
// So the differential folds one event of every catalog type through the
// workflow-state projection twice — once whole, once with the telemetry side
// removed — and requires the two states to be identical. The filter has to
// actually remove something, which is asserted against the derived telemetry
// set rather than a number, and a deliberate misclassification of a folded type
// has to make the two diverge, which is what stops the equality from being
// satisfiable by an empty filter.
//
// The fold is `workflowStateProjection.init()`/`.apply()` directly, never
// through the materializer, whose cache would skip the fold. It is deliberately
// this ONE fold: view projections such as the telemetry view exist precisely to
// consume telemetry, so a differential over every view would be red by design
// and would say nothing about governance.

import { describe, it, expect } from 'vitest';
import {
  deriveEventAuthority,
  type AuthorityWitness,
  type EventAuthority,
} from '../../../src/events/partition/authority.js';
import { GOVERNANCE_WITNESSES } from '../../../src/events/partition/witnesses.js';
import {
  EVENT_AUTHORITY,
  GOVERNANCE_EVENTS,
  TELEMETRY_EVENTS,
  classifyEventAuthority,
  tierEmissionSourceOf,
} from '../../../src/events/partition/event-authority.js';
import { EventTypes, type WorkflowEvent } from '../../../src/events/schemas.js';
import { buildEvent } from '../../../src/events/event-factory.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';

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
    data: {},
    timestamp: '2026-01-01T00:00:00.000Z',
  }),
);

function fold(events: readonly WorkflowEvent[]): unknown {
  return events.reduce(
    (state, event) => workflowStateProjection.apply(state, event),
    workflowStateProjection.init(),
  );
}

function foldExcluding(excluded: ReadonlySet<string>): unknown {
  return fold(CORPUS.filter((event) => !excluded.has(event.type)));
}

const A_GOVERNANCE_WITNESS: AuthorityWitness = {
  arm: 'charter-pin',
  evidence: ['lvlup-sw/exarchos#1876 ratified event-authority decision record'],
  because: 'A seeded witness, standing in for a real promotion.',
};

describe('EventAuthority — the partition is derived, and telemetry means droppable', () => {
  it('EventAuthority_LiveMap_IsTheDerivationOfEveryAnnotationAndWitness', () => {
    const rebuilt = deriveEventAuthority(
      EventTypes,
      tierEmissionSourceOf,
      GOVERNANCE_WITNESSES,
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

  it('DifferentialFold_Corpus_CarriesOneEventOfEveryTelemetryType', () => {
    expect(CORPUS.length).toBe(EventTypes.length);
    const missing = [...TELEMETRY_EVENTS].filter(
      (type) => !CORPUS.some((event) => event.type === type),
    );
    expect(missing).toEqual([]);

    const filtered = CORPUS.filter((event) => !TELEMETRY_EVENTS.has(event.type));
    // The filter must actually remove something, and exactly the telemetry side.
    expect(CORPUS.length - filtered.length).toBe(TELEMETRY_EVENTS.size);
  });

  it('DifferentialFold_GovernanceFilteredCorpus_FoldsIdenticallyToTheFullCorpus', () => {
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);
    expect(foldExcluding(TELEMETRY_EVENTS)).toEqual(fold(CORPUS));
  });

  it('DifferentialFold_TelemetryMisclassifyingAFoldedType_DivergesFromTheFullFold', () => {
    const foldedTypes = Object.entries(GOVERNANCE_WITNESSES)
      .filter(([, witness]) => witness.arm === 'projection-fold')
      .map(([type]) => type);
    expect(foldedTypes.length).toBeGreaterThan(0);

    for (const type of foldedTypes) {
      const misclassified = new Set([...TELEMETRY_EVENTS, type]);
      expect(foldExcluding(misclassified)).not.toEqual(fold(CORPUS));
    }
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
});
