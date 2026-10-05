// Tests for the boot-time weld resolution gate in `src/events/registration-validate.ts`.
//
// @oracle-sources: ../../../src/contract/reachability/providers.ts, the tier and provider annotation measured from the emission sites
/**
 * The two oracles are independent. `providers.ts` holds the effect-provider map and knows nothing
 * about events. The annotations come from which code appends each event and which fold consumes it.
 * The expectations about the live catalog come from the live modules, so a renamed provider
 * changes the assertion.
 *
 * The second oracle is a label, not the path of `event-annotations.ts`. The derivation check walks
 * static imports, and that module reaches `providers.ts` through a type import. With two paths,
 * the check reports one authority, although a person writes the annotations from emission evidence.
 * `effect-ledger.ts` is no alternative path, because `providers.ts` imports it.
 *
 * The compile-time proofs are the `_RegistrationValidate_*` aliases in the source module.
 * `tsconfig.json` excludes test files, so a type assertion in this file proves nothing.
 */

import { describe, it, expect } from 'vitest';
import { MODULE_EMISSIONS, type ModuleEmission } from '../../../src/events/module-emissions.js';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EFFECT_PROVIDERS,
  type EffectProvider,
} from '../../../src/contract/reachability/providers.js';
import {
  EFFECT_OWNERSHIP,
  type EffectOwnershipRule,
} from '../../../src/architecture/effect-ledger.js';
import { EVENT_ANNOTATIONS } from '../../../src/events/event-annotations.js';
import { TOOL_REGISTRY, contractEmissionsOf } from '../../../src/registry.js';
import {
  EVENT_LIFECYCLES,
  EVENT_TIERS,
  weldReferenceOf,
  type EventLifecycle,
  type EventRegistration,
} from '../../../src/events/event-registration.js';
import {
  DIAGNOSTIC_SEVERITY_POLICY,
  EMISSION_DENOMINATOR_FLOOR,
  EMISSION_PROVIDER_MISMATCH_CODE,
  MULTI_PRIMARY_OWNER_CODE,
  PROVIDER_DISAGREEMENT_DISPOSITIONS,
  PROVIDER_REGISTRY_DRIFT_CODE,
  RegistrationWeldError,
  STALE_CAPABILITY_COVER_CODE,
  STALE_COVER_DISPOSITIONS,
  STALE_COVER_LIFECYCLE_POLICY,
  UNRESOLVABLE_PROVIDER_CODE,
  WELD_RESOLUTION_POLICY,
  ZERO_PRIMARY_OWNER_CODE,
  assertRegistrationWeldsAtStartup,
  auditDisagreementDispositions,
  auditStaleCoverDispositions,
  type StaleCoverDisposition,
  bootResolvedWelds,
  declaredEmissionEdges,
  reportedDisagreements,
  reportedStaleCover,
  resolvableProviderIds,
  staleCoverEligibleWelds,
  validateRegistrationWelds,
  type EmissionEdge,
  type StaleCoverEligibility,
  type WeldDiagnosticCode,
  type WeldDiagnosticSeverity,
  type WeldResolutionVerdict,
} from '../../../src/events/registration-validate.js';

/**
 * The path of the pinned stale-cover eligible count. A person writes the file, and no code computes
 * it. `resolveJsonModule` is off, so the test reads the file with `fs` and does not import it.
 */
const EMISSION_ELIGIBLE_BASELINE_PATH = fileURLToPath(
  new URL('../../support/emission-eligible-baseline.json', import.meta.url),
);

/** A type guard for the shape of the baseline file. */
function isEligibleBaseline(value: unknown): value is { eligibleCount: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'eligibleCount' in value &&
    typeof (value as { eligibleCount: unknown }).eligibleCount === 'number'
  );
}

/**
 * Read the pinned baseline from disk. No code in this file writes the baseline file.
 * A run that writes its own baseline before the comparison always agrees with itself.
 */
function readEligibleBaseline(): { eligibleCount: number } {
  const raw = fs.readFileSync(EMISSION_ELIGIBLE_BASELINE_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isEligibleBaseline(parsed)) {
    throw new Error(`malformed eligible-count baseline at ${EMISSION_ELIGIBLE_BASELINE_PATH}`);
  }
  return parsed;
}

/** The live catalog with extra entries merged in. The seeded tests use it. */
function catalogWith(
  overrides: Readonly<Record<string, EventRegistration>>,
): Readonly<Record<string, EventRegistration>> {
  return { ...EVENT_ANNOTATIONS, ...overrides };
}

/**
 * A `capability` registration that names `provider`. Each other field is fixed and valid, so the
 * only variable is whether the provider id resolves.
 */
function capabilityNaming(provider: string): EventRegistration {
  return {
    lifecycle: 'active',
    tier: 'capability',
    provider,
    consumedBy: ['workflow-state@v1'],
  };
}

/** The event types of the live capability registrations, sorted. */
function liveCapabilityTypes(): string[] {
  return Object.entries(EVENT_ANNOTATIONS)
    .filter(([, registration]) => registration.tier === 'capability')
    .map(([eventType]) => eventType)
    .sort();
}

/**
 * Each capability registration in a catalog as `(eventType, provider, lifecycle)`, sorted by event
 * type. The catalog is a parameter, so the same function reads a seeded catalog and the live one.
 */
function capabilityRegistrationsIn(
  annotations: Readonly<Record<string, EventRegistration>>,
): { eventType: string; provider: string; lifecycle: EventLifecycle }[] {
  const rows: { eventType: string; provider: string; lifecycle: EventLifecycle }[] = [];
  for (const [eventType, registration] of Object.entries(annotations)) {
    if (registration.tier !== 'capability') continue;
    rows.push({ eventType, provider: registration.provider, lifecycle: registration.lifecycle });
  }
  return rows.sort((a, b) => (a.eventType < b.eventType ? -1 : a.eventType > b.eventType ? 1 : 0));
}

/** Each live capability registration, read from the catalog. */
function liveCapabilityRegistrations(): { eventType: string; provider: string }[] {
  return capabilityRegistrationsIn(EVENT_ANNOTATIONS);
}

/**
 * An emission population that agrees with a catalog: one primary edge for each capability
 * registration, declared on the tool that the registration names.
 *
 * The edges come from the annotation table, so they stay conforming when the catalog changes.
 * The catalog is a parameter. An edge set from the live table leaves a seeded event with no edge.
 * That adds a stale-cover finding to a verdict that must isolate one fault.
 */
function conformingEmissionEdgesFor(
  annotations: Readonly<Record<string, EventRegistration>>,
): readonly EmissionEdge[] {
  return capabilityRegistrationsIn(annotations).map(({ eventType, provider }) => ({
    event: eventType,
    action: `${eventType}-emitter`,
    declaringTool: provider,
    role: 'primary' as const,
    owner: provider.startsWith('exarchos_') ? provider.slice('exarchos_'.length) : provider,
  }));
}

const CONFORMING_EMISSIONS = conformingEmissionEdgesFor(EVENT_ANNOTATIONS);

/**
 * One emission edge that disagrees: a live capability event, declared on a composite tool that is
 * not the provider of its registration. The event and the provider come from the annotation table,
 * and the tool comes from the effect-provider map. The function throws when the catalog can supply
 * no such edge, so a seed cannot become empty silently.
 */
function disagreeingEmissionEdge(): EmissionEdge {
  for (const { eventType, provider } of liveCapabilityRegistrations()) {
    const other = EFFECT_PROVIDERS.map((p) => p.tool).find((tool) => tool !== provider);
    if (other === undefined) continue;
    return { event: eventType, action: 'seeded_emitter', declaringTool: other };
  }
  throw new Error('no live capability registration can seed a provider disagreement');
}

/** A provider entry that no ledger rule backs. It makes the drift diagnostic fire. */
const GHOST_PROVIDER: EffectProvider = {
  tool: 'exarchos_ghost',
  area: 'ghost/',
  owner: 'ghost-fs',
  effectClass: 'filesystem',
};

/**
 * One input that makes one named diagnostic fire, with each other population live or conforming.
 * The seeds cover each code that the gate can emit, so the severity tests range over all codes.
 */
interface DiagnosticSeed {
  readonly code: WeldDiagnosticCode;
  readonly annotations: Readonly<Record<string, EventRegistration>>;
  readonly providers: readonly EffectProvider[];
  readonly rules: readonly EffectOwnershipRule[];
  readonly emissions: readonly EmissionEdge[];
  readonly primaryOwnerEmissions?: readonly EmissionEdge[];
}

/**
 * The catalog of the unresolvable-provider seed: the live table plus one event.
 * It has a name so that its conforming emission population can come from it.
 */
const UNRESOLVABLE_SEED_CATALOG = catalogWith({
  'seeded.severity-unresolvable': capabilityNaming('exarchos_no_such_provider'),
});

/**
 * A catalog where each capability registration is `retired`, and only the lifecycle field changes.
 * The welds remain and the stale-cover population is empty. The catalog thus reaches the
 * stale-cover vacuity guard and not the capability guard.
 */
function everyCapabilityRetired(): Readonly<Record<string, EventRegistration>> {
  const retired: Record<string, EventRegistration> = {};
  for (const [eventType, registration] of Object.entries(EVENT_ANNOTATIONS)) {
    retired[eventType] =
      registration.tier === 'capability' ? { ...registration, lifecycle: 'retired' } : registration;
  }
  return retired;
}

/**
 * The first active capability event of the live table, in event order. The stale-cover seeds
 * remove its edge. The function reads the table, so a re-tiering or a retirement moves the subject.
 * It throws when no active registration exists, so the seed cannot become empty silently.
 */
function firstActiveCapabilityEvent(): string {
  const active = capabilityRegistrationsIn(EVENT_ANNOTATIONS).find(
    (row) => row.lifecycle === 'active',
  );
  if (active === undefined) throw new Error('no active capability registration to seed stale cover');
  return active.eventType;
}

const STALE_COVER_SEED_EVENT = firstActiveCapabilityEvent();

/** The conforming population without the edge of {@link STALE_COVER_SEED_EVENT}. */
const CONFORMING_EMISSIONS_MINUS_ONE = CONFORMING_EMISSIONS.filter(
  (edge) => edge.event !== STALE_COVER_SEED_EVENT,
);

/**
 * One seed for each diagnostic code. Each seed changes one population and holds the others at a
 * value that reports nothing. Each seed carries an explicit emission population for that reason.
 */
const DIAGNOSTIC_SEEDS: readonly DiagnosticSeed[] = [
  {
    code: UNRESOLVABLE_PROVIDER_CODE,
    annotations: UNRESOLVABLE_SEED_CATALOG,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    /**
     * The edges come from the seeded catalog, so an edge names the added event.
     * Only the provider is at fault.
     */
    emissions: conformingEmissionEdgesFor(UNRESOLVABLE_SEED_CATALOG),
  },
  {
    code: PROVIDER_REGISTRY_DRIFT_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: [...EFFECT_PROVIDERS, GHOST_PROVIDER],
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
  },
  {
    code: 'EMPTY_CAPABILITY_DENOMINATOR',
    annotations: {},
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
  },
  {
    code: 'EMPTY_PROVIDER_REGISTRY',
    annotations: EVENT_ANNOTATIONS,
    providers: [],
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
  },
  {
    code: EMISSION_PROVIDER_MISMATCH_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: [...CONFORMING_EMISSIONS, disagreeingEmissionEdge()],
  },
  /**
   * Boot-resolvable events exist, and no edge names any of them.
   * `EMPTY_CAPABILITY_DENOMINATOR` is the case where the events are absent.
   */
  {
    code: 'EMPTY_EMISSION_DENOMINATOR',
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: [],
  },
  /**
   * The set holds one conforming edge. It is not empty and no edge disagrees, so only its size is
   * wrong: it is below the floor.
   */
  {
    code: 'NARROWED_EMISSION_DENOMINATOR',
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS.slice(0, 1),
  },
  /**
   * One active capability event loses its edge. The weld resolves and the other edges agree, so
   * the only fault is that no edge names the event.
   */
  {
    code: STALE_CAPABILITY_COVER_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS_MINUS_ONE,
  },
  /** Each weld is present and `retired`, so only the stale-cover population is empty. */
  {
    code: 'EMPTY_STALE_COVER_DENOMINATOR',
    annotations: everyCapabilityRetired(),
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
  },
  {
    code: 'EMPTY_PRIMARY_OWNER_DENOMINATOR',
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
    primaryOwnerEmissions: [],
  },
  {
    code: 'NARROWED_PRIMARY_OWNER_DENOMINATOR',
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
    primaryOwnerEmissions: declaredEmissionEdges().slice(0, 1),
  },
  {
    code: ZERO_PRIMARY_OWNER_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
    primaryOwnerEmissions: [
      ...declaredEmissionEdges(),
      {
        event: 'seeded.zero-primary',
        action: 'recovery-only',
        declaringTool: 'exarchos_orchestrate',
        role: 'recovery',
        owner: 'orchestrate',
      },
    ],
  },
  {
    code: MULTI_PRIMARY_OWNER_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
    primaryOwnerEmissions: [
      ...declaredEmissionEdges(),
      {
        event: 'seeded.multi-primary',
        action: 'orchestrate-claims',
        declaringTool: 'exarchos_orchestrate',
        role: 'primary',
        owner: 'orchestrate',
      },
      {
        event: 'seeded.multi-primary',
        action: 'workflow-claims',
        declaringTool: 'exarchos_workflow',
        role: 'primary',
        owner: 'workflow',
      },
    ],
  },
];

/** A type guard that narrows an object key to a diagnostic code of the shipped table. */
function isWeldDiagnosticCode(value: string): value is WeldDiagnosticCode {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SEVERITY_POLICY, value);
}

/**
 * The live severity table with each row set to `severity`. The table starts as a spread of the
 * shipped table, so its type stays total over the diagnostic codes when a code is added.
 */
function everyDiagnosticAt(
  severity: WeldDiagnosticSeverity,
): Readonly<Record<WeldDiagnosticCode, WeldDiagnosticSeverity>> {
  const table: Record<WeldDiagnosticCode, WeldDiagnosticSeverity> = {
    ...DIAGNOSTIC_SEVERITY_POLICY,
  };
  for (const code of Object.keys(table)) {
    if (isWeldDiagnosticCode(code)) table[code] = severity;
  }
  return table;
}

describe('RegistrationValidate — the DR-2 boot-time weld resolution gate', () => {
  /**
   * The shipped catalog is `ok`, which is stronger than `bootable`. The seeded tests show the
   * difference between the two flags.
   * The weld, provider and edge counts equal counts that the test derives from the live modules,
   * and no count is zero. A gate over zero welds, zero providers or zero edges gives the same
   * verdict shape. The compared set is a strict subset of the declared edges, because some edges
   * name events of a tier that this gate does not resolve. The report reads as clean and carries
   * the weld, provider and compared-edge counts.
   */
  it('RegistrationWelds_LiveCatalog_ResolvesAgainstNonEmptyPopulations', () => {
    const verdict = validateRegistrationWelds();

    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);
    expect(verdict.observeCount).toBe(0);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.ok).toBe(true);

    const capabilityTypes = liveCapabilityTypes();
    expect(capabilityTypes.length).toBeGreaterThan(0);
    expect(verdict.bootResolvedCount).toBe(capabilityTypes.length);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBe(resolvableProviderIds().length);
    expect(verdict.emissionEdgeCount).toBe(declaredEmissionEdges().length);
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThan(0);
    expect(verdict.comparedEmissionEdgeCount).toBeLessThan(verdict.emissionEdgeCount);

    expect(bootResolvedWelds().map((w) => w.eventType)).toEqual(capabilityTypes);

    const liveTools = new Set(EFFECT_PROVIDERS.map((p) => p.tool));
    const namedTools = new Set(bootResolvedWelds().map((w) => w.ref));
    expect([...namedTools].filter((tool) => !liveTools.has(tool))).toEqual([]);
    expect(namedTools.size).toBeGreaterThan(0);

    expect(verdict.report).toContain('event registration welds OK');
    expect(verdict.report).not.toContain('observe-only');
    expect(verdict.report).not.toContain('FAILED');
    expect(verdict.report).toContain(`${verdict.bootResolvedCount} boot-resolved weld(s)`);
    expect(verdict.report).toContain(`${verdict.resolvableProviderCount} live provider(s)`);
    expect(verdict.report).toContain(
      `${verdict.comparedEmissionEdgeCount} compared emission edge(s)`,
    );
  });

  /**
   * The seed is a valid `capability` registration whose provider names nothing. The union cannot
   * reject it, because `EffectProviderId` is `string`, so reference integrity must fail at boot.
   * The message names the id and the resolvable set. Both counts stay correct, so the fault is the
   * weld and not a population. The gate throws, and the error carries the verdict.
   */
  it('RegistrationWelds_SeededUnresolvableProvider_FailsTheGate', () => {
    const seededType = 'seeded.unresolvable-provider';
    const seededProvider = 'exarchos_no_such_provider';
    const seeded = catalogWith({ [seededType]: capabilityNaming(seededProvider) });

    const verdict = validateRegistrationWelds(seeded);
    expect(verdict.ok).toBe(false);

    const unresolvable = verdict.diagnostics.filter(
      (d) => d.code === UNRESOLVABLE_PROVIDER_CODE,
    );
    expect(unresolvable.map((d) => d.eventType)).toEqual([seededType]);
    expect(unresolvable[0]?.provider).toBe(seededProvider);
    expect(unresolvable[0]?.message).toContain(seededProvider);
    for (const id of resolvableProviderIds()) {
      expect(unresolvable[0]?.message).toContain(id);
    }

    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length + 1);
    expect(verdict.resolvableProviderCount).toBe(resolvableProviderIds().length);

    expect(() => assertRegistrationWeldsAtStartup(seeded)).toThrow(RegistrationWeldError);
    try {
      assertRegistrationWeldsAtStartup(seeded);
      expect.unreachable('the gate must throw on a seeded unresolvable provider');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistrationWeldError);
      if (err instanceof RegistrationWeldError) {
        expect(err.verdict.diagnostics.map((d) => d.code)).toContain(UNRESOLVABLE_PROVIDER_CODE);
        expect(err.message).toContain(seededType);
      }
    }
  });

  /**
   * The property is "names a live effect provider". Membership in the `EFFECT_PROVIDERS` array is
   * only a proxy for it. `exarchos_ghost` is in the array, and no `EFFECT_OWNERSHIP` rule backs it.
   * The gate reads the property, so the id does not resolve and the gate reports the drift as the
   * cause. The other providers still resolve.
   */
  it('RegistrationWelds_ProviderThatOnlyLooksLive_StillFails', () => {
    const ghost: EffectProvider = {
      tool: 'exarchos_ghost',
      area: 'ghost/',
      owner: 'ghost-fs',
      effectClass: 'filesystem',
    };
    const providers = [...EFFECT_PROVIDERS, ghost];

    expect(providers.filter((p) => p.tool === ghost.tool).length).toBe(1);
    expect(resolvableProviderIds(providers).filter((id) => id === ghost.tool)).toEqual([]);
    expect(resolvableProviderIds(providers)).toEqual(resolvableProviderIds());

    const seeded = catalogWith({ 'seeded.ghost-weld': capabilityNaming(ghost.tool) });
    const verdict = validateRegistrationWelds(seeded, providers);
    expect(verdict.ok).toBe(false);

    const codes = verdict.diagnostics.map((d) => d.code);
    expect(codes).toContain(UNRESOLVABLE_PROVIDER_CODE);
    expect(codes).toContain(PROVIDER_REGISTRY_DRIFT_CODE);
    const drift = verdict.diagnostics.filter((d) => d.code === PROVIDER_REGISTRY_DRIFT_CODE);
    expect(drift.map((d) => d.provider)).toEqual([ghost.tool]);
  });

  /**
   * The catalog keeps each registration that is not `capability`, so it has zero boot-resolvable
   * welds. A check over an empty subject set cannot fail, so the gate must not report clean.
   * The provider registry is intact, and `EMPTY_PROVIDER_REGISTRY` does not fire. An empty catalog
   * fails in the same way.
   */
  it('RegistrationWelds_EmptyCapabilityPopulation_FailsInsteadOfPassingClean', () => {
    const withoutCapabilities: Record<string, EventRegistration> = {};
    for (const [eventType, registration] of Object.entries(EVENT_ANNOTATIONS)) {
      if (registration.tier === 'capability') continue;
      withoutCapabilities[eventType] = registration;
    }
    expect(Object.keys(withoutCapabilities).length).toBeGreaterThan(0);

    const verdict = validateRegistrationWelds(withoutCapabilities);
    expect(verdict.ok).toBe(false);
    expect(verdict.bootResolvedCount).toBe(0);
    expect(verdict.diagnostics.map((d) => d.code)).toContain('EMPTY_CAPABILITY_DENOMINATOR');
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.diagnostics.map((d) => d.code)).not.toContain('EMPTY_PROVIDER_REGISTRY');

    expect(validateRegistrationWelds({}).diagnostics.map((d) => d.code)).toContain(
      'EMPTY_CAPABILITY_DENOMINATOR',
    );
  });

  /**
   * An empty `EFFECT_PROVIDERS` gives the `EMPTY_PROVIDER_REGISTRY` fault, which names the registry
   * as the cause. The subject count does not change.
   * A ledger with no rules gives the same fault: the array is full and no id resolves.
   */
  it('RegistrationWelds_EmptyProviderRegistry_FailsInsteadOfPassingClean', () => {
    const verdict = validateRegistrationWelds(EVENT_ANNOTATIONS, []);
    expect(verdict.ok).toBe(false);
    expect(verdict.resolvableProviderCount).toBe(0);
    expect(verdict.diagnostics.map((d) => d.code)).toContain('EMPTY_PROVIDER_REGISTRY');
    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length);

    const unbacked = validateRegistrationWelds(EVENT_ANNOTATIONS, EFFECT_PROVIDERS, []);
    expect(unbacked.resolvableProviderCount).toBe(0);
    expect(unbacked.diagnostics.map((d) => d.code)).toContain('EMPTY_PROVIDER_REGISTRY');
  });

  /**
   * The gate reads the policy as data. Each tier of `EVENT_TIERS` has a resolution decision, and
   * only `capability` resolves at boot. Each tier carries a note that states the reason.
   * The ref that the gate resolves is the one from `weldReferenceOf`. No type proves that the
   * capability arm returns `provider`, so the test checks each live capability registration.
   */
  it('RegistrationWelds_PolicyTable_IsTotalAndNamesOneBootAuthority', () => {
    expect(Object.keys(WELD_RESOLUTION_POLICY).sort()).toEqual([...EVENT_TIERS].sort());

    const bootTiers = EVENT_TIERS.filter(
      (tier) => WELD_RESOLUTION_POLICY[tier].resolvedAt === 'boot',
    );
    expect(bootTiers).toEqual(['capability']);
    const capabilityPolicy = WELD_RESOLUTION_POLICY.capability;
    expect(capabilityPolicy.resolvedAt).toBe('boot');
    if (capabilityPolicy.resolvedAt === 'boot') {
      expect(capabilityPolicy.authority).toBe('effect-provider-registry');
    }

    for (const tier of EVENT_TIERS) {
      expect(WELD_RESOLUTION_POLICY[tier].note.length).toBeGreaterThan(0);
    }

    const capabilityTypes = liveCapabilityTypes();
    expect(capabilityTypes.length).toBeGreaterThan(0);
    for (const eventType of capabilityTypes) {
      const registration = EVENT_ANNOTATIONS[eventType];
      expect(registration).toBeDefined();
      if (registration === undefined || registration.tier !== 'capability') continue;
      expect(weldReferenceOf(registration).ref).toBe(registration.provider);
    }
  });

  /**
   * An id resolves only when one backed entry claims it. Two entries for the same tool make the
   * id ambiguous, so it does not resolve, and each other id is unchanged.
   * The resolution set comes from the two live modules.
   */
  it('RegistrationWelds_ResolvableIds_RequireExactlyOneBackedProviderEntry', () => {
    const first = EFFECT_PROVIDERS[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(resolvableProviderIds()).toContain(first.tool);
    const duplicated = resolvableProviderIds([...EFFECT_PROVIDERS, first]);
    expect(duplicated).not.toContain(first.tool);
    expect(duplicated).toEqual(resolvableProviderIds().filter((id) => id !== first.tool));

    expect(resolvableProviderIds()).toEqual(
      [...new Set(EFFECT_PROVIDERS.map((p) => p.tool))].sort(),
    );
    expect(EFFECT_OWNERSHIP.length).toBeGreaterThan(0);
  });
});

describe('StartupAssertion — the severity axis on the boot refusal', () => {
  /**
   * Pins the severity of each code as two exact sets. The catalog faults block. The codes in the
   * `observe` set report a collapse in the reach of the gate, so the tree still boots.
   * The seeds cover each shipped code. For each blocking seed, the diagnostic is `blocking`, the
   * verdict is not bootable, and the gate throws without a report.
   * The module emissions are empty, so a shipped row cannot cover the stale-cover seed.
   */
  it('StartupAssertion_BlockingSeverity_ThrowsOnAnyViolation', () => {
    const shipped = Object.entries(DIAGNOSTIC_SEVERITY_POLICY);
    const shippedCodes = shipped.map(([code]) => code);
    const codesAt = (severity: WeldDiagnosticSeverity): string[] =>
      shipped.filter(([, s]) => s === severity).map(([code]) => code).sort();

    expect(codesAt('blocking')).toEqual(
      [
        UNRESOLVABLE_PROVIDER_CODE,
        PROVIDER_REGISTRY_DRIFT_CODE,
        'EMPTY_CAPABILITY_DENOMINATOR',
        'EMPTY_PROVIDER_REGISTRY',
        EMISSION_PROVIDER_MISMATCH_CODE,
        STALE_CAPABILITY_COVER_CODE,
        ZERO_PRIMARY_OWNER_CODE,
        MULTI_PRIMARY_OWNER_CODE,
      ].sort(),
    );
    expect(codesAt('observe')).toEqual(
      [
        'EMPTY_EMISSION_DENOMINATOR',
        'NARROWED_EMISSION_DENOMINATOR',
        'EMPTY_STALE_COVER_DENOMINATOR',
        'EMPTY_PRIMARY_OWNER_DENOMINATOR',
        'NARROWED_PRIMARY_OWNER_DENOMINATOR',
      ].sort(),
    );

    expect(DIAGNOSTIC_SEEDS.map((s) => s.code).sort()).toEqual([...shippedCodes].sort());

    const blockingSeeds = DIAGNOSTIC_SEEDS.filter(
      (seed) => DIAGNOSTIC_SEVERITY_POLICY[seed.code] === 'blocking',
    );
    expect(blockingSeeds.map((s) => s.code).sort()).toEqual(codesAt('blocking'));

    for (const seed of blockingSeeds) {
      const verdict = validateRegistrationWelds(
        seed.annotations,
        seed.providers,
        seed.rules,
        WELD_RESOLUTION_POLICY,
        DIAGNOSTIC_SEVERITY_POLICY,
        seed.emissions,
        STALE_COVER_LIFECYCLE_POLICY,
        [],
        seed.primaryOwnerEmissions ?? declaredEmissionEdges(),
      );
      const matching = verdict.diagnostics.filter((d) => d.code === seed.code);
      expect(matching.length).toBeGreaterThan(0);
      for (const diagnostic of matching) expect(diagnostic.severity).toBe('blocking');
      expect(verdict.ok).toBe(false);
      expect(verdict.bootable).toBe(false);
      expect(verdict.blockingCount).toBe(verdict.diagnostics.length);
      expect(verdict.observeCount).toBe(0);
      expect(verdict.report).toContain('event registration weld resolution FAILED');
      expect(verdict.report).toContain(`${verdict.blockingCount} fault(s)`);
      expect(verdict.report).not.toContain('observe-only');

      const reported: string[] = [];
      expect(() =>
        assertRegistrationWeldsAtStartup(
          seed.annotations,
          seed.providers,
          seed.rules,
          WELD_RESOLUTION_POLICY,
          DIAGNOSTIC_SEVERITY_POLICY,
          (message) => reported.push(message),
          seed.emissions,
          STALE_COVER_LIFECYCLE_POLICY,
          [],
          seed.primaryOwnerEmissions ?? declaredEmissionEdges(),
        ),
      ).toThrow(RegistrationWeldError);
      expect(reported).toEqual([]);
    }
  });

  it('PrimaryOwnerBijection_SameOwnerDuplicateEdges_DoesNotReportMultiPrimary', () => {
    const verdict = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      CONFORMING_EMISSIONS,
      STALE_COVER_LIFECYCLE_POLICY,
      [],
      [
        ...declaredEmissionEdges(),
        {
          event: 'seeded.same-owner-dup',
          action: 'first-claim',
          declaringTool: 'exarchos_orchestrate',
          role: 'primary',
          owner: 'orchestrate',
        },
        {
          event: 'seeded.same-owner-dup',
          action: 'second-claim',
          declaringTool: 'exarchos_workflow',
          role: 'primary',
          owner: 'orchestrate',
        },
      ],
    );

    expect(verdict.diagnostics.filter((d) => d.code === MULTI_PRIMARY_OWNER_CODE)).toEqual([]);
  });

  /**
   * The test runs all the seeds with each code at `observe`. The gate returns and reports one
   * time, and the report holds the code and the counts. `ok` stays false, because an observation
   * is a finding.
   * Together with the blocking test, this shows that only the severity table decides the refusal.
   * The module emissions are empty, so a shipped row cannot cover a seed.
   */
  it('StartupAssertion_ObserveSeverity_ReportsWithoutThrowing', () => {
    const observeEverything = everyDiagnosticAt('observe');

    for (const seed of DIAGNOSTIC_SEEDS) {
      const reported: string[] = [];
      const verdict = assertRegistrationWeldsAtStartup(
        seed.annotations,
        seed.providers,
        seed.rules,
        WELD_RESOLUTION_POLICY,
        observeEverything,
        (message) => reported.push(message),
        seed.emissions,
        STALE_COVER_LIFECYCLE_POLICY,
        [],
        seed.primaryOwnerEmissions ?? declaredEmissionEdges(),
      );

      const matching = verdict.diagnostics.filter((d) => d.code === seed.code);
      expect(matching.length).toBeGreaterThan(0);
      for (const diagnostic of matching) expect(diagnostic.severity).toBe('observe');
      expect(verdict.bootable).toBe(true);
      expect(verdict.blockingCount).toBe(0);
      expect(verdict.observeCount).toBe(verdict.diagnostics.length);

      expect(verdict.ok).toBe(false);

      expect(reported).toHaveLength(1);
      const message = reported[0] ?? '';
      expect(message).toBe(verdict.report);
      expect(message).toContain('observe-only');
      expect(message).toContain(`${verdict.observeCount} finding(s)`);
      expect(message).toContain(seed.code);
      expect(message).not.toContain('FAILED');
      expect(message).toContain(`${verdict.bootResolvedCount} boot-resolved weld(s)`);
      expect(message).toContain(`${verdict.resolvableProviderCount} live provider(s)`);
    }
  });

  /**
   * The control for the test above. With each code at `observe`, a gate that always reports also
   * does not throw, so a clean tree must give no report.
   * The input is the live catalog with a conforming emission population. The counts are above zero.
   */
  it('StartupAssertion_ObserveSeverity_StaysSilentOnACleanTree', () => {
    const reported: string[] = [];
    const verdict = assertRegistrationWeldsAtStartup(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      everyDiagnosticAt('observe'),
      (message) => reported.push(message),
      CONFORMING_EMISSIONS,
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.bootable).toBe(true);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.observeCount).toBe(0);
    expect(reported).toEqual([]);
    expect(verdict.bootResolvedCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThan(0);
  });

  /**
   * One verdict with a fault of each severity. `bootable` follows the blocking fault, and the
   * report still names the observation.
   */
  it('StartupAssertion_MixedSeverities_RefusesOnTheBlockingOneAndStillNamesTheObservation', () => {
    const seeded = catalogWith({
      'seeded.severity-mixed': capabilityNaming('exarchos_no_such_provider'),
    });
    const mixed: Readonly<Record<WeldDiagnosticCode, WeldDiagnosticSeverity>> = {
      ...everyDiagnosticAt('observe'),
      [UNRESOLVABLE_PROVIDER_CODE]: 'blocking',
    };
    const providers = [...EFFECT_PROVIDERS, GHOST_PROVIDER];

    const verdict = validateRegistrationWelds(
      seeded,
      providers,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      mixed,
    );
    expect(verdict.blockingCount).toBeGreaterThan(0);
    expect(verdict.observeCount).toBeGreaterThan(0);
    expect(verdict.bootable).toBe(false);
    expect(verdict.report).toContain('event registration weld resolution FAILED');
    expect(verdict.report).toContain(UNRESOLVABLE_PROVIDER_CODE);
    expect(verdict.report).toContain('observe-only');
    expect(verdict.report).toContain(PROVIDER_REGISTRY_DRIFT_CODE);

    expect(() =>
      assertRegistrationWeldsAtStartup(
        seeded,
        providers,
        EFFECT_OWNERSHIP,
        WELD_RESOLUTION_POLICY,
        mixed,
      ),
    ).toThrow(RegistrationWeldError);
  });
});

describe('ProviderComparison — the declaring tool against the declared provider', () => {
  /**
   * The first half uses the live registry. The test computes the agreeing edges from the
   * annotation table and the declared edges, not from the diagnostics of the gate. The agreeing set
   * is not empty, and no agreeing edge has a mismatch diagnostic.
   * The second half is the control: a conforming emission population gives no diagnostic, over a
   * compared set of the same size as the capability tier.
   */
  it('ProviderComparison_DeclaringToolMatchesProvider_IsConforming', () => {
    const declaredProviderByEvent = new Map(
      liveCapabilityRegistrations().map((row) => [row.eventType, row.provider]),
    );
    const comparedEdges = declaredEmissionEdges().filter((edge) =>
      declaredProviderByEvent.has(edge.event),
    );
    const agreeing = comparedEdges.filter(
      (edge) => declaredProviderByEvent.get(edge.event) === edge.declaringTool,
    );
    expect(comparedEdges.length).toBeGreaterThan(0);
    expect(agreeing.length).toBeGreaterThan(0);

    const live = validateRegistrationWelds();
    const faulted = new Set(
      live.diagnostics
        .filter((d) => d.code === EMISSION_PROVIDER_MISMATCH_CODE)
        .map((d) => ('action' in d ? `${d.eventType}|${d.action}` : '')),
    );
    for (const edge of agreeing) {
      expect(faulted.has(`${edge.event}|${edge.action}`)).toBe(false);
    }

    const conforming = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      CONFORMING_EMISSIONS,
    );
    expect(conforming.diagnostics).toEqual([]);
    expect(conforming.ok).toBe(true);
    expect(conforming.bootable).toBe(true);
    expect(conforming.comparedEmissionEdgeCount).toBe(CONFORMING_EMISSIONS.length);
    expect(conforming.comparedEmissionEdgeCount).toBe(liveCapabilityTypes().length);
  });

  /**
   * One seeded disagreement over a conforming population, so the one mismatch belongs to that edge.
   * The record and the message both carry the event, the declared provider, the declaring tool and
   * the action. The severity comes from the shipped table and is `blocking`.
   * The startup assertion throws, and the report sink stays empty.
   */
  it('ProviderComparison_Disagreement_NamesBothSides', () => {
    const edge = disagreeingEmissionEdge();
    const declaredProvider = new Map(
      liveCapabilityRegistrations().map((row) => [row.eventType, row.provider]),
    ).get(edge.event);
    expect(declaredProvider).toBeDefined();
    expect(edge.declaringTool).not.toBe(declaredProvider);

    const verdict = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [...CONFORMING_EMISSIONS, edge],
    );

    const mismatches = verdict.diagnostics.filter(
      (d) => d.code === EMISSION_PROVIDER_MISMATCH_CODE,
    );
    expect(mismatches).toHaveLength(1);
    const mismatch = mismatches[0];
    expect(mismatch).toBeDefined();
    if (mismatch === undefined || mismatch.code !== EMISSION_PROVIDER_MISMATCH_CODE) return;

    expect(mismatch.eventType).toBe(edge.event);
    expect(mismatch.provider).toBe(declaredProvider);
    expect(mismatch.declaringTool).toBe(edge.declaringTool);
    expect(mismatch.action).toBe(edge.action);
    expect(mismatch.declaringTool).not.toBe(mismatch.provider);

    expect(mismatch.message).toContain(edge.event);
    expect(mismatch.message).toContain(edge.action);
    expect(mismatch.message).toContain(edge.declaringTool);
    expect(mismatch.message).toContain(declaredProvider ?? '<undeclared>');

    expect(mismatch.severity).toBe('blocking');
    expect(DIAGNOSTIC_SEVERITY_POLICY[EMISSION_PROVIDER_MISMATCH_CODE]).toBe('blocking');
    expect(verdict.bootable).toBe(false);
    expect(verdict.blockingCount).toBe(1);
    expect(verdict.ok).toBe(false);

    const reported: string[] = [];
    let caught: unknown;
    try {
      assertRegistrationWeldsAtStartup(
        EVENT_ANNOTATIONS,
        EFFECT_PROVIDERS,
        EFFECT_OWNERSHIP,
        WELD_RESOLUTION_POLICY,
        DIAGNOSTIC_SEVERITY_POLICY,
        (message) => reported.push(message),
        [...CONFORMING_EMISSIONS, edge],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistrationWeldError);
    if (!(caught instanceof RegistrationWeldError)) return;
    expect(caught.verdict.bootable).toBe(false);
    const message = caught.verdict.report;
    expect(message).toContain(edge.event);
    expect(message).toContain(edge.action);
    expect(message).toContain(edge.declaringTool);
    expect(message).toContain(declaredProvider ?? '<undeclared>');
    expect(reported).toEqual([]);
  });

  /**
   * The welds and the provider map are intact, and no declared edge names a boot-resolvable event.
   * The comparison ranges over nothing, so the gate must not report clean. The module emissions and
   * the primary-owner edges are also empty, so "nothing emits these events" is true. Each eligible
   * weld then has no edge, so the verdict also holds one stale-cover finding for each. A population
   * that names only events outside the catalog fails in the same way. With no subjects, the gate
   * reports only `EMPTY_CAPABILITY_DENOMINATOR`.
   */
  it('ProviderComparison_NothingEmitsABootResolvableEvent_FailsInsteadOfPassingClean', () => {
    const verdict = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [],
      STALE_COVER_LIFECYCLE_POLICY,
      [],
      [],
    );
    expect(verdict.comparedEmissionEdgeCount).toBe(0);
    expect(verdict.ok).toBe(false);
    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);

    const emptyCodes = verdict.diagnostics
      .map((d) => d.code)
      .filter((code) => code.startsWith('EMPTY_') || code === 'NARROWED_EMISSION_DENOMINATOR');
    expect(emptyCodes).toEqual(['EMPTY_EMISSION_DENOMINATOR', 'EMPTY_PRIMARY_OWNER_DENOMINATOR']);
    expect(new Set(verdict.diagnostics.map((d) => d.code))).toEqual(
      new Set([
        'EMPTY_EMISSION_DENOMINATOR',
        'EMPTY_PRIMARY_OWNER_DENOMINATOR',
        STALE_CAPABILITY_COVER_CODE,
      ]),
    );
    expect(
      verdict.diagnostics.filter((d) => d.code === STALE_CAPABILITY_COVER_CODE),
    ).toHaveLength(verdict.staleCoverEligibleCount);
    expect(verdict.staleCoverEligibleCount).toBeGreaterThan(0);

    const offTier = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [{ event: 'seeded.not-in-the-catalog', action: 'a', declaringTool: 'exarchos_view' }],
    );
    expect(offTier.emissionEdgeCount).toBe(1);
    expect(offTier.comparedEmissionEdgeCount).toBe(0);
    expect(
      offTier.diagnostics
        .map((d) => d.code)
        .filter((code) => code.startsWith('EMPTY_') || code === 'NARROWED_EMISSION_DENOMINATOR'),
    ).toEqual(['EMPTY_EMISSION_DENOMINATOR']);

    const noSubjects = validateRegistrationWelds(
      {},
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [],
    );
    expect(noSubjects.diagnostics.map((d) => d.code)).toEqual(['EMPTY_CAPABILITY_DENOMINATOR']);
  });

  /**
   * The edge population comes from the tool registry. The test walks the registry a second time
   * with `Reflect.get`, and does not trust the function under test. Each edge names an action that
   * its tool registers, and each declaring tool is a live composite tool name.
   * The registry is a parameter, so an empty registry gives no edges.
   */
  it('ProviderComparison_EmissionEdges_AreReadOffTheLiveToolRegistry', () => {
    const edges = declaredEmissionEdges();
    expect(edges.length).toBeGreaterThan(0);

    const toolByAction = new Map<string, string>();
    let declaredEmissionCount = 0;
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        toolByAction.set(`${tool.name}|${action.name}`, tool.name);
        const raw = Reflect.get(action, 'actionContract');
        if (raw === undefined || raw === null || typeof raw !== 'object') continue;
        const emissions = Reflect.get(raw, 'emissions');
        if (emissions === undefined || emissions === null || typeof emissions !== 'object') continue;
        if (Reflect.get(emissions, 'kind') !== 'declared') continue;
        const values = Reflect.get(emissions, 'values');
        if (Array.isArray(values)) declaredEmissionCount += values.length;
      }
    }
    expect(edges.length).toBe(declaredEmissionCount);
    for (const edge of edges) {
      expect(toolByAction.get(`${edge.declaringTool}|${edge.action}`)).toBe(edge.declaringTool);
    }

    const toolNames = new Set(TOOL_REGISTRY.map((tool) => tool.name));
    expect([...new Set(edges.map((e) => e.declaringTool))].filter((t) => !toolNames.has(t))).toEqual(
      [],
    );

    expect(declaredEmissionEdges([])).toEqual([]);
  });
});

/**
 * `liveIntersectionSize` counts the declared emissions whose event has a boot-resolvable weld.
 * It reads the annotation table and walks the tool registry with `Reflect.get`. It does not call
 * `declaredEmissionEdges`, which is part of the subject. `offTierEmissionEdges` returns the
 * declared edges that the gate does not compare.
 */
describe('ComparisonDenominator — the size of the set the provider comparison ranges over', () => {
  function liveIntersectionSize(): number {
    const welded = new Set(liveCapabilityTypes());
    let size = 0;
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        const raw = Reflect.get(action, 'actionContract');
        if (raw === undefined || raw === null || typeof raw !== 'object') continue;
        const emissions = Reflect.get(raw, 'emissions');
        if (emissions === undefined || emissions === null || typeof emissions !== 'object') continue;
        if (Reflect.get(emissions, 'kind') !== 'declared') continue;
        const values = Reflect.get(emissions, 'values');
        if (!Array.isArray(values)) continue;
        for (const emission of values) {
          if (
            emission !== null &&
            typeof emission === 'object' &&
            'event' in emission &&
            typeof emission.event === 'string' &&
            welded.has(emission.event)
          ) {
            size += 1;
          }
        }
      }
    }
    return size;
  }

  function offTierEmissionEdges(): readonly EmissionEdge[] {
    const welded = new Set(liveCapabilityTypes());
    return declaredEmissionEdges().filter((edge) => !welded.has(edge.event));
  }

  /**
   * The count in the verdict equals the intersection that the test measures. The intersection and
   * the floor are both above zero, because a floor of zero accepts each population.
   * The comparison with the floor is `>=`, because growth is the usual direction and shrinkage is
   * the defect. The floor is not above the live tree, so the narrowing code does not fire.
   * The intersection is a strict subset of the declared edges.
   */
  it('ComparisonDenominator_LiveIntersection_IsNonEmptyAtMeasuredSize', () => {
    const intersection = liveIntersectionSize();
    const verdict = validateRegistrationWelds();

    expect(verdict.comparedEmissionEdgeCount).toBe(intersection);

    expect(intersection).toBeGreaterThan(0);
    expect(EMISSION_DENOMINATOR_FLOOR).toBeGreaterThan(0);

    expect(intersection).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);

    expect(verdict.diagnostics.map((d) => d.code)).not.toContain('NARROWED_EMISSION_DENOMINATOR');

    expect(verdict.emissionEdgeCount).toBeGreaterThan(0);
    expect(intersection).toBeLessThan(verdict.emissionEdgeCount);
  });

  /**
   * The emission set holds each off-tier edge and only three conforming edges, so only the size of
   * the compared set changes. The empty guards and the mismatch check do not fire.
   * The nested `expect` runs the floor expectation of the live test on this set, and it throws.
   * The gate reports one `NARROWED_EMISSION_DENOMINATOR` finding with the compared count and the
   * floor. The finding is `observe`: a blocking floor makes a valid re-tiering unbootable.
   *
   * The verdict is still not bootable, because each weld without an edge is stale cover, which
   * blocks. The control uses the full conforming population and is clean. With zero compared edges,
   * the empty code fires and the narrowing code does not.
   */
  it('ComparisonDenominator_SeededShrink_FailsRatherThanPassingClean', () => {
    const offTier = offTierEmissionEdges();
    expect(offTier.length).toBeGreaterThan(0);
    const kept = CONFORMING_EMISSIONS.slice(0, 3);
    expect(kept).toHaveLength(3);

    const verdict = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [...kept, ...offTier],
    );

    expect(verdict.bootResolvedCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.emissionEdgeCount).toBeGreaterThan(0);
    expect(verdict.comparedEmissionEdgeCount).toBe(kept.length);
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThan(0);

    const codes = verdict.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('EMPTY_EMISSION_DENOMINATOR');
    expect(codes).not.toContain('EMPTY_CAPABILITY_DENOMINATOR');
    expect(codes).not.toContain(EMISSION_PROVIDER_MISMATCH_CODE);

    expect(() =>
      expect(verdict.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR),
    ).toThrow();

    expect(verdict.ok).toBe(false);
    const narrowing = verdict.diagnostics.filter(
      (d) => d.code === 'NARROWED_EMISSION_DENOMINATOR',
    );
    expect(narrowing).toHaveLength(1);
    const finding = narrowing[0];
    expect(finding).toBeDefined();
    if (finding === undefined || finding.code !== 'NARROWED_EMISSION_DENOMINATOR') return;
    expect(finding.compared).toBe(kept.length);
    expect(finding.floor).toBe(EMISSION_DENOMINATOR_FLOOR);
    expect(finding.message).toContain(`${EMISSION_DENOMINATOR_FLOOR}`);
    expect(finding.message).toContain(`${kept.length}`);

    expect(finding.severity).toBe('observe');

    const blockingCodes = new Set(
      verdict.diagnostics.filter((d) => d.severity === 'blocking').map((d) => d.code),
    );
    expect(blockingCodes.has('NARROWED_EMISSION_DENOMINATOR')).toBe(false);
    expect(blockingCodes.has(STALE_CAPABILITY_COVER_CODE)).toBe(true);

    const restored = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [...CONFORMING_EMISSIONS, ...offTier],
    );
    expect(restored.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);
    expect(restored.diagnostics).toEqual([]);
    expect(restored.ok).toBe(true);

    const emptied = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      offTier,
    );
    expect(emptied.comparedEmissionEdgeCount).toBe(0);
    expect(
      emptied.diagnostics
        .map((d) => d.code)
        .filter((code) => code === 'EMPTY_EMISSION_DENOMINATOR' || code === 'NARROWED_EMISSION_DENOMINATOR'),
    ).toEqual(['EMPTY_EMISSION_DENOMINATOR']);
  });
});

/**
 * A constructed disagreement. The shipped ledger is empty and supplies no fixture, so this constant
 * and {@link FIXTURE_DISPOSITION} keep the tests of the audit active.
 */
const FIXTURE_DISAGREEMENT = Object.freeze({
  event: 'fixture.disagreed',
  action: 'fixture_action',
  declaredProvider: 'exarchos_workflow',
  declaringTool: 'exarchos_orchestrate',
});

/** The ledger row that answers for {@link FIXTURE_DISAGREEMENT}. */
const FIXTURE_DISPOSITION = Object.freeze({
  ...FIXTURE_DISAGREEMENT,
  classification: 'genuine-mismatch' as const,
  rationale:
    'Constructed fixture. It answers for FIXTURE_DISAGREEMENT so the audit has a covered edge to ' +
    'compare against, and it describes no registration in the shipped catalog by design.',
});

/**
 * `unlistedDisagreement` returns a disagreeing edge that no ledger row covers, and throws when a
 * row covers it. `liveProviderOf` returns the provider that the live catalog declares for an event.
 * `liveVerdictPlus` runs the gate on the live inputs plus extra emission edges.
 */
describe('ProviderBreakSet — every reported disagreement is answered for', () => {
  function unlistedDisagreement(): EmissionEdge {
    const seed = disagreeingEmissionEdge();
    const covered = PROVIDER_DISAGREEMENT_DISPOSITIONS.some(
      (row) => row.event === seed.event && row.action === seed.action,
    );
    if (covered) throw new Error('the seeded disagreement is already in the ledger');
    return seed;
  }

  function liveProviderOf(eventType: string): string {
    const registration = EVENT_ANNOTATIONS[eventType];
    if (registration === undefined || registration.tier !== 'capability') {
      throw new Error(`'${eventType}' carries no live capability registration`);
    }
    return registration.provider;
  }

  function liveVerdictPlus(extra: readonly EmissionEdge[]): WeldResolutionVerdict {
    return validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [...declaredEmissionEdges(), ...extra],
    );
  }

  /**
   * The test first pins the compared set at or above its floor, because a ledger reconciled with
   * an empty comparison is clean over nothing. The audit must be clean in both directions.
   * The break set is closed: the comparison reports no disagreement and the ledger is empty.
   * A new disagreement has no row, so the audit reports it and this test fails.
   */
  it('ProviderBreakSet_EveryDisagreementIsDispositioned', () => {
    const live = validateRegistrationWelds();

    expect(live.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);
    expect(live.diagnostics.map((d) => d.code)).not.toContain('NARROWED_EMISSION_DENOMINATOR');
    expect(live.diagnostics.map((d) => d.code)).not.toContain('EMPTY_EMISSION_DENOMINATOR');

    const reported = reportedDisagreements(live);
    const audit = auditDisagreementDispositions(reported);

    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);

    expect(audit.reportedCount).toBe(reported.length);
    expect(audit.dispositionedCount).toBe(PROVIDER_DISAGREEMENT_DISPOSITIONS.length);
    expect(audit.reportedCount).toBe(audit.dispositionedCount);

    for (const row of PROVIDER_DISAGREEMENT_DISPOSITIONS) {
      expect(['genuine-mismatch', 'annotation-error']).toContain(row.classification);
      expect(row.rationale.trim().length).toBeGreaterThan(0);
      expect(row.declaringTool).not.toBe(row.declaredProvider);
      const registration = EVENT_ANNOTATIONS[row.event];
      expect(registration).toBeDefined();
      expect(registration?.tier).toBe('capability');
      if (registration?.tier === 'capability') {
        expect(registration.provider).toBe(row.declaredProvider);
      }
    }

    const classifications = new Set(
      PROVIDER_DISAGREEMENT_DISPOSITIONS.map((row) => row.classification),
    );
    for (const classification of classifications) {
      expect(['genuine-mismatch', 'annotation-error']).toContain(classification);
    }

    expect(reportedDisagreements(), 'a provider disagreement is back').toEqual([]);
    expect(PROVIDER_DISAGREEMENT_DISPOSITIONS).toEqual([]);
    expect(auditDisagreementDispositions().ok).toBe(true);
  });

  /**
   * The control is first: the live inputs give a clean audit.
   * Arm one seeds a new disagreement. The gate refuses to boot, and the audit reports one
   * `UNDISPOSITIONED_DISAGREEMENT` that names the four sides and both classifications.
   * Arm two drops the row of a constructed pair, and the audit reports the edge. The same edge
   * with its row is clean. The pair is constructed because the shipped ledger is empty.
   */
  it('ProviderBreakSet_UndispositionedEntry_Fails', () => {
    const control = auditDisagreementDispositions(reportedDisagreements(liveVerdictPlus([])));
    expect(control.diagnostics).toEqual([]);
    expect(control.ok).toBe(true);

    const seed = unlistedDisagreement();
    const seeded = liveVerdictPlus([seed]);

    expect(seeded.bootable).toBe(false);
    expect(seeded.blockingCount).toBeGreaterThan(0);

    const seededReport = reportedDisagreements(seeded);
    expect(seededReport.length).toBe(control.reportedCount + 1);

    const seededAudit = auditDisagreementDispositions(seededReport);

    expect(seededAudit.ok).toBe(false);
    expect(seededAudit.diagnostics).toHaveLength(1);
    const finding = seededAudit.diagnostics[0];
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    expect(finding.code).toBe('UNDISPOSITIONED_DISAGREEMENT');
    expect(finding.identity).toEqual({
      event: seed.event,
      action: seed.action,
      declaredProvider: liveProviderOf(seed.event),
      declaringTool: seed.declaringTool,
    });
    expect(finding.message).toContain(seed.event);
    expect(finding.message).toContain(seed.action);
    expect(finding.message).toContain('genuine-mismatch');
    expect(finding.message).toContain('annotation-error');

    const dropped = FIXTURE_DISAGREEMENT;
    const thinned = auditDisagreementDispositions([dropped], []);
    expect(thinned.ok).toBe(false);
    expect(thinned.diagnostics.map((d) => d.code)).toEqual(['UNDISPOSITIONED_DISAGREEMENT']);
    expect(thinned.diagnostics[0]?.identity).toEqual({
      event: dropped.event,
      action: dropped.action,
      declaredProvider: dropped.declaredProvider,
      declaringTool: dropped.declaringTool,
    });

    const answered = auditDisagreementDispositions([dropped], [FIXTURE_DISPOSITION]);
    expect(answered.ok).toBe(true);
    expect(answered.diagnostics).toEqual([]);
  });

  /**
   * A row whose subject is gone has the same shape as a live row. Only the `STALE_DISPOSITION` arm
   * can find it. The row count grows by one while the reported count stays the same.
   */
  it('ProviderBreakSet_RowCoveringNothing_IsReportedStale', () => {
    const ghost = {
      event: 'ghost.event',
      action: 'ghost_action',
      declaredProvider: 'exarchos_workflow',
      declaringTool: 'exarchos_orchestrate',
      classification: 'genuine-mismatch',
      rationale: 'seeded row answering for a disagreement the comparison does not report',
    } as const;

    const audit = auditDisagreementDispositions(reportedDisagreements(), [
      ...PROVIDER_DISAGREEMENT_DISPOSITIONS,
      ghost,
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.diagnostics.map((d) => d.code)).toEqual(['STALE_DISPOSITION']);
    expect(audit.diagnostics[0]?.identity).toEqual({
      event: ghost.event,
      action: ghost.action,
      declaredProvider: ghost.declaredProvider,
      declaringTool: ghost.declaringTool,
    });
    expect(audit.diagnostics[0]?.message).toContain('Delete the row');

    expect(audit.dispositionedCount).toBe(PROVIDER_DISAGREEMENT_DISPOSITIONS.length + 1);
    expect(audit.reportedCount).toBe(PROVIDER_DISAGREEMENT_DISPOSITIONS.length);
  });

  /**
   * The key has four sides. With a key on the event alone, one row answers for a second edge on the
   * same event. The fixture has two edges on one event and one row, and the audit reports the
   * second edge. The audit also reports an edge with a changed action. That last call passes no
   * ledger, so it compares with the shipped ledger, which is empty.
   */
  it('ProviderBreakSet_MatchIsOnAllFourSides_NotTheEventAlone', () => {
    const twoEdgesOneEvent = FIXTURE_DISPOSITION;
    const secondEdge = {
      event: twoEdgesOneEvent.event,
      action: `${twoEdgesOneEvent.action}_second_wiring`,
      declaredProvider: twoEdgesOneEvent.declaredProvider,
      declaringTool: twoEdgesOneEvent.declaringTool,
    };
    const bothEdges = auditDisagreementDispositions([
      {
        event: twoEdgesOneEvent.event,
        action: twoEdgesOneEvent.action,
        declaredProvider: twoEdgesOneEvent.declaredProvider,
        declaringTool: twoEdgesOneEvent.declaringTool,
      },
      secondEdge,
    ], [FIXTURE_DISPOSITION]);
    expect(bothEdges.diagnostics.map((d) => d.code)).toContain('UNDISPOSITIONED_DISAGREEMENT');
    expect(
      bothEdges.diagnostics.filter((d) => d.code === 'UNDISPOSITIONED_DISAGREEMENT'),
    ).toHaveLength(1);

    const covered = FIXTURE_DISPOSITION;
    const movedAction = auditDisagreementDispositions([
      {
        event: covered.event,
        action: `${covered.action}_relocated`,
        declaredProvider: covered.declaredProvider,
        declaringTool: covered.declaringTool,
      },
    ]);
    expect(movedAction.diagnostics.map((d) => d.code)).toContain('UNDISPOSITIONED_DISAGREEMENT');
  });
});

/**
 * `capabilityAt` builds a valid `capability` registration for a lifecycle and a provider, with
 * each other field fixed. `aResolvableProvider` returns a provider id that resolves.
 * `staleFindings` returns the stale-cover findings of a verdict.
 * `verdictOver` runs the gate with substituted annotations and emissions. Its module emissions
 * default to empty, so a shipped row cannot cover a seeded weld.
 */
describe('StaleCover — a capability weld that nothing declares it emits', () => {
  function capabilityAt(lifecycle: EventLifecycle, provider: string): EventRegistration {
    return { lifecycle, tier: 'capability', provider, consumedBy: ['workflow-state@v1'] };
  }

  function aResolvableProvider(): string {
    const provider = resolvableProviderIds()[0];
    if (provider === undefined) throw new Error('no resolvable provider to seed a weld with');
    return provider;
  }

  function verdictOver(
    annotations: Readonly<Record<string, EventRegistration>>,
    emissions: readonly EmissionEdge[],
    lifecyclePolicy: Readonly<
      Record<EventLifecycle, StaleCoverEligibility>
    > = STALE_COVER_LIFECYCLE_POLICY,
    moduleEmissions: readonly ModuleEmission[] = [],
  ): WeldResolutionVerdict {
    return validateRegistrationWelds(
      annotations,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      emissions,
      lifecyclePolicy,
      moduleEmissions,
    );
  }

  function staleFindings(
    verdict: WeldResolutionVerdict,
  ): { eventType: string; provider: string; lifecycle: EventLifecycle; message: string }[] {
    const found: {
      eventType: string;
      provider: string;
      lifecycle: EventLifecycle;
      message: string;
    }[] = [];
    for (const diagnostic of verdict.diagnostics) {
      if (diagnostic.code !== STALE_CAPABILITY_COVER_CODE) continue;
      found.push({
        eventType: diagnostic.eventType,
        provider: diagnostic.provider,
        lifecycle: diagnostic.lifecycle,
        message: diagnostic.message,
      });
    }
    return found;
  }

  /**
   * The control is first: a population that names each capability registration reports nothing.
   * The seed removes the one edge of an active capability event and leaves the registration as is.
   * Each other check passes, and the gate reports one stale-cover finding with the event, the
   * provider and the lifecycle. The severity comes from the shipped table and is `blocking`.
   * The startup assertion throws, and the report sink stays empty. With the edge restored, the
   * verdict is clean.
   */
  it('StaleCover_ActiveWeldNamedByNoEdge_FailsAsStale', () => {
    const control = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS);
    expect(control.diagnostics).toEqual([]);
    expect(control.ok).toBe(true);
    expect(control.staleCoverEligibleCount).toBeGreaterThan(0);

    const registration = EVENT_ANNOTATIONS[STALE_COVER_SEED_EVENT];
    expect(registration).toBeDefined();
    expect(registration?.tier).toBe('capability');
    expect(registration?.lifecycle).toBe('active');
    expect(CONFORMING_EMISSIONS_MINUS_ONE).toHaveLength(CONFORMING_EMISSIONS.length - 1);

    const verdict = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS_MINUS_ONE);

    const codes = verdict.diagnostics.map((d) => d.code);
    expect(codes).not.toContain(UNRESOLVABLE_PROVIDER_CODE);
    expect(codes).not.toContain(EMISSION_PROVIDER_MISMATCH_CODE);
    expect(codes).not.toContain('EMPTY_EMISSION_DENOMINATOR');
    expect(codes).not.toContain('NARROWED_EMISSION_DENOMINATOR');
    expect(codes).not.toContain('EMPTY_STALE_COVER_DENOMINATOR');
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);

    const stale = staleFindings(verdict);
    expect(stale.map((d) => d.eventType)).toEqual([STALE_COVER_SEED_EVENT]);
    const finding = stale[0];
    expect(finding).toBeDefined();
    if (finding === undefined) return;

    if (registration !== undefined && registration.tier === 'capability') {
      expect(finding.provider).toBe(registration.provider);
    }
    expect(finding.lifecycle).toBe('active');
    expect(finding.message).toContain(STALE_COVER_SEED_EVENT);
    expect(finding.message).toContain(finding.provider);
    expect(finding.message).toContain('autoEmits');

    expect(DIAGNOSTIC_SEVERITY_POLICY[STALE_CAPABILITY_COVER_CODE]).toBe('blocking');
    expect(verdict.ok).toBe(false);
    expect(verdict.bootable).toBe(false);
    expect(verdict.blockingCount).toBe(verdict.diagnostics.length);
    expect(verdict.observeCount).toBe(0);

    const reported: string[] = [];
    let caught: unknown;
    try {
      assertRegistrationWeldsAtStartup(
        EVENT_ANNOTATIONS,
        EFFECT_PROVIDERS,
        EFFECT_OWNERSHIP,
        WELD_RESOLUTION_POLICY,
        DIAGNOSTIC_SEVERITY_POLICY,
        (message) => reported.push(message),
        CONFORMING_EMISSIONS_MINUS_ONE,
        STALE_COVER_LIFECYCLE_POLICY,
        [],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistrationWeldError);
    if (!(caught instanceof RegistrationWeldError)) return;
    expect(caught.verdict.bootable).toBe(false);
    expect(caught.verdict.report).toContain(STALE_CAPABILITY_COVER_CODE);
    expect(caught.verdict.report).toContain(STALE_COVER_SEED_EVENT);
    expect(reported).toEqual([]);

    expect(verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS).diagnostics).toEqual([]);
  });

  /**
   * Three seeded registrations differ only in lifecycle, and no edge names them. The gate reports
   * only the active one, and the eligible count grows by one.
   * The exclusion reads the policy table: with `retired` set to eligible, the gate also reports the
   * retired seed, and `planned` stays excluded.
   * The policy is total over `EVENT_LIFECYCLES`, only `active` is eligible, and each excluded row
   * states a reason. `staleCoverEligibleWelds` shows the same exclusion.
   */
  it('StaleCover_PlannedOrRetired_IsExcludedByLifecycle', () => {
    const provider = aResolvableProvider();
    const unseeded = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS);
    const seeded = catalogWith({
      'seeded.stale-active': capabilityAt('active', provider),
      'seeded.stale-planned': capabilityAt('planned', provider),
      'seeded.stale-retired': capabilityAt('retired', provider),
    });

    const verdict = verdictOver(seeded, CONFORMING_EMISSIONS);
    const seededTypes = ['seeded.stale-active', 'seeded.stale-planned', 'seeded.stale-retired'];
    const reportedSeeds = staleFindings(verdict)
      .map((d) => d.eventType)
      .filter((eventType) => seededTypes.includes(eventType));

    expect(reportedSeeds).toEqual(['seeded.stale-active']);
    expect(bootResolvedWelds(seeded).map((w) => w.eventType)).toEqual(
      expect.arrayContaining(seededTypes),
    );
    expect(verdict.diagnostics.map((d) => d.code)).not.toContain(UNRESOLVABLE_PROVIDER_CODE);
    expect(verdict.staleCoverEligibleCount).toBe(unseeded.staleCoverEligibleCount + 1);

    const retiredIsEligible: Readonly<Record<EventLifecycle, StaleCoverEligibility>> = {
      ...STALE_COVER_LIFECYCLE_POLICY,
      retired: { eligible: true, note: 'seeded: retirement admitted to the population' },
    };
    const flipped = verdictOver(seeded, CONFORMING_EMISSIONS, retiredIsEligible);
    const flippedSeeds = staleFindings(flipped)
      .map((d) => d.eventType)
      .filter((eventType) => seededTypes.includes(eventType));
    expect(flippedSeeds.sort()).toEqual(['seeded.stale-active', 'seeded.stale-retired']);
    expect(flippedSeeds).not.toContain('seeded.stale-planned');
    const retiredFinding = staleFindings(flipped).find(
      (d) => d.eventType === 'seeded.stale-retired',
    );
    expect(retiredFinding?.lifecycle).toBe('retired');

    expect(Object.keys(STALE_COVER_LIFECYCLE_POLICY).sort()).toEqual([...EVENT_LIFECYCLES].sort());
    const eligibleStates = EVENT_LIFECYCLES.filter(
      (lifecycle) => STALE_COVER_LIFECYCLE_POLICY[lifecycle].eligible,
    );
    expect(eligibleStates).toEqual(['active']);
    for (const lifecycle of EVENT_LIFECYCLES) {
      const row = STALE_COVER_LIFECYCLE_POLICY[lifecycle];
      expect(row.note.trim().length).toBeGreaterThan(0);
      if (!row.eligible) expect(['not-yet', 'not-any-more']).toContain(row.unemitted);
    }

    const welds = bootResolvedWelds(seeded);
    const eligible = staleCoverEligibleWelds(welds).map((w) => w.eventType);
    expect(eligible).toContain('seeded.stale-active');
    expect(eligible).not.toContain('seeded.stale-planned');
    expect(eligible).not.toContain('seeded.stale-retired');
    expect(staleCoverEligibleWelds(welds, retiredIsEligible).map((w) => w.eventType)).toContain(
      'seeded.stale-retired',
    );
  });

  /**
   * An empty eligible population must be a fault, because a check over nothing looks clean.
   * The catalog retires each capability registration, so the welds remain and only the lifecycle
   * empties the subject set. The finding carries the excluded count and is `observe`.
   * `EMPTY_CAPABILITY_DENOMINATOR` does not fire. With no capability registrations, that code
   * fires and the stale-cover guard does not. The live catalog reports neither.
   */
  it('StaleCover_EmptyEligiblePopulation_FailsInsteadOfPassingClean', () => {
    const retired = everyCapabilityRetired();
    const verdict = verdictOver(retired, CONFORMING_EMISSIONS);

    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length);
    expect(verdict.bootResolvedCount).toBeGreaterThan(0);
    expect(verdict.staleCoverEligibleCount).toBe(0);
    expect(verdict.ok).toBe(false);

    const empties = verdict.diagnostics.filter(
      (d) => d.code === 'EMPTY_STALE_COVER_DENOMINATOR',
    );
    expect(empties).toHaveLength(1);
    const finding = empties[0];
    expect(finding).toBeDefined();
    if (finding === undefined || finding.code !== 'EMPTY_STALE_COVER_DENOMINATOR') return;
    expect(finding.excludedByLifecycle).toBe(verdict.bootResolvedCount);
    expect(finding.message).toContain(`${verdict.bootResolvedCount}`);
    expect(finding.severity).toBe('observe');

    expect(verdict.diagnostics.map((d) => d.code)).not.toContain('EMPTY_CAPABILITY_DENOMINATOR');
    expect(staleFindings(verdict)).toEqual([]);

    const withoutCapabilities: Record<string, EventRegistration> = {};
    for (const [eventType, registration] of Object.entries(EVENT_ANNOTATIONS)) {
      if (registration.tier === 'capability') continue;
      withoutCapabilities[eventType] = registration;
    }
    const noSubjects = verdictOver(withoutCapabilities, CONFORMING_EMISSIONS);
    expect(noSubjects.staleCoverEligibleCount).toBe(0);
    expect(noSubjects.ok).toBe(false);
    expect(noSubjects.diagnostics.map((d) => d.code)).toContain('EMPTY_CAPABILITY_DENOMINATOR');
    expect(noSubjects.diagnostics.map((d) => d.code)).not.toContain(
      'EMPTY_STALE_COVER_DENOMINATOR',
    );

    const live = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS);
    expect(live.staleCoverEligibleCount).toBeGreaterThan(0);
    expect(live.diagnostics).toEqual([]);
  });

  /**
   * The test derives the eligible count from the annotation table and compares it with the verdict.
   * The live tree excludes at least one registration, so the exclusion arm has a real subject.
   * The live tree has no stale cover. The test computes the named events from the tool registry
   * and the module emissions directly, and each eligible weld is in that set.
   * The report carries the eligible count.
   */
  it('StaleCover_LiveCatalog_ReportsTheEligibleCountBesideTheVerdict', () => {
    const verdict = validateRegistrationWelds();

    const capability = capabilityRegistrationsIn(EVENT_ANNOTATIONS);
    const active = capability.filter((row) => row.lifecycle === 'active');
    expect(verdict.bootResolvedCount).toBe(capability.length);
    expect(verdict.staleCoverEligibleCount).toBe(active.length);
    expect(verdict.staleCoverEligibleCount).toBeGreaterThan(0);

    expect(verdict.staleCoverEligibleCount).toBeLessThan(verdict.bootResolvedCount);
    const excluded = capability.filter((row) => row.lifecycle !== 'active');
    expect(excluded.length).toBeGreaterThan(0);
    for (const row of excluded) expect(['planned', 'retired']).toContain(row.lifecycle);

    const stale = staleFindings(verdict);
    expect(stale).toEqual([]);

    const namedByAnEdge = new Set<string>();
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        for (const emission of contractEmissionsOf(action)) namedByAnEdge.add(emission.event);
      }
    }
    for (const row of MODULE_EMISSIONS) namedByAnEdge.add(row.event);
    expect(namedByAnEdge.size).toBeGreaterThan(0);

    const eligibleTypes = staleCoverEligibleWelds(bootResolvedWelds(EVENT_ANNOTATIONS)).map(
      (weld) => weld.eventType,
    );
    expect(eligibleTypes.length).toBe(verdict.staleCoverEligibleCount);
    const unnamed = eligibleTypes.filter((eventType) => !namedByAnEdge.has(eventType));
    expect(unnamed, 'an eligible weld no declared edge names').toEqual([]);

    const excludedTypes = new Set(excluded.map((row) => row.eventType));
    for (const eventType of eligibleTypes) expect(excludedTypes.has(eventType)).toBe(false);

    expect(verdict.report).toContain(`${verdict.staleCoverEligibleCount} stale-cover eligible`);
  });
});

/**
 * `unlistedStaleCover` builds an active, resolvable `capability` registration that no edge and no
 * ledger row names. It throws when the event type is already in use.
 * `liveVerdictWithCatalog` runs the gate on the live inputs with extra annotations.
 */
describe('StaleCoverBreakSet — every active unnamed weld is answered for', () => {
  function unlistedStaleCover(): { readonly eventType: string; readonly registration: EventRegistration } {
    const provider = resolvableProviderIds()[0];
    if (provider === undefined) throw new Error('no resolvable provider to seed a stale weld with');
    const eventType = 'seeded.stale-cover-unlisted';
    if (EVENT_ANNOTATIONS[eventType] !== undefined) {
      throw new Error('the seeded stale-cover event already exists in the live catalog');
    }
    if (declaredEmissionEdges().some((edge) => edge.event === eventType)) {
      throw new Error('the seeded stale-cover event is already named by a declared edge');
    }
    if (STALE_COVER_DISPOSITIONS.some((row) => row.event === eventType)) {
      throw new Error('the seeded stale cover is already in the ledger');
    }
    return {
      eventType,
      registration: {
        lifecycle: 'active',
        tier: 'capability',
        provider,
        consumedBy: ['workflow-state@v1'],
      },
    };
  }

  function liveVerdictWithCatalog(
    overrides: Readonly<Record<string, EventRegistration>>,
  ): WeldResolutionVerdict {
    return validateRegistrationWelds(
      catalogWith(overrides),
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      declaredEmissionEdges(),
    );
  }

  /**
   * The test first pins an eligible population above zero, because a ledger reconciled with an
   * empty check is clean over nothing. The audit must be clean in both directions.
   * The ledger is empty. With no reported stale cover, only an empty ledger passes, so a new stale
   * cover fails this test at once.
   */
  it('StaleCoverBreakSet_EveryActiveUnnamedWeld_IsDispositioned', () => {
    const live = validateRegistrationWelds();

    expect(live.staleCoverEligibleCount).toBeGreaterThan(0);
    expect(live.diagnostics.map((d) => d.code)).not.toContain('EMPTY_STALE_COVER_DENOMINATOR');
    expect(live.diagnostics.map((d) => d.code)).not.toContain('EMPTY_CAPABILITY_DENOMINATOR');

    const reported = reportedStaleCover(live);
    const audit = auditStaleCoverDispositions(reported);

    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);

    expect(audit.reportedCount).toBe(reported.length);
    expect(audit.dispositionedCount).toBe(STALE_COVER_DISPOSITIONS.length);
    expect(audit.reportedCount).toBe(audit.dispositionedCount);

    const eligible = staleCoverEligibleWelds(bootResolvedWelds());
    expect(eligible.length).toBe(live.staleCoverEligibleCount);

    for (const row of STALE_COVER_DISPOSITIONS) {
      expect(['unmodelled-emitter', 'undeclared-emission']).toContain(row.classification);
      expect(row.rationale.trim().length).toBeGreaterThan(0);
      expect(row.appendSite.trim().length).toBeGreaterThan(0);

      const weld = eligible.find((candidate) => candidate.eventType === row.event);
      expect(weld).toBeDefined();
      expect(weld?.ref).toBe(row.declaredProvider);
      expect(weld?.lifecycle).toBe(row.lifecycle);

      expect(STALE_COVER_LIFECYCLE_POLICY[row.lifecycle].eligible).toBe(true);

      const registration = EVENT_ANNOTATIONS[row.event];
      expect(registration).toBeDefined();
      expect(registration?.tier).toBe('capability');
      if (registration?.tier === 'capability') {
        expect(registration.provider).toBe(row.declaredProvider);
        expect(registration.lifecycle).toBe(row.lifecycle);
      }

      expect(declaredEmissionEdges().some((edge) => edge.event === row.event)).toBe(false);
    }

    const classifications = new Set(STALE_COVER_DISPOSITIONS.map((row) => row.classification));
    for (const classification of classifications) {
      expect(['undeclared-emission', 'unmodelled-emitter']).toContain(classification);
    }

    const undeclared = STALE_COVER_DISPOSITIONS.filter(
      (row) => row.classification === 'undeclared-emission',
    );
    expect(undeclared).toEqual([]);

    expect(STALE_COVER_DISPOSITIONS).toEqual([]);
  });

  /**
   * The control is first: the live inputs give a clean audit.
   * Arm one seeds a new stale weld. The gate refuses to boot, the eligible count grows by one, and
   * the audit reports one `UNDISPOSITIONED_STALE_COVER` with the three sides. The message names
   * both classifications and the lifecycle.
   *
   * Arm two uses a constructed row, because the shipped ledger is empty. With the row, the audit is
   * clean. Without the row, the audit reports the weld.
   */
  it('StaleCoverBreakSet_UndispositionedEntry_Fails', () => {
    const control = auditStaleCoverDispositions(reportedStaleCover());
    expect(control.diagnostics).toEqual([]);
    expect(control.ok).toBe(true);

    const seed = unlistedStaleCover();
    const seeded = liveVerdictWithCatalog({ [seed.eventType]: seed.registration });

    expect(seeded.bootable).toBe(false);
    expect(seeded.blockingCount).toBeGreaterThan(0);
    expect(seeded.staleCoverEligibleCount).toBe(
      validateRegistrationWelds().staleCoverEligibleCount + 1,
    );

    const seededReport = reportedStaleCover(seeded);
    expect(seededReport.length).toBe(control.reportedCount + 1);

    const seededAudit = auditStaleCoverDispositions(seededReport);

    expect(seededAudit.ok).toBe(false);
    expect(seededAudit.diagnostics).toHaveLength(1);
    const finding = seededAudit.diagnostics[0];
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    expect(finding.code).toBe('UNDISPOSITIONED_STALE_COVER');
    expect(finding.identity).toEqual({
      event: seed.eventType,
      declaredProvider: seed.registration.tier === 'capability' ? seed.registration.provider : '',
      lifecycle: seed.registration.lifecycle,
    });
    expect(finding.message).toContain(seed.eventType);
    expect(finding.message).toContain('undeclared-emission');
    expect(finding.message).toContain('unmodelled-emitter');
    expect(finding.message).toContain('lifecycle');

    const answering: StaleCoverDisposition = {
      event: seed.eventType,
      declaredProvider:
        seed.registration.tier === 'capability' ? seed.registration.provider : '',
      lifecycle: seed.registration.lifecycle,
      classification: 'undeclared-emission',
      appendSite: 'seeded — no live append site, this row exists to be removed',
      rationale: 'Seeded so the coverage half has a subject the live ledger no longer provides.',
    };

    const covered = auditStaleCoverDispositions(seededReport, [answering]);
    expect(covered.ok).toBe(true);
    expect(covered.diagnostics).toEqual([]);
    expect(covered.dispositionedCount).toBe(1);

    const thinned = auditStaleCoverDispositions(seededReport, []);
    expect(thinned.ok).toBe(false);
    expect(thinned.diagnostics.map((d) => d.code)).toEqual(['UNDISPOSITIONED_STALE_COVER']);
    expect(thinned.diagnostics[0]?.identity).toEqual({
      event: answering.event,
      declaredProvider: answering.declaredProvider,
      lifecycle: answering.lifecycle,
    });
  });

  /**
   * A row whose subject is gone has the same shape as a live row. Only the
   * `OBSOLETE_STALE_COVER_DISPOSITION` arm can find it. The row count grows by one while the
   * reported count stays the same.
   */
  it('StaleCoverBreakSet_RowCoveringNothing_IsReportedObsolete', () => {
    const ghost = {
      event: 'ghost.event',
      declaredProvider: 'exarchos_workflow',
      lifecycle: 'active',
      classification: 'unmodelled-emitter',
      appendSite: 'src/ghost/nowhere.ts',
      rationale: 'seeded row answering for a stale cover the gate does not report',
    } as const;

    const audit = auditStaleCoverDispositions(reportedStaleCover(), [
      ...STALE_COVER_DISPOSITIONS,
      ghost,
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.diagnostics.map((d) => d.code)).toEqual(['OBSOLETE_STALE_COVER_DISPOSITION']);
    expect(audit.diagnostics[0]?.identity).toEqual({
      event: ghost.event,
      declaredProvider: ghost.declaredProvider,
      lifecycle: ghost.lifecycle,
    });
    expect(audit.diagnostics[0]?.message).toContain('Delete the row');

    expect(audit.dispositionedCount).toBe(STALE_COVER_DISPOSITIONS.length + 1);
    expect(audit.reportedCount).toBe(STALE_COVER_DISPOSITIONS.length);
  });

  /**
   * The key includes the lifecycle. A row for `active` does not answer for the same event and
   * provider in a different lifecycle, so a wider eligibility policy brings new findings.
   * The audit recognizes the same identity with the lifecycle unchanged. Both calls pass the ledger
   * explicitly, because the default ledger is empty and leaves each finding without a row.
   */
  it('StaleCoverBreakSet_MatchIncludesTheLifecycleSide', () => {
    const covered = {
      event: 'seeded.lifecycle-keyed.event',
      declaredProvider: 'exarchos_workflow',
      lifecycle: 'active',
    } as const;
    const otherLifecycle = EVENT_LIFECYCLES.find((value) => value !== covered.lifecycle);
    expect(otherLifecycle).toBeDefined();
    if (otherLifecycle === undefined) return;

    const movedAnswer: StaleCoverDisposition = {
      ...covered,
      classification: 'unmodelled-emitter',
      appendSite: 'seeded',
      rationale: 'Seeded so the moved arm is refused by the lifecycle side and nothing else.',
    };
    const moved = auditStaleCoverDispositions(
      [
        {
          event: covered.event,
          declaredProvider: covered.declaredProvider,
          lifecycle: otherLifecycle,
        },
      ],
      [movedAnswer],
    );
    expect(moved.diagnostics.map((d) => d.code)).toContain('UNDISPOSITIONED_STALE_COVER');

    const answering: StaleCoverDisposition = {
      ...covered,
      classification: 'unmodelled-emitter',
      appendSite: 'seeded',
      rationale: 'Seeded so the recognised arm has an answer to match against.',
    };
    const untouched = auditStaleCoverDispositions(
      [
        {
          event: covered.event,
          declaredProvider: covered.declaredProvider,
          lifecycle: covered.lifecycle,
        },
      ],
      [answering],
    );
    expect(untouched.diagnostics.map((d) => d.code)).not.toContain('UNDISPOSITIONED_STALE_COVER');
  });
});

/**
 * The eligible count is an exact pin, not a floor. Only an edit to `EVENT_ANNOTATIONS` changes it:
 * a change in the set of capability registrations, or a move across the lifecycle axis.
 * Growth and shrinkage both need a reviewed change of the baseline in the same commit.
 * `EMISSION_DENOMINATOR_FLOOR` is a floor, because unrelated emission declarations widen that set.
 */
describe('EligibleBaseline — the pinned stale-cover eligible count', () => {
  /** The verdict count and the count from the exported functions both equal the baseline. */
  it('EligibleBaseline_PinnedCount_MatchesTheLiveCount', () => {
    const baseline = readEligibleBaseline();
    expect(baseline.eligibleCount).toBeGreaterThan(0);

    const verdict = validateRegistrationWelds();
    expect(verdict.staleCoverEligibleCount).toBe(baseline.eligibleCount);

    const eligible = staleCoverEligibleWelds(bootResolvedWelds());
    expect(eligible.length).toBe(baseline.eligibleCount);
  });

  /**
   * The seed retires one active capability registration, so the eligible population shrinks by one.
   * The expectation of the live test then throws. The control is the live catalog, which matches.
   */
  it('EligibleBaseline_ShrinkWithNoDisposition_Fails', () => {
    const baseline = readEligibleBaseline();

    const registration = EVENT_ANNOTATIONS[STALE_COVER_SEED_EVENT];
    expect(registration).toBeDefined();
    if (registration === undefined || registration.tier !== 'capability') return;
    const shrunk = catalogWith({
      [STALE_COVER_SEED_EVENT]: { ...registration, lifecycle: 'retired' },
    });

    const eligible = staleCoverEligibleWelds(bootResolvedWelds(shrunk));
    expect(eligible.length).toBe(baseline.eligibleCount - 1);

    expect(() => expect(eligible.length).toBe(baseline.eligibleCount)).toThrow();

    expect(staleCoverEligibleWelds(bootResolvedWelds(EVENT_ANNOTATIONS)).length).toBe(
      baseline.eligibleCount,
    );
  });
});
