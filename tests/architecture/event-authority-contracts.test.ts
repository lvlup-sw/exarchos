/**
 * Every event a live DECLARATION names must be a governance event.
 *
 * @oracle-sources: ../../src/registry/**, ../../src/events/partition/**,
 * ../../src/verbs/gates/check-event-emissions.ts
 *
 * An `emissions` entry and an `event-append` postcondition are both promises
 * the dispatcher is held to: the emission is verified to have landed, the
 * postcondition is checked by re-reading the stream. A contract that named a
 * telemetry event would be promising something the partition says nothing
 * depends on — either the promise is enforced, in which case the event is
 * depended upon and the classification is wrong, or the classification is right
 * and the contract is declaring a promise nothing needs.
 *
 * The emission gate's phase-expectation table is the third declaration of the
 * same shape, and it is the one that bites. The gate iterates that table and
 * asks a set built from the raw stream whether each listed type is present, so
 * its complete/incomplete verdict is a function of exactly those types — yet no
 * literal comparison appears anywhere in the module, which means the source-scan
 * census structurally cannot see it. This is where `stack.submitted` was
 * classified telemetry while a shipped gate derived a verdict from its presence.
 *
 * This is an INDEPENDENT check rather than a restatement of the partition. Most
 * of the declared population is `auto` by tier, so it is green under the tier
 * map alone with no witness involved; what the conjunct rules out is a
 * declaration naming a type the tier does not cover.
 *
 * Every arm carries its declaration site, so a failure names where the promise
 * was made rather than only the event — a bare event name would leave a reader
 * grepping the whole registry for it.
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_REGISTRY,
  contractEmissionsOf,
  contractEnsuredEventsOf,
} from '../../src/registry.js';
import { EventTypes } from '../../src/events/schemas.js';
import { PHASE_EXPECTED_EVENTS } from '../../src/verbs/gates/check-event-emissions.js';
import {
  EVENT_AUTHORITY,
  TELEMETRY_EVENTS,
  classifyEventAuthority,
} from '../../src/events/partition/event-authority.js';
import { GOVERNANCE_WITNESSES } from '../../src/events/partition/witnesses.js';
import type { EventAuthority } from '../../src/events/partition/authority.js';

/** One event name a declaration names, with the site that named it. */
interface DeclaredEventName {
  readonly site: string;
  readonly arm: 'emissions' | 'ensures' | 'phase-expectation';
  readonly event: string;
}

/**
 * Every event name declared by any live built-in action, in registry order,
 * plus every event the emission gate expects a phase to have produced.
 *
 * Built by walking `TOOL_REGISTRY` and the live expectation table rather than a
 * snapshot, so a declaration added without a snapshot refresh is still in the
 * population.
 */
const DECLARED: readonly DeclaredEventName[] = [
  ...TOOL_REGISTRY.flatMap((tool) =>
    tool.actions.flatMap((action) => [
      ...contractEmissionsOf(action).map((emission) => ({
        site: `${tool.name}.${action.name}`,
        arm: 'emissions' as const,
        event: emission.event,
      })),
      ...contractEnsuredEventsOf(action).map((event) => ({
        site: `${tool.name}.${action.name}`,
        arm: 'ensures' as const,
        event,
      })),
    ]),
  ),
  ...Object.entries(PHASE_EXPECTED_EVENTS).flatMap(([phase, expected]) =>
    expected.map((event) => ({
      site: `check-event-emissions.PHASE_EXPECTED_EVENTS.${phase}`,
      arm: 'phase-expectation' as const,
      event,
    })),
  ),
];

/**
 * The conjunct itself, as a pure function over a declared population and a
 * classification — so the seeded probe below is judged by the same auditor that
 * reads the live registry, not by a parallel branch that could drift from it.
 */
function auditDeclaredEventNames(
  declared: readonly DeclaredEventName[],
  classification: Readonly<Record<string, EventAuthority>>,
): readonly string[] {
  return declared
    .filter((row) => classification[row.event] !== 'governance')
    .map(
      (row) =>
        `${row.site} declares ${row.arm} event "${row.event}", which the partition classifies ` +
        `as ${classification[row.event] ?? 'unknown'} — a contract may only promise a governance event.`,
    );
}

describe('ActionContractConjunct — a declared event is a governance event', () => {
  it('ActionContractConjunct_DeclaredEventPopulation_IsNonEmptyOnEveryArm', () => {
    // A floor, never the number: pinning the count would turn every new action
    // into a failure of this oracle instead of a check by it.
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(new Set(DECLARED.map((row) => row.event)).size).toBeGreaterThan(10);
    expect(DECLARED.every((row) => row.site.includes('.'))).toBe(true);

    // PER ARM, because the arms are read by different accessors and each can
    // fail to nothing on its own. `contractEnsuredEventsOf` in particular
    // swallows every failure and answers `[]`, and its events are a subset of
    // the emissions arm's — so a total collapse of that reader changed no result
    // anywhere until this floor existed.
    for (const arm of ['emissions', 'ensures', 'phase-expectation'] as const) {
      const rows = DECLARED.filter((row) => row.arm === arm);
      expect(rows.length, `the ${arm} arm resolved no declaration at all`).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.event)).size).toBeGreaterThan(0);
    }
  });

  it('ActionContractConjunct_GateExpectationWitness_IsNamedByTheLiveExpectationTable', () => {
    // The one witness arm no source scan can re-measure: the gate's read is an
    // iteration of a table, not a comparison against a literal. So it is
    // re-measured HERE, against the table itself — a witness whose expectation
    // row was deleted stops being evidence the moment the row goes.
    const declared = Object.entries(GOVERNANCE_WITNESSES)
      .filter(([, witness]) => witness.arm === 'gate-expectation')
      .map(([type]) => type);
    expect(declared.length).toBeGreaterThan(0);

    const expected = new Set<string>(Object.values(PHASE_EXPECTED_EVENTS).flat());
    expect(expected.size).toBeGreaterThan(0);

    const unsupported = declared.filter((type) => !expected.has(type));
    expect(
      unsupported,
      'A gate-expectation witness promotes a type the expectation table no longer lists. The ' +
        'declaration outlived the row it cites — retire the promotion, or repoint it.',
    ).toEqual([]);
  });

  it('ActionContractConjunct_EveryDeclaredEventName_IsAKnownEventType', () => {
    const known = new Set<string>(EventTypes);
    const unknown = DECLARED.filter((row) => !known.has(row.event)).map(
      (row) => `${row.site} (${row.arm}) → ${row.event}`,
    );
    expect(unknown).toEqual([]);
  });

  it('ActionContractConjunct_EveryDeclaredEventName_ResolvesToAGovernanceEvent', () => {
    const unclassified = DECLARED.filter(
      (row) => classifyEventAuthority(row.event) === undefined,
    ).map((row) => `${row.site} (${row.arm}) → ${row.event}`);
    expect(unclassified).toEqual([]);

    expect(auditDeclaredEventNames(DECLARED, EVENT_AUTHORITY)).toEqual([]);
  });

  it('ActionContractConjunct_SeededContractNamingATelemetryType_IsNamedInTheFailure', () => {
    const [telemetryType] = [...TELEMETRY_EVENTS].sort();
    expect(telemetryType).toBeDefined();

    const seededSite = 'exarchos_seeded.seeded_action';
    const seededPhase = 'check-event-emissions.PHASE_EXPECTED_EVENTS.seeded_phase';
    const seeded: readonly DeclaredEventName[] = [
      ...DECLARED,
      { site: seededSite, arm: 'emissions', event: telemetryType ?? '' },
      { site: seededPhase, arm: 'phase-expectation', event: telemetryType ?? '' },
    ];

    const findings = auditDeclaredEventNames(seeded, EVENT_AUTHORITY);
    expect(findings.length).toBe(2);
    expect(findings.join('\n')).toContain(seededSite);
    expect(findings.join('\n')).toContain(seededPhase);
    expect(findings.join('\n')).toContain(telemetryType ?? '');
  });
});
