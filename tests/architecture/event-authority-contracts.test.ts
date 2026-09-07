/**
 * Every event a live DECLARATION names must be a governance event.
 *
 * @oracle-sources: ../../src/registry/**, ../../src/events/partition/**,
 * ../../src/events/liveness-registry.ts,
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
 * Two more declaration tables have the same shape, and both are ones the
 * source-scan census structurally cannot see, because the read they describe is
 * an iteration of a table rather than a comparison against a literal:
 *
 *   • the emission gate's phase-expectation table. The gate iterates it and
 *     asks a set built from the raw stream whether each listed type is present,
 *     so its complete/incomplete verdict is a function of exactly those types.
 *     This is where `stack.submitted` was classified telemetry while a shipped
 *     gate derived a verdict from its presence — and, later, where its flip
 *     landed by deleting the row that was its only reader;
 *   • the liveness registry. Each descriptor names a START type and its
 *     TERMINAL types, and `ps` and the phantom-launch heal pair them through the
 *     `worktrees@v1` fold to decide what is in flight. The decision record filed
 *     `launch.executing_started` beside the hook-tier self-reports; the reader
 *     census names that fold's reducer, and this arm names the descriptor, so a
 *     demotion row for it would be red in both. For the merge and mutation START
 *     claims the census finds no reader at all, and there this arm is the only
 *     oracle.
 *
 * This is an INDEPENDENT check rather than a restatement of the partition. Most
 * of the declared population is `auto` by tier, so it is green under the tier
 * map alone with no witness involved; what the conjunct rules out is a
 * declaration naming a type the tier does not cover — or one a charter
 * demotion has since removed from it.
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
import { LIVENESS_DESCRIPTORS } from '../../src/events/liveness-registry.js';
import { PHASE_EXPECTED_EVENTS } from '../../src/verbs/gates/check-event-emissions.js';
import {
  EVENT_AUTHORITY,
  TELEMETRY_EVENTS,
  classifyEventAuthority,
} from '../../src/events/partition/event-authority.js';
import { GOVERNANCE_WITNESSES } from '../../src/events/partition/witnesses.js';
import type { AuthorityWitness, EventAuthority } from '../../src/events/partition/authority.js';

/** One event name a declaration names, with the site that named it. */
interface DeclaredEventName {
  readonly site: string;
  readonly arm: 'emissions' | 'ensures' | 'phase-expectation' | 'liveness-pair';
  readonly event: string;
}

const DECLARED_ARMS = ['emissions', 'ensures', 'phase-expectation', 'liveness-pair'] as const;

/**
 * Every event name declared by any live built-in action, in registry order,
 * plus every event the emission gate expects a phase to have produced, plus
 * every START and TERMINAL type a liveness descriptor pairs on.
 *
 * Built by walking `TOOL_REGISTRY` and the live tables rather than a snapshot,
 * so a declaration added without a snapshot refresh is still in the population.
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
  ...LIVENESS_DESCRIPTORS.flatMap((descriptor) =>
    [descriptor.startType, ...descriptor.terminalTypes].map((event) => ({
      site: `liveness-registry.${descriptor.surface}`,
      arm: 'liveness-pair' as const,
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

/**
 * The reverse of the gate-expectation arm: a witness that cites the expectation
 * table is evidence only while the table still lists its type. Pure, so the
 * live table and a seeded stale row go through the same auditor.
 */
function staleGateExpectationWitnesses(
  witnesses: Readonly<Record<string, AuthorityWitness>>,
  expected: ReadonlySet<string>,
): readonly string[] {
  return Object.entries(witnesses)
    .filter(([type, witness]) => witness.arm === 'gate-expectation' && !expected.has(type))
    .map(
      ([type]) =>
        `The gate-expectation witness for "${type}" promotes a type the expectation table no ` +
        'longer lists. The declaration outlived the row it cites — retire the promotion, or repoint it.',
    );
}

const EXPECTED_BY_SOME_PHASE: ReadonlySet<string> = new Set<string>(
  Object.values(PHASE_EXPECTED_EVENTS).flat(),
);

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
    for (const arm of DECLARED_ARMS) {
      const rows = DECLARED.filter((row) => row.arm === arm);
      expect(rows.length, `the ${arm} arm resolved no declaration at all`).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.event)).size).toBeGreaterThan(0);
    }

    // The liveness arm's population is the registry's by construction — one
    // START plus every TERMINAL per descriptor — so it is pinned to that sum
    // rather than to a literal floor, which a descriptor whose terminal list
    // emptied could have passed (the registry's own suite is what refuses an
    // empty terminal list; this only holds the arm to reading all of it).
    const liveness = DECLARED.filter((row) => row.arm === 'liveness-pair');
    expect(liveness.filter((row) => row.event.endsWith('.executing_started')).length).toBe(
      LIVENESS_DESCRIPTORS.length,
    );
    expect(liveness.length).toBe(
      LIVENESS_DESCRIPTORS.reduce((rows, descriptor) => rows + 1 + descriptor.terminalTypes.length, 0),
    );
  });

  it('ActionContractConjunct_GateExpectationWitness_IsNamedByTheLiveExpectationTable', () => {
    // The one witness arm no source scan can re-measure: the gate's read is an
    // iteration of a table, not a comparison against a literal. So it is
    // re-measured HERE, against the table itself — a witness whose expectation
    // row was deleted stops being evidence the moment the row goes.
    //
    // The arm may be EMPTY on the live table — it is, since `stack.submitted`
    // flipped — so the live check alone would be vacuous. The seeded row is
    // what keeps the auditor honest: a witness citing the arm for a type the
    // table does not list must be named, through the same function.
    expect(EXPECTED_BY_SOME_PHASE.size).toBeGreaterThan(0);
    expect(staleGateExpectationWitnesses(GOVERNANCE_WITNESSES, EXPECTED_BY_SOME_PHASE)).toEqual([]);

    const seededType = 'seeded.never-expected';
    expect(EXPECTED_BY_SOME_PHASE.has(seededType)).toBe(false);
    const seeded: Readonly<Record<string, AuthorityWitness>> = {
      ...GOVERNANCE_WITNESSES,
      [seededType]: {
        arm: 'gate-expectation',
        evidence: ['src/verbs/gates/check-event-emissions.ts'],
        because: 'A seeded witness whose row is gone.',
      },
    };
    const stale = staleGateExpectationWitnesses(seeded, EXPECTED_BY_SOME_PHASE);
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain(seededType);
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
    const seededSurface = 'liveness-registry.seeded';
    const seeded: readonly DeclaredEventName[] = [
      ...DECLARED,
      { site: seededSite, arm: 'emissions', event: telemetryType ?? '' },
      { site: seededPhase, arm: 'phase-expectation', event: telemetryType ?? '' },
      { site: seededSurface, arm: 'liveness-pair', event: telemetryType ?? '' },
    ];

    const findings = auditDeclaredEventNames(seeded, EVENT_AUTHORITY);
    expect(findings.length).toBe(3);
    expect(findings.join('\n')).toContain(seededSite);
    expect(findings.join('\n')).toContain(seededPhase);
    expect(findings.join('\n')).toContain(seededSurface);
    expect(findings.join('\n')).toContain(telemetryType ?? '');
  });

  it('ActionContractConjunct_ADemotedLivenessStart_WouldBeNamedBySite', () => {
    // The specific false demotion the decision record invited: file the launch
    // START claim as telemetry. It is governance on the live map; the probe
    // shows that, had it flipped, this arm names the descriptor that pairs on
    // it. The reader census would name the `worktrees@v1` reducer as well; this
    // arm is the one that also covers the merge and mutation START claims,
    // which no module reads raw.
    const launchStart = 'launch.executing_started';
    expect(classifyEventAuthority(launchStart)).toBe('governance');

    const flipped: Readonly<Record<string, EventAuthority>> = {
      ...EVENT_AUTHORITY,
      [launchStart]: 'telemetry',
    };
    const findings = auditDeclaredEventNames(DECLARED, flipped);
    expect(findings.some((finding) => finding.includes('liveness-registry.launch'))).toBe(true);
    expect(findings.every((finding) => finding.includes(launchStart))).toBe(true);
  });
});
