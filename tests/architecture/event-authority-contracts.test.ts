/**
 * Every event an action contract names must be a governance event.
 *
 * @oracle-sources: ../../src/registry/**, ../../src/events/partition/**
 *
 * An `emissions` entry and an `event-append` postcondition are both promises
 * the dispatcher is held to: the emission is verified to have landed, the
 * postcondition is checked by re-reading the stream. A contract that named a
 * telemetry event would be promising something the partition says nothing
 * depends on — either the promise is enforced, in which case the event is
 * depended upon and the classification is wrong, or the classification is right
 * and the contract is declaring a promise nothing needs.
 *
 * This is an INDEPENDENT check rather than a restatement of the partition. The
 * whole declared population is `auto` by tier today, so it is green under the
 * tier map alone with no witness involved; what the conjunct rules out is a
 * future contract naming a type the tier does not cover.
 *
 * Both arms carry the declaring `tool.action`, so a failure names the
 * declaration site rather than only the event — a bare event name would leave a
 * reader grepping the whole registry for it.
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_REGISTRY,
  contractEmissionsOf,
  contractEnsuredEventsOf,
} from '../../src/registry.js';
import { EventTypes } from '../../src/events/schemas.js';
import {
  EVENT_AUTHORITY,
  TELEMETRY_EVENTS,
  classifyEventAuthority,
} from '../../src/events/partition/event-authority.js';
import type { EventAuthority } from '../../src/events/partition/authority.js';

/** One event name a contract declares, with the declaration site that named it. */
interface DeclaredEventName {
  readonly site: string;
  readonly arm: 'emissions' | 'ensures';
  readonly event: string;
}

/**
 * Every event name declared by any live built-in action, in registry order.
 *
 * Built by walking `TOOL_REGISTRY` rather than a snapshot, so an action added
 * without a snapshot refresh is still in the population.
 */
const DECLARED: readonly DeclaredEventName[] = TOOL_REGISTRY.flatMap((tool) =>
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
);

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
  it('ActionContractConjunct_DeclaredEventPopulation_IsNonEmpty', () => {
    // A floor, never the number: pinning the count would turn every new action
    // into a failure of this oracle instead of a check by it.
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(new Set(DECLARED.map((row) => row.event)).size).toBeGreaterThan(10);
    expect(DECLARED.filter((row) => row.arm === 'emissions').length).toBeGreaterThan(0);
    expect(DECLARED.every((row) => row.site.includes('.'))).toBe(true);
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
    const seeded: readonly DeclaredEventName[] = [
      ...DECLARED,
      { site: seededSite, arm: 'emissions', event: telemetryType ?? '' },
    ];

    const findings = auditDeclaredEventNames(seeded, EVENT_AUTHORITY);
    expect(findings.length).toBe(1);
    expect(findings.join('\n')).toContain(seededSite);
    expect(findings.join('\n')).toContain(telemetryType ?? '');
  });
});
