/**
 * Each event that a live declaration names must be a governance event.
 *
 * @oracle-sources: ../../src/registry/**, ../../src/events/partition/**,
 * ../../src/events/liveness-registry.ts,
 * ../../src/verbs/gates/check-event-emissions.ts
 *
 * The dispatcher verifies each `emissions` entry and each `event-append`
 * postcondition. A contract that names a telemetry event promises an event
 * that nothing depends on. Two more tables have the same shape: the
 * phase-expectation table of the emission gate, and the liveness registry.
 * The source-scan census cannot see either read, because the reader iterates
 * a table and does not compare against a literal.
 *
 * Most declared events are `auto` by tier, and the tier map alone makes them
 * governance. This check rules out a declaration that names a type outside
 * that tier, or a type that a charter demotion removed from it. Each finding
 * names its declaration site.
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
 * The declared population, read from `TOOL_REGISTRY` and the live tables and
 * not from a snapshot. It holds each event name that a built-in action
 * declares, in registry order. It also holds each event that the emission gate
 * expects from a phase, and each start and terminal type of a liveness
 * descriptor.
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
 * The check itself, as a pure function of a declared population and a
 * classification. The seeded probes and the live registry thus go through one
 * auditor.
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
 * The reverse of the gate-expectation arm. A witness that cites the
 * expectation table is evidence only while the table lists its type. The
 * function is pure, so the live table and a seeded stale row use one auditor.
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
  /**
   * Floors, not exact counts: an exact count makes each new action fail this
   * test. The floor applies to each arm, because a different accessor reads
   * each arm and each can return nothing. `contractEnsuredEventsOf` returns
   * `[]` on any failure, and its events are a subset of the emissions arm.
   *
   * The liveness arm must equal the registry sum: one start type plus each
   * terminal type of each descriptor. A literal floor passes when a terminal
   * list is empty.
   */
  it('ActionContractConjunct_DeclaredEventPopulation_IsNonEmptyOnEveryArm', () => {
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(new Set(DECLARED.map((row) => row.event)).size).toBeGreaterThan(10);
    expect(DECLARED.every((row) => row.site.includes('.'))).toBe(true);

    for (const arm of DECLARED_ARMS) {
      const rows = DECLARED.filter((row) => row.arm === arm);
      expect(rows.length, `the ${arm} arm resolved no declaration at all`).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.event)).size).toBeGreaterThan(0);
    }

    const liveness = DECLARED.filter((row) => row.arm === 'liveness-pair');
    expect(liveness.filter((row) => row.event.endsWith('.executing_started')).length).toBe(
      LIVENESS_DESCRIPTORS.length,
    );
    expect(liveness.length).toBe(
      LIVENESS_DESCRIPTORS.reduce((rows, descriptor) => rows + 1 + descriptor.terminalTypes.length, 0),
    );
  });

  /**
   * No source scan can measure the gate-expectation arm, because the gate
   * iterates a table. Thus this test measures the arm against the table. The
   * live witness table can hold no row for this arm, and then the live
   * assertion alone is vacuous. The seeded witness proves that the auditor
   * names a type that the table does not list.
   */
  it('ActionContractConjunct_GateExpectationWitness_IsNamedByTheLiveExpectationTable', () => {
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

  /**
   * Probes a false demotion: the launch start claim filed as telemetry. The
   * claim is governance on the live map. With the flipped map, this arm names
   * the liveness descriptor that pairs on the claim. This arm also covers the
   * merge and mutation start claims, which no module reads raw.
   */
  it('ActionContractConjunct_ADemotedLivenessStart_WouldBeNamedBySite', () => {
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
