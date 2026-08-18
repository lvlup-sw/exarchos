// Co-located tests for the DR-2 boot-time weld resolution gate (task 012).
//
// @oracle-sources: ../../../src/contract/reachability/providers.ts, the DR-2 tier and provider annotation task 010 measured from the emission sites
//
// The two authorities, and why they are two. The RESOLUTION SET is
// `contract/reachability/providers.ts` — the effect-provider map, authored for P05-05's
// reachability closure and reconciled against the effect ledger, with no knowledge that events
// exist. The SUBJECTS are the DR-2 tier/provider assignments, which task 010 derived from a
// different pair of populations entirely: which code APPENDS each event, and which reducer or view
// FOLDS it. Neither was read off the other, so this file is a reconciliation of two independent
// measurements rather than a restatement of one. Nothing here writes down a provider id as policy:
// every expectation is computed from the live modules, so a renamed provider changes the assertion
// instead of leaving a stale literal passing.
//
// The second authority is declared as a LABEL rather than as `./event-annotations.ts`, for the
// reason `event-annotations.test.ts` already records: DR-30's derivation check is a static
// MODULE-REACHABILITY walk (`suite-invariants/LIMITATIONS.md` — an over-approximation of
// dependency, an under-approximation of value derivation). `event-annotations.ts` imports
// `event-registration.ts`, which type-imports `contract/reachability/providers.ts`, so naming both
// as paths would report a derivation that does not exist at the value level — the annotations are
// hand-authored from emission evidence, not computed from the provider map. Naming
// `architecture/effect-ledger.ts` as the second path would have been worse still and the gate said
// so: `providers.ts` imports it outright, making them one authority wearing two names.
//
// The COMPILE-time half is not here. `tsconfig.json` excludes `**/*.test.ts`, so type-level
// assertions in this file would be decorative; they live as exported `_RegistrationValidate_*`
// aliases in the source module, where `tsc` actually checks them. Both were kill-probed:
// transcribing `EffectProviderId` into a literal union and giving a second union arm its own
// `provider` field each redden `npx tsc --noEmit`.

import { describe, it, expect } from 'vitest';
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
import { TOOL_REGISTRY } from '../../../src/registry.js';
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
  PROVIDER_DISAGREEMENT_DISPOSITIONS,
  PROVIDER_REGISTRY_DRIFT_CODE,
  RegistrationWeldError,
  STALE_CAPABILITY_COVER_CODE,
  STALE_COVER_DISPOSITIONS,
  STALE_COVER_LIFECYCLE_POLICY,
  UNRESOLVABLE_PROVIDER_CODE,
  WELD_RESOLUTION_POLICY,
  assertRegistrationWeldsAtStartup,
  auditDisagreementDispositions,
  auditStaleCoverDispositions,
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
 * The pinned stale-cover eligible count, authored and committed rather than computed. Resolved with
 * `fs`/`fileURLToPath`, never `import … from '…json'`: `resolveJsonModule` is off in this project,
 * and inside the compiled single-file binary a sibling JSON file is not on disk next to the module
 * that would try to import it — an import would either fail to compile or fail at runtime in the
 * shipped artifact, where this file's `readFileSync` call is exercised only by the test, never by
 * production code.
 */
const EMISSION_ELIGIBLE_BASELINE_PATH = fileURLToPath(
  new URL('../../support/emission-eligible-baseline.json', import.meta.url),
);

/** The shape a baseline file must have — narrowed with a type guard rather than an `as` cast. */
function isEligibleBaseline(value: unknown): value is { eligibleCount: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'eligibleCount' in value &&
    typeof (value as { eligibleCount: unknown }).eligibleCount === 'number'
  );
}

/**
 * Read the pinned baseline off disk. This function has exactly one caller-visible effect — read —
 * and nothing anywhere in this file writes {@link EMISSION_ELIGIBLE_BASELINE_PATH}. A guarded run
 * that regenerated its own baseline before comparing against it would always agree with itself; the
 * artifact is only evidence of anything because this is a one-way read.
 */
function readEligibleBaseline(): { eligibleCount: number } {
  const raw = fs.readFileSync(EMISSION_ELIGIBLE_BASELINE_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isEligibleBaseline(parsed)) {
    throw new Error(`malformed eligible-count baseline at ${EMISSION_ELIGIBLE_BASELINE_PATH}`);
  }
  return parsed;
}

/** The live catalog with extra entries merged in — the seeding seam for the falsifiers below. */
function catalogWith(
  overrides: Readonly<Record<string, EventRegistration>>,
): Readonly<Record<string, EventRegistration>> {
  return { ...EVENT_ANNOTATIONS, ...overrides };
}

/**
 * A `capability` registration naming `provider`. Everything else is fixed and valid, so the ONLY
 * variable under test is whether the provider id resolves.
 */
function capabilityNaming(provider: string): EventRegistration {
  return {
    lifecycle: 'active',
    tier: 'capability',
    provider,
    consumedBy: ['workflow-state@v1'],
  };
}

/** The live capability registrations, read off the catalog rather than listed. */
function liveCapabilityTypes(): string[] {
  return Object.entries(EVENT_ANNOTATIONS)
    .filter(([, registration]) => registration.tier === 'capability')
    .map(([eventType]) => eventType)
    .sort();
}

/**
 * Every capability registration in a catalog as `(eventType, declaredProvider, lifecycle)`, read
 * off the table rather than listed.
 *
 * Takes the catalog as an argument so a SEEDED one can be walked with the same function the live
 * one is. Without that, a fixture built from the live table would silently disagree with a seeded
 * catalog about which events exist — which is a difference that reads as a finding.
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

/** Every live capability registration as `(eventType, declaredProvider)`, read off the catalog. */
function liveCapabilityRegistrations(): { eventType: string; provider: string }[] {
  return capabilityRegistrationsIn(EVENT_ANNOTATIONS);
}

/**
 * An emission population that AGREES with a catalog everywhere: one edge per capability
 * registration in it, declared on the very tool that registration names.
 *
 * DERIVED from the annotation table rather than written down, so it stays conforming as the catalog
 * moves and cannot rot into a fixture that disagrees for a reason nobody meant. The seeds below hold
 * it fixed so each one varies exactly ONE population — without it, the live registry's real
 * disagreements would ride along in every seeded verdict and no seed would isolate anything.
 *
 * Parameterised by the catalog, and that is load-bearing rather than tidy: an edge set built from
 * the LIVE table against a SEEDED catalog leaves the seeded event named by nothing, which is a
 * second finding (stale cover) riding along in a verdict that is supposed to isolate one.
 */
function conformingEmissionEdgesFor(
  annotations: Readonly<Record<string, EventRegistration>>,
): readonly EmissionEdge[] {
  return capabilityRegistrationsIn(annotations).map(({ eventType, provider }) => ({
    event: eventType,
    action: `${eventType}-emitter`,
    declaringTool: provider,
  }));
}

const CONFORMING_EMISSIONS = conformingEmissionEdgesFor(EVENT_ANNOTATIONS);

/**
 * One emission edge that DISAGREES: a live capability event whose declaring tool is a real
 * composite tool OTHER than the provider its registration names.
 *
 * Both ends come off live modules — the event and its declared provider from the annotation table,
 * the declaring tool from the effect-provider map — so this is a genuine two-authority
 * disagreement, not a string nobody would ever write. It throws rather than returning a placeholder
 * when the catalog cannot supply one, because a seed that silently degrades into "no disagreement"
 * would make every test built on it pass by looking at nothing.
 */
function disagreeingEmissionEdge(): EmissionEdge {
  for (const { eventType, provider } of liveCapabilityRegistrations()) {
    const other = EFFECT_PROVIDERS.map((p) => p.tool).find((tool) => tool !== provider);
    if (other === undefined) continue;
    return { event: eventType, action: 'seeded_emitter', declaringTool: other };
  }
  throw new Error('no live capability registration can seed a provider disagreement');
}

/**
 * A provider entry the ledger does not back — the STALE case `providers.ts` names. Used below as
 * the seed that makes the drift diagnostic fire without touching any weld.
 */
const GHOST_PROVIDER: EffectProvider = {
  tool: 'exarchos_ghost',
  area: 'ghost/',
  owner: 'ghost-fs',
  effectClass: 'filesystem',
};

/**
 * One input that makes exactly one named diagnostic fire, holding every other population live. The
 * severity axis has to be demonstrated over EVERY code the gate can emit, not over a favourite one
 * — a severity that only worked for unresolvable providers would leave three faults with an
 * undecided disposition.
 */
interface DiagnosticSeed {
  readonly code: WeldDiagnosticCode;
  readonly annotations: Readonly<Record<string, EventRegistration>>;
  readonly providers: readonly EffectProvider[];
  readonly rules: readonly EffectOwnershipRule[];
  readonly emissions: readonly EmissionEdge[];
}

/**
 * The catalog the unresolvable-provider seed uses, named so its CONFORMING emission population can
 * be derived from it rather than from the live table. Built from the live table plus one event, so
 * every other population stays exactly what the shipped tree holds.
 */
const UNRESOLVABLE_SEED_CATALOG = catalogWith({
  'seeded.severity-unresolvable': capabilityNaming('exarchos_no_such_provider'),
});

/**
 * A catalog in which every capability registration is `retired` — the input that empties the
 * stale-cover population WITHOUT emptying the weld population, which is the only way to reach that
 * vacuity guard rather than the capability one.
 *
 * Derived by rewriting one field of every live capability row, so the welds, their providers and
 * their consumers are all still the shipped values and the lifecycle axis is the single variable.
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
 * A conforming emission population with the edge for ONE active capability event removed — the
 * input that makes that event stale cover and changes nothing else.
 *
 * The event is CHOSEN from the live table (the first active capability registration in event order)
 * rather than named here, so a re-tiering or a retirement moves the subject instead of leaving a
 * literal that no longer selects anything. Throws rather than degrading into "removed nothing",
 * because a seed that quietly stops seeding is how a falsifier ships green forever.
 */
function firstActiveCapabilityEvent(): string {
  const active = capabilityRegistrationsIn(EVENT_ANNOTATIONS).find(
    (row) => row.lifecycle === 'active',
  );
  if (active === undefined) throw new Error('no active capability registration to seed stale cover');
  return active.eventType;
}

const STALE_COVER_SEED_EVENT = firstActiveCapabilityEvent();
const CONFORMING_EMISSIONS_MINUS_ONE = CONFORMING_EMISSIONS.filter(
  (edge) => edge.event !== STALE_COVER_SEED_EVENT,
);

/**
 * A seed per diagnostic code. Each varies ONE population and holds the other three at a value that
 * reports nothing — which is why every seed carries an explicit emission population rather than
 * falling through to the live registry, whose real disagreements would otherwise appear in every
 * verdict and make "exactly one fault fired" untestable.
 */
const DIAGNOSTIC_SEEDS: readonly DiagnosticSeed[] = [
  {
    code: UNRESOLVABLE_PROVIDER_CODE,
    annotations: UNRESOLVABLE_SEED_CATALOG,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    // Derived from the SEEDED catalog, so the added event is named by an edge and the only fault in
    // this verdict is the unresolvable provider.
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
  {
    // Boot-resolvable events exist and NOTHING claims to emit any of them, so the comparison
    // ranged over an empty set. Distinct from EMPTY_CAPABILITY_DENOMINATOR, which is the case
    // where the subject side is what went missing.
    code: 'EMPTY_EMISSION_DENOMINATOR',
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: [],
  },
  {
    // Non-empty and still too small: one conforming edge, so nothing disagrees and no vacuity
    // guard has anything to say. The only thing wrong with this population is its SIZE.
    code: 'NARROWED_EMISSION_DENOMINATOR',
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS.slice(0, 1),
  },
  {
    // One active capability event loses the edge that named it and nothing else moves: the weld
    // still resolves, the remaining edges still agree, and the compared set is one short of the
    // whole capability arm — so the only thing left to notice is that this event is emitted by
    // nothing.
    code: STALE_CAPABILITY_COVER_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS_MINUS_ONE,
  },
  {
    // The welds are all still there and every one of them is `retired`, so the stale-cover
    // population is empty while the capability population is not. Distinct from
    // EMPTY_CAPABILITY_DENOMINATOR, which is the case where the welds themselves went missing.
    code: 'EMPTY_STALE_COVER_DENOMINATOR',
    annotations: everyCapabilityRetired(),
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
  },
];

/**
 * Narrow a raw object key back onto the diagnostic axis. The shipped table is the membership test,
 * so this cannot admit a code the gate does not know about.
 */
function isWeldDiagnosticCode(value: string): value is WeldDiagnosticCode {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SEVERITY_POLICY, value);
}

/**
 * The live severity table with every row rewritten to `severity` — DERIVED from the shipped table's
 * keys rather than transcribed, so it stays total as codes are added and cannot quietly leave a
 * code on its default.
 *
 * Starting from a spread of the shipped table rather than from `{}` is what keeps the result TOTAL
 * by type: a `Record<string, …>` accumulator would satisfy no caller's parameter type and would
 * silently drop a code the loop happened to miss.
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
  it('RegistrationWelds_LiveCatalog_ResolvesAgainstNonEmptyPopulations', () => {
    const verdict = validateRegistrationWelds();

    // The shipped catalog BOOTS, and that is now a strictly weaker claim than "clean". Reference
    // integrity is still perfect — zero blocking faults — while the emission-coupling comparison
    // reports real, measured disagreements at `observe`, so `ok` is false and `bootable` is true.
    // Asserting both is the point: this distinguishes "we found things" from "we refuse to boot",
    // and a gate that had quietly weakened `ok` to mean `bootable` would fail right here.
    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);
    expect(verdict.ok).toBe(false);
    expect(verdict.observeCount).toBe(verdict.diagnostics.length);
    expect(verdict.observeCount).toBeGreaterThan(0);
    // Every finding is emission coupling's — the provider comparison's disagreements and the
    // stale-cover check's unnamed welds. If a REFERENCE-integrity fault ever appears here it is a
    // real defect, not a flake, and it would arrive as a blocking count above zero.
    expect([...new Set(verdict.diagnostics.map((d) => d.code))].sort()).toEqual(
      [EMISSION_PROVIDER_MISMATCH_CODE, STALE_CAPABILITY_COVER_CODE].sort(),
    );

    // NON-VACUOUS DENOMINATORS, all three, and all derived. A gate that resolved zero welds (or
    // resolved them against zero providers, or compared zero emission edges) would report exactly
    // the same verdict shape, which is the failure mode the three EMPTY_* diagnostics exist to
    // make impossible.
    const capabilityTypes = liveCapabilityTypes();
    expect(capabilityTypes.length).toBeGreaterThan(0);
    expect(verdict.bootResolvedCount).toBe(capabilityTypes.length);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBe(resolvableProviderIds().length);
    expect(verdict.emissionEdgeCount).toBe(declaredEmissionEdges().length);
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThan(0);
    // The compared set is a STRICT subset of the declared one — most emission edges name events
    // registered at a tier this gate does not resolve — so a comparison that had quietly widened
    // past the capability arm would show up as these two numbers converging.
    expect(verdict.comparedEmissionEdgeCount).toBeLessThan(verdict.emissionEdgeCount);

    // The subject set IS the capability tier — the policy table's `resolvedAt: 'boot'` row and the
    // catalog agree on which registrations are in scope, computed from both ends.
    expect(bootResolvedWelds().map((w) => w.eventType)).toEqual(capabilityTypes);

    // AUTHORITY 2, independently: every id the welds name is a live `EFFECT_PROVIDERS` tool. Read
    // off the provider map here, not off the annotations, so this is a reconciliation of two
    // populations rather than a restatement of one.
    const liveTools = new Set(EFFECT_PROVIDERS.map((p) => p.tool));
    const namedTools = new Set(bootResolvedWelds().map((w) => w.ref));
    expect([...namedTools].filter((tool) => !liveTools.has(tool))).toEqual([]);
    expect(namedTools.size).toBeGreaterThan(0);

    // The report reads as SURVIVED-WITH-FINDINGS, not as clean and not as a refusal, and it carries
    // every denominator so no count in it can be read without the population it was measured over.
    expect(verdict.report).toContain('event registration welds BOOTABLE');
    expect(verdict.report).toContain('0 blocking fault(s)');
    expect(verdict.report).toContain('observe-only');
    expect(verdict.report).not.toContain('FAILED');
    expect(verdict.report).toContain(`${verdict.bootResolvedCount} boot-resolved weld(s)`);
    expect(verdict.report).toContain(`${verdict.resolvableProviderCount} live provider(s)`);
    expect(verdict.report).toContain(
      `${verdict.comparedEmissionEdgeCount} compared emission edge(s)`,
    );
  });

  it('RegistrationWelds_SeededUnresolvableProvider_FailsTheGate', () => {
    // THE KILL FIXTURE. A structurally perfect `capability` registration — active lifecycle, a real
    // consumer, a non-empty provider string — whose provider names nothing. The union cannot reject
    // it (`EffectProviderId` is deliberately `string`, so that transcribing `EFFECT_PROVIDERS` into
    // the type does not create a second authority), which is precisely why reference integrity has
    // to be a BOOT failure.
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
    // The message names the id AND the resolvable set, so an operator can fix it without reading
    // this source.
    expect(unresolvable[0]?.message).toContain(seededProvider);
    for (const id of resolvableProviderIds()) {
      expect(unresolvable[0]?.message).toContain(id);
    }

    // The denominators are still healthy — the fault is the weld, not the populations. Asserting
    // BOTH numbers is what stops "unresolvable" from being reported for the wrong reason.
    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length + 1);
    expect(verdict.resolvableProviderCount).toBe(resolvableProviderIds().length);

    // And the gate THROWS, carrying the verdict — this is the call `initializeContext` makes.
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

  it('RegistrationWelds_ProviderThatOnlyLooksLive_StillFails', () => {
    // The PROPERTY is "names a live effect provider", and the PROXY is "appears in the
    // EFFECT_PROVIDERS array". They come apart exactly when the provider map has drifted from the
    // effect ledger, which `providers.ts` calls a STALE provider. Here the two disagree by
    // construction: the array contains `exarchos_ghost`, but no EFFECT_OWNERSHIP rule backs it.
    //
    // BOTH numbers are asserted. A gate measuring the proxy would resolve the weld and report
    // clean over 1 provider; the gate measures the property, so the id is unresolvable AND the
    // drift is named as its own cause.
    const ghost: EffectProvider = {
      tool: 'exarchos_ghost',
      area: 'ghost/',
      owner: 'ghost-fs',
      effectClass: 'filesystem',
    };
    const providers = [...EFFECT_PROVIDERS, ghost];

    // PROXY: membership in the raw array — 1 match.
    expect(providers.filter((p) => p.tool === ghost.tool).length).toBe(1);
    // PROPERTY: ledger-backed resolution — 0 matches.
    expect(resolvableProviderIds(providers).filter((id) => id === ghost.tool)).toEqual([]);
    // ...and the honest providers are untouched, so this is not "everything broke".
    expect(resolvableProviderIds(providers)).toEqual(resolvableProviderIds());

    const seeded = catalogWith({ 'seeded.ghost-weld': capabilityNaming(ghost.tool) });
    const verdict = validateRegistrationWelds(seeded, providers);
    expect(verdict.ok).toBe(false);

    const codes = verdict.diagnostics.map((d) => d.code);
    expect(codes).toContain(UNRESOLVABLE_PROVIDER_CODE);
    // The CAUSE is reported too, delegated to `validateEffectProviders` rather than re-derived.
    expect(codes).toContain(PROVIDER_REGISTRY_DRIFT_CODE);
    const drift = verdict.diagnostics.filter((d) => d.code === PROVIDER_REGISTRY_DRIFT_CODE);
    expect(drift.map((d) => d.provider)).toEqual([ghost.tool]);
  });

  it('RegistrationWelds_EmptyCapabilityPopulation_FailsInsteadOfPassingClean', () => {
    // NON-EMPTY DENOMINATOR, subject side. Every substrate/judgment/etc. registration is retained,
    // so this is not "an empty table" — it is a table with zero BOOT-RESOLVABLE welds, which is
    // what a rename of the capability tier, or a moved annotation module, would look like. A
    // resolution check over an empty subject set cannot fail, so reporting clean would be a lie.
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
    // The registry side is still fine — the two vacuity guards are independent.
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.diagnostics.map((d) => d.code)).not.toContain('EMPTY_PROVIDER_REGISTRY');

    // The all-empty case (the annotation module renamed to nothing) fails too.
    expect(validateRegistrationWelds({}).diagnostics.map((d) => d.code)).toContain(
      'EMPTY_CAPABILITY_DENOMINATOR',
    );
  });

  it('RegistrationWelds_EmptyProviderRegistry_FailsInsteadOfPassingClean', () => {
    // NON-EMPTY DENOMINATOR, registry side. `EFFECT_PROVIDERS` emptied (module moved, export
    // renamed) is reported as ONE fault about the registry, not as N unresolvable welds that point
    // the operator at the annotations.
    const verdict = validateRegistrationWelds(EVENT_ANNOTATIONS, []);
    expect(verdict.ok).toBe(false);
    expect(verdict.resolvableProviderCount).toBe(0);
    expect(verdict.diagnostics.map((d) => d.code)).toContain('EMPTY_PROVIDER_REGISTRY');
    // The subject population is untouched, so the fault is unambiguously the registry's.
    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length);

    // Same for a ledger that no longer backs anything: the array is full, the resolution set is
    // empty. This is the case a raw-membership check would MISS entirely.
    const unbacked = validateRegistrationWelds(EVENT_ANNOTATIONS, EFFECT_PROVIDERS, []);
    expect(unbacked.resolvableProviderCount).toBe(0);
    expect(unbacked.diagnostics.map((d) => d.code)).toContain('EMPTY_PROVIDER_REGISTRY');
  });

  it('RegistrationWelds_PolicyTable_IsTotalAndNamesOneBootAuthority', () => {
    // POLICY IS DATA THE GATE READS. Every tier in the shipped vocabulary has a resolution
    // decision, and the decision set is derived from `EVENT_TIERS` — so a sixth tier arrives with
    // an explicit decision or not at all.
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

    // Every non-boot tier states WHY, so a future reader can tell "already unforgeable at compile
    // time" apart from "nobody got round to it".
    for (const tier of EVENT_TIERS) {
      expect(WELD_RESOLUTION_POLICY[tier].note.length).toBeGreaterThan(0);
    }

    // The ref the gate resolves is the one `weldReferenceOf` extracts — pinned at runtime, because
    // no type can prove the switch's capability arm returns `provider` rather than, say, the first
    // `consumedBy` entry. Every live capability registration is checked, not a sample.
    const capabilityTypes = liveCapabilityTypes();
    expect(capabilityTypes.length).toBeGreaterThan(0);
    for (const eventType of capabilityTypes) {
      const registration = EVENT_ANNOTATIONS[eventType];
      expect(registration).toBeDefined();
      if (registration === undefined || registration.tier !== 'capability') continue;
      expect(weldReferenceOf(registration).ref).toBe(registration.provider);
    }
  });

  it('RegistrationWelds_ResolvableIds_RequireExactlyOneBackedProviderEntry', () => {
    // "Resolves" means the id names ONE thing. Two entries claiming the same tool is an ambiguous
    // provider — `providers.ts` says exactly one is required — so the id stops resolving even
    // though both entries are individually ledger-backed.
    const first = EFFECT_PROVIDERS[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(resolvableProviderIds()).toContain(first.tool);
    const duplicated = resolvableProviderIds([...EFFECT_PROVIDERS, first]);
    expect(duplicated).not.toContain(first.tool);
    // ...and only that id is affected.
    expect(duplicated).toEqual(resolvableProviderIds().filter((id) => id !== first.tool));

    // The resolution set is derived from BOTH live modules, never listed here.
    expect(resolvableProviderIds()).toEqual(
      [...new Set(EFFECT_PROVIDERS.map((p) => p.tool))].sort(),
    );
    expect(EFFECT_OWNERSHIP.length).toBeGreaterThan(0);
  });
});

describe('StartupAssertion — the severity axis on the boot refusal', () => {
  it('StartupAssertion_BlockingSeverity_ThrowsOnAnyViolation', () => {
    // THE UNCHANGED-BEHAVIOUR PIN, and the exact line the two halves of this gate sit on. Every
    // REFERENCE-INTEGRITY code is `blocking` in the shipped table, so the set of inputs that refuse
    // startup is exactly what it was before severity was expressible; the EMISSION-COUPLING codes
    // are `observe`, so arming that comparison against a tree it disagrees with took nothing down.
    // Both sides are pinned by an exact set rather than a containment: a code moved from one half
    // to the other reddens here, which is what makes the eventual graduation a deliberate act.
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
      ].sort(),
    );
    expect(codesAt('observe')).toEqual(
      [
        EMISSION_PROVIDER_MISMATCH_CODE,
        'EMPTY_EMISSION_DENOMINATOR',
        'NARROWED_EMISSION_DENOMINATOR',
        STALE_CAPABILITY_COVER_CODE,
        'EMPTY_STALE_COVER_DENOMINATOR',
      ].sort(),
    );

    // NON-VACUOUS SEED SET: one input per code, and the codes come from the same table asserted
    // above — so a code that no seed exercises is a hole this loop reports rather than skips.
    expect(DIAGNOSTIC_SEEDS.map((s) => s.code).sort()).toEqual([...shippedCodes].sort());

    const blockingSeeds = DIAGNOSTIC_SEEDS.filter(
      (seed) => DIAGNOSTIC_SEVERITY_POLICY[seed.code] === 'blocking',
    );
    expect(blockingSeeds.map((s) => s.code).sort()).toEqual(codesAt('blocking'));

    for (const seed of blockingSeeds) {
      // The pure verdict first: the diagnostic fires, it is stamped `blocking`, and the boot
      // decision follows from the stamp rather than from "the list is non-empty".
      const verdict = validateRegistrationWelds(
        seed.annotations,
        seed.providers,
        seed.rules,
        WELD_RESOLUTION_POLICY,
        DIAGNOSTIC_SEVERITY_POLICY,
        seed.emissions,
      );
      const matching = verdict.diagnostics.filter((d) => d.code === seed.code);
      expect(matching.length).toBeGreaterThan(0);
      for (const diagnostic of matching) expect(diagnostic.severity).toBe('blocking');
      expect(verdict.ok).toBe(false);
      expect(verdict.bootable).toBe(false);
      expect(verdict.blockingCount).toBe(verdict.diagnostics.length);
      expect(verdict.observeCount).toBe(0);
      // The report still reads as a refusal, and the fault count is the blocking count.
      expect(verdict.report).toContain('event registration weld resolution FAILED');
      expect(verdict.report).toContain(`${verdict.blockingCount} fault(s)`);
      expect(verdict.report).not.toContain('observe-only');

      // ...and the gate ACTUALLY REFUSES. A sink is supplied so a gate that reported instead of
      // throwing would be caught here rather than passing as "it did something".
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
        ),
      ).toThrow(RegistrationWeldError);
      expect(reported).toEqual([]);
    }
  });

  it('StartupAssertion_ObserveSeverity_ReportsWithoutThrowing', () => {
    // THE OTHER ARM, over the same six inputs — including the two whose shipped severity is
    // already `observe`, so this loop covers every code the gate can emit rather than only the
    // refusable ones. Identical populations, one row-set flipped: the gate must now RETURN and
    // report rather than refuse. Running it over the same seeds as the blocking test is what makes
    // the pair evidence — each input is shown to be refusable AND survivable purely as a function
    // of the severity table.
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
      );

      // Found something, and said so — but did not stop the process.
      const matching = verdict.diagnostics.filter((d) => d.code === seed.code);
      expect(matching.length).toBeGreaterThan(0);
      for (const diagnostic of matching) expect(diagnostic.severity).toBe('observe');
      expect(verdict.bootable).toBe(true);
      expect(verdict.blockingCount).toBe(0);
      expect(verdict.observeCount).toBe(verdict.diagnostics.length);

      // `ok` is NOT weakened by the flip. An observation is still a finding, so the clean-tree
      // signal stays false — only the boot decision moved.
      expect(verdict.ok).toBe(false);

      // REPORTED, exactly once, with the fault in it. An observation nobody is told about is
      // indistinguishable from a check that never ran.
      expect(reported).toHaveLength(1);
      const message = reported[0] ?? '';
      expect(message).toBe(verdict.report);
      expect(message).toContain('observe-only');
      expect(message).toContain(`${verdict.observeCount} finding(s)`);
      expect(message).toContain(seed.code);
      expect(message).not.toContain('FAILED');
      // The denominators still ride the report, so an observation cannot be read without the
      // population it was measured over.
      expect(message).toContain(`${verdict.bootResolvedCount} boot-resolved weld(s)`);
      expect(message).toContain(`${verdict.resolvableProviderCount} live provider(s)`);
    }
  });

  it('StartupAssertion_ObserveSeverity_StaysSilentOnACleanTree', () => {
    // THE ANTI-TAUTOLOGY for the test above. With everything set to `observe`, a gate that
    // reported unconditionally would still satisfy "does not throw" — so a clean tree must produce
    // NO report at all.
    //
    // "Clean" now means the live catalog against a CONFORMING emission population, because the
    // shipped registry genuinely disagrees with the annotations in places. Substituting only that
    // one population is what keeps this a control rather than a second measurement: every other
    // input is the live module, and the finding it removes is the one under test elsewhere.
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
    // ...over a non-empty population, so "nothing to report" is not "nothing to look at".
    expect(verdict.bootResolvedCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThan(0);
  });

  it('StartupAssertion_MixedSeverities_RefusesOnTheBlockingOneAndStillNamesTheObservation', () => {
    // The case the flip to blocking will actually walk through: one fault of each severity in the
    // same verdict. `bootable` must follow the BLOCKING one — a severity axis that let an
    // observation dilute a refusal would be worse than no axis at all — while the observation is
    // still carried, so the operator is not shown half the picture.
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
    // Both halves are in the one report: the refusal names the blocking fault, and the trailing
    // block names the observation rather than dropping it.
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
  it('ProviderComparison_DeclaringToolMatchesProvider_IsConforming', () => {
    // HALF ONE, on the LIVE registry. Partition the shipped emission edges into the ones that agree
    // with the annotation table and the ones that do not, computing the partition here from the two
    // authorities directly rather than from the gate's own output — otherwise this would be the
    // gate agreeing with itself.
    const declaredProviderByEvent = new Map(
      liveCapabilityRegistrations().map((row) => [row.eventType, row.provider]),
    );
    const comparedEdges = declaredEmissionEdges().filter((edge) =>
      declaredProviderByEvent.has(edge.event),
    );
    const agreeing = comparedEdges.filter(
      (edge) => declaredProviderByEvent.get(edge.event) === edge.declaringTool,
    );
    // NON-VACUOUS: if the shipped tree agreed nowhere, "no diagnostic for an agreeing edge" would
    // be true because there are none, which is the failure mode this number rules out.
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

    // HALF TWO, the clean control. Hold every other population live and substitute an emission set
    // that agrees EVERYWHERE, and the comparison reports nothing at all — so the findings above are
    // caused by disagreement and not by the comparison firing on every edge it sees.
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
    // ...over a compared set the same size as the capability tier, so the clean verdict is a
    // measurement over every weld rather than over an empty set.
    expect(conforming.comparedEmissionEdgeCount).toBe(CONFORMING_EMISSIONS.length);
    expect(conforming.comparedEmissionEdgeCount).toBe(liveCapabilityTypes().length);
  });

  it('ProviderComparison_Disagreement_NamesBothSides', () => {
    // ONE seeded disagreement over an otherwise conforming population, so the diagnostic under
    // inspection is unambiguously this edge's. Both ends of the seed are read off live modules: the
    // event and its DECLARED provider from the annotation table, the DECLARING tool from the
    // effect-provider map.
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

    // BOTH SIDES, STRUCTURALLY. A diagnostic that only proved a disagreement was detected would
    // leave an operator to run the gate again to find out which two things disagreed, so all four
    // — the event, the declared provider, the declaring tool and the action — ride the record.
    expect(mismatch.eventType).toBe(edge.event);
    expect(mismatch.provider).toBe(declaredProvider);
    expect(mismatch.declaringTool).toBe(edge.declaringTool);
    expect(mismatch.action).toBe(edge.action);
    expect(mismatch.declaringTool).not.toBe(mismatch.provider);

    // BOTH SIDES, IN THE PROSE. The structured fields are what a tool reads; the message is what a
    // human reads out of a boot log, and it has to carry the same four.
    expect(mismatch.message).toContain(edge.event);
    expect(mismatch.message).toContain(edge.action);
    expect(mismatch.message).toContain(edge.declaringTool);
    expect(mismatch.message).toContain(declaredProvider ?? '<undeclared>');

    // OBSERVE, not blocking: the finding is reported and the tree still boots. Severity comes from
    // the shipped table rather than from anything decided at the emission site.
    expect(mismatch.severity).toBe('observe');
    expect(DIAGNOSTIC_SEVERITY_POLICY[EMISSION_PROVIDER_MISMATCH_CODE]).toBe('observe');
    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);
    expect(verdict.ok).toBe(false);

    // ...and it reaches an operator through the EXISTING startup assertion — no second entry point.
    const reported: string[] = [];
    const returned = assertRegistrationWeldsAtStartup(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      (message) => reported.push(message),
      [...CONFORMING_EMISSIONS, edge],
    );
    expect(returned.bootable).toBe(true);
    expect(reported).toHaveLength(1);
    const message = reported[0] ?? '';
    expect(message).toContain(edge.event);
    expect(message).toContain(edge.action);
    expect(message).toContain(edge.declaringTool);
    expect(message).toContain(declaredProvider ?? '<undeclared>');
  });

  it('ProviderComparison_NothingEmitsABootResolvableEvent_FailsInsteadOfPassingClean', () => {
    // NON-EMPTY DENOMINATOR, emission side. The welds are all there and the provider map is
    // healthy; what is missing is any declared edge naming one of those events, so the comparison
    // ranged over nothing and cannot have found anything. Reporting clean would be a lie of exactly
    // the shape the other two EMPTY_* codes already refuse to tell.
    const verdict = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      [],
    );
    expect(verdict.comparedEmissionEdgeCount).toBe(0);
    expect(verdict.ok).toBe(false);
    // The other two populations are untouched, so the fault is unambiguously the emission set's.
    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);

    // EXACTLY ONE vacuity code fires, and it is the emission side's. Pinned as a filtered list
    // rather than as the whole diagnostic list because withdrawing every edge also leaves every
    // eligible weld named by nothing — which is a TRUE second reading of this population, not
    // noise, and it is asserted by count immediately below rather than swept under a containment.
    const emptyCodes = verdict.diagnostics
      .map((d) => d.code)
      .filter((code) => code.startsWith('EMPTY_') || code === 'NARROWED_EMISSION_DENOMINATOR');
    expect(emptyCodes).toEqual(['EMPTY_EMISSION_DENOMINATOR']);
    expect(new Set(verdict.diagnostics.map((d) => d.code))).toEqual(
      new Set(['EMPTY_EMISSION_DENOMINATOR', STALE_CAPABILITY_COVER_CODE]),
    );
    expect(
      verdict.diagnostics.filter((d) => d.code === STALE_CAPABILITY_COVER_CODE),
    ).toHaveLength(verdict.staleCoverEligibleCount);
    expect(verdict.staleCoverEligibleCount).toBeGreaterThan(0);

    // An emission population that is non-empty but names only events this gate does not resolve is
    // the SAME vacuity wearing a different face, and is caught the same way.
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

    // ...and it does NOT restate EMPTY_CAPABILITY_DENOMINATOR: with the subject side emptied, the
    // gate names the subject side as the cause and stays quiet about the emission set.
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

  it('ProviderComparison_EmissionEdges_AreReadOffTheLiveToolRegistry', () => {
    // The population is DERIVED, never transcribed. Every edge names an action that really is
    // registered under the tool it claims, computed here by walking the registry a second time
    // rather than by trusting the function under test.
    const edges = declaredEmissionEdges();
    expect(edges.length).toBeGreaterThan(0);

    const toolByAction = new Map<string, string>();
    let declaredEmissionCount = 0;
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        toolByAction.set(`${tool.name}|${action.name}`, tool.name);
        declaredEmissionCount += action.autoEmits?.length ?? 0;
      }
    }
    expect(edges.length).toBe(declaredEmissionCount);
    for (const edge of edges) {
      expect(toolByAction.get(`${edge.declaringTool}|${edge.action}`)).toBe(edge.declaringTool);
    }

    // Every declaring tool is a live composite tool name — the SAME id space `EffectProviderId`
    // draws from, which is the only reason the two sides are comparable at all.
    const toolNames = new Set(TOOL_REGISTRY.map((tool) => tool.name));
    expect([...new Set(edges.map((e) => e.declaringTool))].filter((t) => !toolNames.has(t))).toEqual(
      [],
    );

    // Injectable, so the comparison can be exercised on a population that is not the live one.
    expect(declaredEmissionEdges([])).toEqual([]);
  });
});

describe('ComparisonDenominator — the size of the set the provider comparison ranges over', () => {
  /**
   * The intersection, walked from the two LIVE authorities directly: the annotation table says
   * which events carry a boot-resolvable weld, the tool registry says which actions declare an
   * emission. Deliberately not routed through `declaredEmissionEdges`, which is part of the
   * subject — a denominator read back out of the thing under test agrees with it by construction
   * and could not report a narrowing in either of them.
   */
  function liveIntersectionSize(): number {
    const welded = new Set(liveCapabilityTypes());
    let size = 0;
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        for (const emission of action.autoEmits ?? []) {
          if (welded.has(emission.event)) size += 1;
        }
      }
    }
    return size;
  }

  /** Declared edges naming events this gate does not resolve — real, and never compared. */
  function offTierEmissionEdges(): readonly EmissionEdge[] {
    const welded = new Set(liveCapabilityTypes());
    return declaredEmissionEdges().filter((edge) => !welded.has(edge.event));
  }

  it('ComparisonDenominator_LiveIntersection_IsNonEmptyAtMeasuredSize', () => {
    const intersection = liveIntersectionSize();
    const verdict = validateRegistrationWelds();

    // OBSERVABLE, NOT INFERRED. The verdict's own number is the measured one, so the denominator
    // can be read off a boot rather than reconstructed by whoever is suspicious of it. Without
    // this equality the count could be anything the gate cared to publish.
    expect(verdict.comparedEmissionEdgeCount).toBe(intersection);

    // NON-EMPTY — and so is the floor, which matters more than it looks: a floor of zero is a
    // ratchet that ratchets nothing, satisfied by every population including the empty one.
    expect(intersection).toBeGreaterThan(0);
    expect(EMISSION_DENOMINATOR_FLOOR).toBeGreaterThan(0);

    // AT ITS MEASURED SIZE, one-directionally, and the direction is the whole design. `>=` rather
    // than `===` because widening this set is the ordinary direction of travel — every capability
    // event something declares it emits adds to it — and a check that reddened on growth would
    // punish exactly the work it exists to protect. Shrinkage is the defect; the seeded-shrink
    // test below runs this same expectation against a smaller population and shows it throw.
    expect(intersection).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);

    // ...and the floor is not set ABOVE the live tree. A ratchet that is always tripped reports a
    // narrowing that is not happening, and would be tuned out within a week.
    expect(verdict.diagnostics.map((d) => d.code)).not.toContain('NARROWED_EMISSION_DENOMINATOR');

    // The intersection is a STRICT subset of the declared population: most emission edges name
    // events registered at a tier this gate does not resolve. Two numbers that had converged would
    // mean the comparison had quietly widened past the capability arm — the opposite drift, hidden
    // by the same unpinned denominator.
    expect(verdict.emissionEdgeCount).toBeGreaterThan(0);
    expect(intersection).toBeLessThan(verdict.emissionEdgeCount);
  });

  it('ComparisonDenominator_SeededShrink_FailsRatherThanPassingClean', () => {
    // THE KILL FIXTURE FOR THE FLOOR. Every population except the emission set is the live module.
    // The emission set keeps every declared edge whose event this gate does NOT resolve, and keeps
    // only a handful of the ones it does — so nothing is empty, nothing disagrees, and the single
    // variable is the SIZE of the set the comparison ranges over.
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

    // Non-empty on every axis a vacuity guard can see...
    expect(verdict.bootResolvedCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.emissionEdgeCount).toBeGreaterThan(0);
    expect(verdict.comparedEmissionEdgeCount).toBe(kept.length);
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThan(0);

    // ...so the existing guards are SATISFIED, which is the entire reason this case needs its own.
    // The zero case belongs to EMPTY_EMISSION_DENOMINATOR and cannot see a set of three; the
    // subject side is intact, so the capability guard has nothing to say; and every kept edge
    // agrees with its annotation, so a gate that only reported mismatches would call this clean.
    const codes = verdict.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('EMPTY_EMISSION_DENOMINATOR');
    expect(codes).not.toContain('EMPTY_CAPABILITY_DENOMINATOR');
    expect(codes).not.toContain(EMISSION_PROVIDER_MISMATCH_CODE);

    // THE ASSERTION REDDENS — not "a diagnostic appeared", but the very expectation the live test
    // makes, run against this population and shown to throw. An assertion whose operator can never
    // fail is the failure mode a floor is most likely to ship with.
    expect(() =>
      expect(verdict.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR),
    ).toThrow();

    // ...and the GATE says so too, so the property does not live only in this file. The finding
    // sizes the shortfall — how far it reached and how far it should have — rather than making an
    // operator import a constant to work out how bad it is.
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

    // OBSERVE, not blocking. A floor that refused startup would turn any legitimate re-tiering of
    // a capability event into an unbootable tree for every entry point at once — worse than the
    // narrowing it watches for.
    expect(finding.severity).toBe('observe');
    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);

    // THE CONTROL, and the reason any of the above is evidence: put the removed edges back and the
    // identical call is clean. The finding is caused by the shrink, not by the fixture.
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

    // ...and the two denominator faults stay DISJOINT. Drop the compared edges entirely and the
    // empty case fires ALONE — the floor does not ride along to report the same thing twice, which
    // is what it would do if it were a restatement of the vacuity guard rather than its complement.
    const emptied = validateRegistrationWelds(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      offTier,
    );
    expect(emptied.comparedEmissionEdgeCount).toBe(0);
    // Filtered to the two DENOMINATOR codes, which is what this arm is about: the stale-cover
    // findings that also appear are a true reading of a population nothing names, and pinning the
    // whole list here would make this assertion about them instead of about the disjointness.
    expect(
      emptied.diagnostics
        .map((d) => d.code)
        .filter((code) => code === 'EMPTY_EMISSION_DENOMINATOR' || code === 'NARROWED_EMISSION_DENOMINATOR'),
    ).toEqual(['EMPTY_EMISSION_DENOMINATOR']);
  });
});

describe('ProviderBreakSet — every reported disagreement is answered for', () => {
  /**
   * An emission edge that disagrees and that NO ledger row covers.
   *
   * Both ends come off live modules — a real capability event with the provider its own
   * registration declares, and a real composite tool that is not that provider — so what is seeded
   * is a genuine two-authority disagreement rather than a string nobody would write. Only the action
   * name is fabricated, and that is the point: it is what makes the edge one the ledger has never
   * seen. Throws rather than degrading into "no seed", because a falsifier that quietly stops
   * falsifying is the way this kind of test ships green forever.
   */
  function unlistedDisagreement(): EmissionEdge {
    const seed = disagreeingEmissionEdge();
    const covered = PROVIDER_DISAGREEMENT_DISPOSITIONS.some(
      (row) => row.event === seed.event && row.action === seed.action,
    );
    if (covered) throw new Error('the seeded disagreement is already in the ledger');
    return seed;
  }

  /** The provider the LIVE catalog declares for a capability event. Throws rather than guessing. */
  function liveProviderOf(eventType: string): string {
    const registration = EVENT_ANNOTATIONS[eventType];
    if (registration === undefined || registration.tier !== 'capability') {
      throw new Error(`'${eventType}' carries no live capability registration`);
    }
    return registration.provider;
  }

  /** The live comparison with `extra` merged into the declared emission population. */
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

  it('ProviderBreakSet_EveryDisagreementIsDispositioned', () => {
    const live = validateRegistrationWelds();

    // THE DENOMINATOR THIS RESTS ON, asserted before anything is read off it. A ledger reconciled
    // against a comparison that has quietly stopped comparing would report a clean sweep of nothing
    // — so the compared set is pinned at its measured floor first, and the reconciliation below is
    // only evidence because this held.
    expect(live.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);
    expect(live.diagnostics.map((d) => d.code)).not.toContain('NARROWED_EMISSION_DENOMINATOR');
    expect(live.diagnostics.map((d) => d.code)).not.toContain('EMPTY_EMISSION_DENOMINATOR');

    // DERIVED, not typed. The subject is what the gate reports over the shipped catalog; nothing in
    // this test writes down an event name, so a disagreement that appears or disappears changes the
    // subject rather than leaving a stale literal being checked against itself.
    const reported = reportedDisagreements(live);
    const audit = auditDisagreementDispositions(reported);

    // BOTH DIRECTIONS CLEAN: no reported edge is unanswered, and no row answers for an edge the
    // comparison no longer reports. `toEqual([])` rather than a length check so a failure prints
    // the offending identity and its remedy instead of a number.
    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);

    // The two populations are the same size, which is only true because the match is exact on all
    // four sides in both directions — a ledger that over- or under-covered would trip an arm above
    // and this equality would follow it.
    expect(audit.reportedCount).toBe(reported.length);
    expect(audit.dispositionedCount).toBe(PROVIDER_DISAGREEMENT_DISPOSITIONS.length);
    expect(audit.reportedCount).toBe(audit.dispositionedCount);

    // Every row carries a REASON, not just a verdict. A classification with no rationale would let
    // "somebody decided" stand in for "somebody worked it out", which is the state this ledger
    // exists to end — and a blank string satisfies the type.
    for (const row of PROVIDER_DISAGREEMENT_DISPOSITIONS) {
      expect(['genuine-mismatch', 'annotation-error']).toContain(row.classification);
      expect(row.rationale.trim().length).toBeGreaterThan(0);
      // The row is about a disagreement, so the two sides must actually differ. A row whose two
      // tool ids matched would be answering for an edge the comparison could never report.
      expect(row.declaringTool).not.toBe(row.declaredProvider);
      // ...and the provider it names is the one the LIVE catalog declares, so a row cannot drift
      // into dispositioning a disagreement the annotation table has stopped making.
      const registration = EVENT_ANNOTATIONS[row.event];
      expect(registration).toBeDefined();
      expect(registration?.tier).toBe('capability');
      if (registration?.tier === 'capability') {
        expect(registration.provider).toBe(row.declaredProvider);
      }
    }

    // BOTH CLASSIFICATIONS ARE IN USE. The distinction is the substance of this ledger — a break set
    // where every row said the same thing would mean nobody had separated "the vocabulary cannot
    // name the truth" from "the annotation is wrong", which are opposite conclusions with opposite
    // remedies.
    const classifications = new Set(
      PROVIDER_DISAGREEMENT_DISPOSITIONS.map((row) => row.classification),
    );
    expect([...classifications].sort()).toEqual(['annotation-error', 'genuine-mismatch']);
  });

  it('ProviderBreakSet_UndispositionedEntry_Fails', () => {
    // THE CONTROL FIRST, so everything below is attributable to the seed rather than to the fixture.
    const control = auditDisagreementDispositions(reportedDisagreements(liveVerdictPlus([])));
    expect(control.diagnostics).toEqual([]);
    expect(control.ok).toBe(true);

    // ── ARM ONE: a NEW disagreement arrives and nobody has looked at it ─────────────────────────
    const seed = unlistedDisagreement();
    const seeded = liveVerdictPlus([seed]);

    // The gate still only OBSERVES it, exactly as before — the seed changes nothing about boot, so
    // a tree carrying an unanswered disagreement is indistinguishable from a clean one to every
    // check that existed before this ledger. That is the hole being closed.
    expect(seeded.bootable).toBe(true);
    expect(seeded.blockingCount).toBe(0);

    const seededReport = reportedDisagreements(seeded);
    expect(seededReport.length).toBe(control.reportedCount + 1);

    const seededAudit = auditDisagreementDispositions(seededReport);

    // ...and the reconciliation REDDENS. Not "a diagnostic exists somewhere" — exactly one, naming
    // the seeded edge by all four sides, with every pre-existing entry still answered for.
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
    // The message tells the reader what to do, and names both classifications — a finding that only
    // said "undispositioned" would send whoever hits it back to this file to work out what a
    // disposition even is.
    expect(finding.message).toContain(seed.event);
    expect(finding.message).toContain(seed.action);
    expect(finding.message).toContain('genuine-mismatch');
    expect(finding.message).toContain('annotation-error');

    // ── ARM TWO: the ledger stops covering an entry that is still reported ──────────────────────
    // The complementary failure, and the one a ledger drifts into rather than arrives at: nothing
    // about the tree changes, a row is simply dropped. Same denominator, same comparison, one fewer
    // answer — and the audit must notice.
    const dropped = PROVIDER_DISAGREEMENT_DISPOSITIONS[0];
    expect(dropped).toBeDefined();
    if (dropped === undefined) return;
    const thinned = auditDisagreementDispositions(
      reportedDisagreements(liveVerdictPlus([])),
      PROVIDER_DISAGREEMENT_DISPOSITIONS.slice(1),
    );
    expect(thinned.ok).toBe(false);
    expect(thinned.diagnostics.map((d) => d.code)).toEqual(['UNDISPOSITIONED_DISAGREEMENT']);
    expect(thinned.diagnostics[0]?.identity).toEqual({
      event: dropped.event,
      action: dropped.action,
      declaredProvider: dropped.declaredProvider,
      declaringTool: dropped.declaringTool,
    });
  });

  it('ProviderBreakSet_RowCoveringNothing_IsReportedStale', () => {
    // THE OTHER HALF OF THE RATCHET. A row whose subject is gone reads exactly like a healthy one
    // from inside the table — same shape, same reasoning, still counted in `dispositionedCount` —
    // so nothing but this arm can tell the two apart. Without it the ledger could be repaired into
    // permanent agreement by leaving rows behind after the disagreements they answered for were
    // fixed, and the coverage check above would keep passing over a table that had stopped
    // describing the tree.
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

    // The count still says nine, which is the whole reason the arm is needed: a table can grow
    // while covering less.
    expect(audit.dispositionedCount).toBe(PROVIDER_DISAGREEMENT_DISPOSITIONS.length + 1);
    expect(audit.reportedCount).toBe(PROVIDER_DISAGREEMENT_DISPOSITIONS.length);
  });

  it('ProviderBreakSet_MatchIsOnAllFourSides_NotTheEventAlone', () => {
    // WHY THE KEY IS FOUR-WIDE. The break set has five separate edges on ONE event, so a ledger
    // keyed on the event would answer for a sixth the moment it appeared — a new action wired to an
    // already-dispositioned event would arrive pre-approved by a row written before it existed.
    const byEvent = new Map<string, number>();
    for (const row of PROVIDER_DISAGREEMENT_DISPOSITIONS) {
      byEvent.set(row.event, (byEvent.get(row.event) ?? 0) + 1);
    }
    expect(Math.max(...byEvent.values())).toBeGreaterThan(1);

    // Take a covered row, move ONE side, and the audit refuses to recognise it — proof that the
    // other three sides did not carry the match on their own.
    const covered = PROVIDER_DISAGREEMENT_DISPOSITIONS[0];
    expect(covered).toBeDefined();
    if (covered === undefined) return;
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

describe('StaleCover — a capability weld that nothing declares it emits', () => {
  /**
   * A structurally valid `capability` registration at a chosen lifecycle, naming a provider that
   * really resolves.
   *
   * Everything except `lifecycle` is fixed, which is the whole design of the exclusion test below:
   * two registrations built by this function differ in exactly one field, so a difference in how
   * the gate treats them cannot be attributed to anything else.
   */
  function capabilityAt(lifecycle: EventLifecycle, provider: string): EventRegistration {
    return { lifecycle, tier: 'capability', provider, consumedBy: ['workflow-state@v1'] };
  }

  /** A provider id that genuinely resolves, so a seeded weld cannot fail for the wrong reason. */
  function aResolvableProvider(): string {
    const provider = resolvableProviderIds()[0];
    if (provider === undefined) throw new Error('no resolvable provider to seed a weld with');
    return provider;
  }

  /** The live verdict with one population substituted, every other input left at the live module. */
  function verdictOver(
    annotations: Readonly<Record<string, EventRegistration>>,
    emissions: readonly EmissionEdge[],
    lifecyclePolicy: Readonly<
      Record<EventLifecycle, StaleCoverEligibility>
    > = STALE_COVER_LIFECYCLE_POLICY,
  ): WeldResolutionVerdict {
    return validateRegistrationWelds(
      annotations,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      emissions,
      lifecyclePolicy,
    );
  }

  /** The stale-cover findings in a verdict, narrowed off the union so their fields are readable. */
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

  it('StaleCover_ActiveWeldNamedByNoEdge_FailsAsStale', () => {
    // THE CONTROL FIRST, so every finding below is attributable to the seed and not to the fixture.
    // An emission population that names every capability registration reports nothing at all —
    // which also pins that this check is not simply firing on whatever it is handed.
    const control = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS);
    expect(control.diagnostics).toEqual([]);
    expect(control.ok).toBe(true);
    expect(control.staleCoverEligibleCount).toBeGreaterThan(0);

    // THE SEED: withdraw the ONE edge that named an active capability event. The registration is
    // untouched — same tier, same provider, same consumer, same lifecycle — so the single variable
    // is whether anything in the tool registry claims to emit it.
    const registration = EVENT_ANNOTATIONS[STALE_COVER_SEED_EVENT];
    expect(registration).toBeDefined();
    expect(registration?.tier).toBe('capability');
    expect(registration?.lifecycle).toBe('active');
    expect(CONFORMING_EMISSIONS_MINUS_ONE).toHaveLength(CONFORMING_EMISSIONS.length - 1);

    const verdict = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS_MINUS_ONE);

    // EVERY OTHER CHECK IN THIS GATE IS SATISFIED, which is exactly why this one has to exist. The
    // weld resolves, no edge disagrees, the compared set is one short of the whole capability arm
    // and therefore still above its floor, and neither vacuity guard has anything to say. A tree
    // carrying this fault is indistinguishable from a clean one to everything that shipped before.
    const codes = verdict.diagnostics.map((d) => d.code);
    expect(codes).not.toContain(UNRESOLVABLE_PROVIDER_CODE);
    expect(codes).not.toContain(EMISSION_PROVIDER_MISMATCH_CODE);
    expect(codes).not.toContain('EMPTY_EMISSION_DENOMINATOR');
    expect(codes).not.toContain('NARROWED_EMISSION_DENOMINATOR');
    expect(codes).not.toContain('EMPTY_STALE_COVER_DENOMINATOR');
    expect(verdict.comparedEmissionEdgeCount).toBeGreaterThanOrEqual(EMISSION_DENOMINATOR_FLOOR);

    // ...and the gate REDDENS, naming exactly the one event whose edge was withdrawn.
    const stale = staleFindings(verdict);
    expect(stale.map((d) => d.eventType)).toEqual([STALE_COVER_SEED_EVENT]);
    const finding = stale[0];
    expect(finding).toBeDefined();
    if (finding === undefined) return;

    // The finding names the cover it is reporting — the provider the registration declares — and
    // the lifecycle that admitted it, so a reader can tell a genuine stale weld from an exclusion
    // axis that has stopped working without going back to the catalog.
    if (registration !== undefined && registration.tier === 'capability') {
      expect(finding.provider).toBe(registration.provider);
    }
    expect(finding.lifecycle).toBe('active');
    expect(finding.message).toContain(STALE_COVER_SEED_EVENT);
    expect(finding.message).toContain(finding.provider);
    expect(finding.message).toContain('autoEmits');

    // OBSERVE, not blocking. The shipped catalog carries a measured break set, so refusing every
    // entry point over it would be a worse gate than none — the severity comes from the table.
    expect(DIAGNOSTIC_SEVERITY_POLICY[STALE_CAPABILITY_COVER_CODE]).toBe('observe');
    expect(verdict.ok).toBe(false);
    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);
    expect(verdict.observeCount).toBe(verdict.diagnostics.length);

    // ...and it reaches an operator through the EXISTING startup assertion — no second entry point.
    const reported: string[] = [];
    const returned = assertRegistrationWeldsAtStartup(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      DIAGNOSTIC_SEVERITY_POLICY,
      (message) => reported.push(message),
      CONFORMING_EMISSIONS_MINUS_ONE,
    );
    expect(returned.bootable).toBe(true);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(STALE_CAPABILITY_COVER_CODE);
    expect(reported[0]).toContain(STALE_COVER_SEED_EVENT);

    // THE RESTORING CONTROL: put the edge back and the identical call is clean again, so the
    // finding is caused by the withdrawn emission and not by anything else in this fixture.
    expect(verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS).diagnostics).toEqual([]);
  });

  it('StaleCover_PlannedOrRetired_IsExcludedByLifecycle', () => {
    // THREE REGISTRATIONS THAT DIFFER IN ONE FIELD. Same tier, same resolvable provider, same
    // consumer tuple; only the lifecycle moves. None of the three is named by any edge in the
    // conforming population, so a check that ignored lifecycle would report all three — which is
    // what makes "only the active one is eligible" an attributable result rather than a coincidence
    // of which events happen to be emitted.
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
    // ...and the two that were spared were spared by the LIFECYCLE, not by resolving differently:
    // all three welds are in the boot-resolved population and none of them is unresolvable.
    expect(bootResolvedWelds(seeded).map((w) => w.eventType)).toEqual(
      expect.arrayContaining(seededTypes),
    );
    expect(verdict.diagnostics.map((d) => d.code)).not.toContain(UNRESOLVABLE_PROVIDER_CODE);
    // The eligible population grew by exactly the ONE active seed, so the exclusion is arithmetic
    // rather than a filter that quietly dropped all three.
    expect(verdict.staleCoverEligibleCount).toBe(unseeded.staleCoverEligibleCount + 1);

    // THE EXCLUSION IS READ OFF THE TABLE, not off a literal. Flip the `retired` row to eligible and
    // the retired seed becomes stale cover on an otherwise identical call — which a gate comparing
    // `lifecycle === 'active'` inline could not do. `planned` stays excluded, so the two rows are
    // independently keyed and one flip does not open the axis.
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
    // The flipped finding carries the lifecycle that admitted it, so a table edit is visible in the
    // fault rather than only in the count.
    const retiredFinding = staleFindings(flipped).find(
      (d) => d.eventType === 'seeded.stale-retired',
    );
    expect(retiredFinding?.lifecycle).toBe('retired');

    // THE POLICY IS TOTAL OVER THE AXIS, and the axis is the shipped vocabulary — so a fourth
    // lifecycle state cannot arrive with no eligibility decision and be admitted (or skipped) by
    // whatever the lookup happens to produce. This is the runtime half of the exclusion being
    // STRUCTURAL rather than a list somebody keeps up to date.
    expect(Object.keys(STALE_COVER_LIFECYCLE_POLICY).sort()).toEqual([...EVENT_LIFECYCLES].sort());
    const eligibleStates = EVENT_LIFECYCLES.filter(
      (lifecycle) => STALE_COVER_LIFECYCLE_POLICY[lifecycle].eligible,
    );
    expect(eligibleStates).toEqual(['active']);
    // Every excluded row says WHY, in both a machine-readable half and a prose half. A bare `false`
    // would record the same decision with none of the reasoning a future reader needs to judge it.
    for (const lifecycle of EVENT_LIFECYCLES) {
      const row = STALE_COVER_LIFECYCLE_POLICY[lifecycle];
      expect(row.note.trim().length).toBeGreaterThan(0);
      if (!row.eligible) expect(['not-yet', 'not-any-more']).toContain(row.unemitted);
    }

    // ...and the same exclusion is observable one level down, on the exported filter, so the
    // property does not live only inside the gate's private wiring.
    const welds = bootResolvedWelds(seeded);
    const eligible = staleCoverEligibleWelds(welds).map((w) => w.eventType);
    expect(eligible).toContain('seeded.stale-active');
    expect(eligible).not.toContain('seeded.stale-planned');
    expect(eligible).not.toContain('seeded.stale-retired');
    expect(staleCoverEligibleWelds(welds, retiredIsEligible).map((w) => w.eventType)).toContain(
      'seeded.stale-retired',
    );
  });

  it('StaleCover_EmptyEligiblePopulation_FailsInsteadOfPassingClean', () => {
    // THE VACUITY GUARD. A check that finds nothing because it is looking at nothing publishes
    // exactly the shape of one that finds nothing because the tree is clean — same verdict fields,
    // same absence of findings — so an empty eligible population must be a FAULT.
    //
    // Reached by retiring every capability registration rather than by deleting them: the weld
    // population is untouched and healthy, and the lifecycle axis is the only thing that emptied
    // the subject set. That is the case EMPTY_CAPABILITY_DENOMINATOR structurally cannot see.
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
    // The finding SIZES what was excluded, so a reader can tell "everything was retired" from
    // "there were no welds" without a second run.
    expect(finding.excludedByLifecycle).toBe(verdict.bootResolvedCount);
    expect(finding.message).toContain(`${verdict.bootResolvedCount}`);
    expect(finding.severity).toBe('observe');

    // It does NOT restate the capability guard: the subject side is intact, so that code has
    // nothing to say and the two faults stay disjoint by construction rather than by convention.
    expect(verdict.diagnostics.map((d) => d.code)).not.toContain('EMPTY_CAPABILITY_DENOMINATOR');
    // ...and no per-event finding rides along, because there is no eligible event to report on.
    expect(staleFindings(verdict)).toEqual([]);

    // THE OTHER ROUTE TO ZERO still fails too, through the code that owns it — so "the eligible
    // population is zero" is a failing run either way, which is the property this test is really
    // about. Here the welds themselves are gone, so the capability guard is the honest cause.
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

    // THE ANTI-TAUTOLOGY: the same call over the live catalog has a non-empty eligible population
    // and reports neither guard, so the two above are caused by their seeds.
    const live = verdictOver(EVENT_ANNOTATIONS, CONFORMING_EMISSIONS);
    expect(live.staleCoverEligibleCount).toBeGreaterThan(0);
    expect(live.diagnostics).toEqual([]);
  });

  it('StaleCover_LiveCatalog_ReportsTheEligibleCountBesideTheVerdict', () => {
    const verdict = validateRegistrationWelds();

    // THE DENOMINATOR, RE-DERIVED. Walked straight out of the annotation table rather than read
    // back off the gate, so this is a reconciliation of two counts and not the gate agreeing with
    // itself about how wide it looked.
    const capability = capabilityRegistrationsIn(EVENT_ANNOTATIONS);
    const active = capability.filter((row) => row.lifecycle === 'active');
    expect(verdict.bootResolvedCount).toBe(capability.length);
    expect(verdict.staleCoverEligibleCount).toBe(active.length);
    expect(verdict.staleCoverEligibleCount).toBeGreaterThan(0);

    // THE EXCLUSION IS NON-VACUOUS ON THE LIVE TREE. If the lifecycle axis excluded nothing, the
    // whole exclusion arm would be untested against the shipped catalog — every test of it would
    // rest on seeded rows alone, and a break in it would show up nowhere real.
    expect(verdict.staleCoverEligibleCount).toBeLessThan(verdict.bootResolvedCount);
    const excluded = capability.filter((row) => row.lifecycle !== 'active');
    expect(excluded.length).toBeGreaterThan(0);
    for (const row of excluded) expect(['planned', 'retired']).toContain(row.lifecycle);

    // THE BREAK SET, and every member of it is active — the property the exclusion buys, asserted
    // over the shipped tree rather than over a fixture.
    const stale = staleFindings(verdict);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.length).toBeLessThanOrEqual(verdict.staleCoverEligibleCount);
    const excludedTypes = new Set(excluded.map((row) => row.eventType));
    for (const finding of stale) {
      expect(finding.lifecycle).toBe('active');
      expect(excludedTypes.has(finding.eventType)).toBe(false);
    }

    // ...and not one of them is named by ANY declared edge, computed here from the tool registry
    // directly rather than through the gate's own flattening.
    const namedByAnEdge = new Set<string>();
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        for (const emission of action.autoEmits ?? []) namedByAnEdge.add(emission.event);
      }
    }
    expect(namedByAnEdge.size).toBeGreaterThan(0);
    for (const finding of stale) expect(namedByAnEdge.has(finding.eventType)).toBe(false);
    // The complement holds too: an eligible weld that IS named produces no finding, so the check
    // is not simply reporting the whole population.
    const reportedTypes = new Set(stale.map((d) => d.eventType));
    const namedEligible = active.filter((row) => namedByAnEdge.has(row.eventType));
    expect(namedEligible.length).toBeGreaterThan(0);
    for (const row of namedEligible) expect(reportedTypes.has(row.eventType)).toBe(false);

    // THE COUNT RIDES THE REPORT, so a boot log carries the population every absence in it was
    // measured over — an absence with no denominator beside it is the thing this arm exists to
    // stop reading as success.
    expect(verdict.report).toContain(`${verdict.staleCoverEligibleCount} stale-cover eligible`);
  });
});

describe('StaleCoverBreakSet — every active unnamed weld is answered for', () => {
  /**
   * A `capability` registration that is active, resolvable, and named by NOTHING — the shape of a
   * brand-new stale cover arriving in the catalog.
   *
   * Both ends come off live modules: the provider is one the registry genuinely resolves and the
   * consumer is a real fold, so what is seeded is a structurally valid registration rather than a
   * malformed row the gate might reject for some other reason. Only the event type is fabricated,
   * and that is the point — it is what makes the weld one the ledger has never seen.
   */
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

  /** The live verdict with `overrides` merged into the annotation table, every other input live. */
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

  it('StaleCoverBreakSet_EveryActiveUnnamedWeld_IsDispositioned', () => {
    const live = validateRegistrationWelds();

    // THE DENOMINATOR THIS RESTS ON, asserted before anything is read off it. A ledger reconciled
    // against a tooth whose eligible population had collapsed would report a clean sweep of
    // nothing, so the population is pinned non-empty and its vacuity guard shown silent first. The
    // reconciliation below is only evidence because this held.
    expect(live.staleCoverEligibleCount).toBeGreaterThan(0);
    expect(live.diagnostics.map((d) => d.code)).not.toContain('EMPTY_STALE_COVER_DENOMINATOR');
    expect(live.diagnostics.map((d) => d.code)).not.toContain('EMPTY_CAPABILITY_DENOMINATOR');

    // DERIVED, not typed. The subject is what the gate reports over the shipped catalog and the
    // shipped registry; nothing in this test writes down an event name, so a weld that becomes or
    // stops being stale changes the subject rather than leaving a stale literal checked against
    // itself.
    const reported = reportedStaleCover(live);
    const audit = auditStaleCoverDispositions(reported);

    // BOTH DIRECTIONS CLEAN: no reported weld is unanswered, and no row answers for a weld the
    // tooth no longer reports. `toEqual([])` rather than a length check so a failure prints the
    // offending identity and its remedy instead of a number.
    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);

    // The two populations are the same size, which is only true because the match is exact on all
    // three sides in both directions — a ledger that over- or under-covered would trip an arm above
    // and this equality would follow it.
    expect(audit.reportedCount).toBe(reported.length);
    expect(audit.dispositionedCount).toBe(STALE_COVER_DISPOSITIONS.length);
    expect(audit.reportedCount).toBe(audit.dispositionedCount);

    // The eligible population read a SECOND way, off the exported building blocks rather than
    // through the verdict — so every row below is checked against the population itself and not
    // merely against a number the gate publishes alongside it.
    const eligible = staleCoverEligibleWelds(bootResolvedWelds());
    expect(eligible.length).toBe(live.staleCoverEligibleCount);

    for (const row of STALE_COVER_DISPOSITIONS) {
      // A REASON and the EVIDENCE it rests on, not just a verdict. A classification with neither
      // would let "somebody decided" stand in for "somebody followed the append", which is the
      // state this ledger exists to end — and a blank string satisfies both types.
      expect(['unmodelled-emitter', 'undeclared-emission']).toContain(row.classification);
      expect(row.rationale.trim().length).toBeGreaterThan(0);
      expect(row.appendSite.trim().length).toBeGreaterThan(0);

      // The row answers for a weld that is genuinely IN the eligible population, checked against
      // the population directly. A row could otherwise agree with the verdict's finding list while
      // describing a registration the annotation table has stopped making.
      const weld = eligible.find((candidate) => candidate.eventType === row.event);
      expect(weld).toBeDefined();
      expect(weld?.ref).toBe(row.declaredProvider);
      expect(weld?.lifecycle).toBe(row.lifecycle);

      // ...and the lifecycle it names is one the policy admits. A row naming an excluded state
      // would be answering for a weld the tooth can never report.
      expect(STALE_COVER_LIFECYCLE_POLICY[row.lifecycle].eligible).toBe(true);

      // The registration is what the LIVE catalog holds, read a third way — off the annotation
      // table rather than off the derived weld — so a re-tiering cannot leave the row behind.
      const registration = EVENT_ANNOTATIONS[row.event];
      expect(registration).toBeDefined();
      expect(registration?.tier).toBe('capability');
      if (registration?.tier === 'capability') {
        expect(registration.provider).toBe(row.declaredProvider);
        expect(registration.lifecycle).toBe(row.lifecycle);
      }

      // ...and nothing in the registry declares it, which is the fact the row exists to answer for.
      expect(declaredEmissionEdges().some((edge) => edge.event === row.event)).toBe(false);
    }

    // BOTH CLASSIFICATIONS ARE IN USE. The distinction is the substance of this ledger — a break
    // set where every row said the same thing would mean nobody had separated "no action performs
    // this append" from "an action performs it and does not declare it", which are opposite
    // conclusions with opposite remedies.
    const classifications = new Set(STALE_COVER_DISPOSITIONS.map((row) => row.classification));
    expect([...classifications].sort()).toEqual(['undeclared-emission', 'unmodelled-emitter']);
  });

  it('StaleCoverBreakSet_UndispositionedEntry_Fails', () => {
    // THE CONTROL FIRST, so everything below is attributable to the seed rather than to the fixture.
    const control = auditStaleCoverDispositions(reportedStaleCover());
    expect(control.diagnostics).toEqual([]);
    expect(control.ok).toBe(true);

    // ── ARM ONE: a NEW stale weld arrives and nobody has looked at it ───────────────────────────
    const seed = unlistedStaleCover();
    const seeded = liveVerdictWithCatalog({ [seed.eventType]: seed.registration });

    // The gate still only OBSERVES it, exactly as before — the seed changes nothing about boot, so
    // a tree carrying an unanswered stale weld is indistinguishable from a clean one to every check
    // that existed before this ledger. That is the hole being closed.
    expect(seeded.bootable).toBe(true);
    expect(seeded.blockingCount).toBe(0);
    // The seed widened the eligible population by exactly one, so the extra finding below is the
    // seeded weld and not a second registration the fixture disturbed.
    expect(seeded.staleCoverEligibleCount).toBe(
      validateRegistrationWelds().staleCoverEligibleCount + 1,
    );

    const seededReport = reportedStaleCover(seeded);
    expect(seededReport.length).toBe(control.reportedCount + 1);

    const seededAudit = auditStaleCoverDispositions(seededReport);

    // ...and the reconciliation REDDENS. Not "a diagnostic exists somewhere" — exactly one, naming
    // the seeded weld by all three sides, with every pre-existing entry still answered for.
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
    // The message tells the reader what to do, names both classifications, and names the third
    // outcome that is NOT a row here — a weld nothing appends is a wrong annotation, and a finding
    // that omitted that would send the next reader to add a rationale for a claim the tree does not
    // support.
    expect(finding.message).toContain(seed.eventType);
    expect(finding.message).toContain('undeclared-emission');
    expect(finding.message).toContain('unmodelled-emitter');
    expect(finding.message).toContain('lifecycle');

    // ── ARM TWO: the ledger stops covering an entry that is still reported ──────────────────────
    // The complementary failure, and the one a ledger drifts into rather than arrives at: nothing
    // about the tree changes, a row is simply dropped. Same denominator, same tooth, one fewer
    // answer — and the audit must notice.
    const dropped = STALE_COVER_DISPOSITIONS[0];
    expect(dropped).toBeDefined();
    if (dropped === undefined) return;
    const thinned = auditStaleCoverDispositions(
      reportedStaleCover(),
      STALE_COVER_DISPOSITIONS.slice(1),
    );
    expect(thinned.ok).toBe(false);
    expect(thinned.diagnostics.map((d) => d.code)).toEqual(['UNDISPOSITIONED_STALE_COVER']);
    expect(thinned.diagnostics[0]?.identity).toEqual({
      event: dropped.event,
      declaredProvider: dropped.declaredProvider,
      lifecycle: dropped.lifecycle,
    });
  });

  it('StaleCoverBreakSet_RowCoveringNothing_IsReportedObsolete', () => {
    // THE OTHER HALF OF THE RATCHET. A row whose subject is gone reads exactly like a healthy one
    // from inside the table — same shape, same reasoning, still counted in `dispositionedCount` —
    // so nothing but this arm can tell the two apart. Without it the ledger could be repaired into
    // permanent agreement by leaving rows behind after the welds they answered for were wired up or
    // re-annotated, and the coverage check above would keep passing over a table that had stopped
    // describing the tree.
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

    // The count grew, which is the whole reason the arm is needed: a table can grow while covering
    // less.
    expect(audit.dispositionedCount).toBe(STALE_COVER_DISPOSITIONS.length + 1);
    expect(audit.reportedCount).toBe(STALE_COVER_DISPOSITIONS.length);
  });

  it('StaleCoverBreakSet_MatchIncludesTheLifecycleSide', () => {
    // WHY THE KEY CARRIES THE LIFECYCLE. Every row names `active` today, because the policy admits
    // nothing else — which is exactly what makes the side easy to drop as redundant and wrong to.
    // Take a covered row, move ONLY the lifecycle, and the audit must refuse to recognise it: proof
    // that the event and the provider did not carry the match on their own, and therefore that a
    // widening of the eligibility axis reaches this ledger as a new finding rather than as an
    // answer inherited from reasoning about a different state.
    const covered = STALE_COVER_DISPOSITIONS[0];
    expect(covered).toBeDefined();
    if (covered === undefined) return;
    const otherLifecycle = EVENT_LIFECYCLES.find((value) => value !== covered.lifecycle);
    expect(otherLifecycle).toBeDefined();
    if (otherLifecycle === undefined) return;

    const moved = auditStaleCoverDispositions([
      {
        event: covered.event,
        declaredProvider: covered.declaredProvider,
        lifecycle: otherLifecycle,
      },
    ]);
    expect(moved.diagnostics.map((d) => d.code)).toContain('UNDISPOSITIONED_STALE_COVER');

    // ...and the same identity with the lifecycle left alone IS recognised, so the refusal above is
    // caused by that one field and not by the single-element population.
    const untouched = auditStaleCoverDispositions([
      {
        event: covered.event,
        declaredProvider: covered.declaredProvider,
        lifecycle: covered.lifecycle,
      },
    ]);
    expect(untouched.diagnostics.map((d) => d.code)).not.toContain('UNDISPOSITIONED_STALE_COVER');
  });
});

describe('EligibleBaseline — the pinned stale-cover eligible count', () => {
  // Direction. The comparison denominator above (EMISSION_DENOMINATOR_FLOOR) is a floor compared
  // with `>=`, and deliberately so: it is the size of an INTERSECTION of two populations that grow
  // independently and incidentally — declaring one more `autoEmits` on an existing action widens it
  // without anyone touching this gate, so a check that reddened on that growth would punish the
  // ordinary work of wiring up coverage, and an equality would get "fixed" by whoever it next
  // inconvenienced rather than looked at.
  //
  // The eligible population does not move that way. `staleCoverEligibleCount` is read straight off
  // `EVENT_ANNOTATIONS` — every boot-resolved capability weld whose lifecycle is `active` — and the
  // ONLY way it changes is a reviewed edit to that table: registering a new capability event, or
  // moving one across the lifecycle axis. There is no second, unrelated population it rides on, so
  // there is no routine PR that moves it as a side effect. That is what makes an EXACT pin the right
  // choice here rather than a copy of the floor: growth and shrink both mean "somebody edited
  // EVENT_ANNOTATIONS", and both deserve the same one-line, reviewable re-pin in the same commit —
  // asymmetric tolerance would only hide the case where that edit happened and the baseline was
  // never told.
  it('EligibleBaseline_PinnedCount_MatchesTheLiveCount', () => {
    const baseline = readEligibleBaseline();
    expect(baseline.eligibleCount).toBeGreaterThan(0);

    // THE GATE'S OWN NUMBER.
    const verdict = validateRegistrationWelds();
    expect(verdict.staleCoverEligibleCount).toBe(baseline.eligibleCount);

    // ...AND THE SAME COUNT READ A SECOND WAY, off the two exported building blocks rather than
    // through the verdict, so the baseline is pinned against the population itself and not merely
    // against a number the gate happens to publish alongside it.
    const eligible = staleCoverEligibleWelds(bootResolvedWelds());
    expect(eligible.length).toBe(baseline.eligibleCount);
  });

  it('EligibleBaseline_ShrinkWithNoDisposition_Fails', () => {
    const baseline = readEligibleBaseline();

    // THE KILL FIXTURE. One active capability registration — the same one every other stale-cover
    // seed in this file uses — is retired. Nothing else about the catalog moves: same provider, same
    // consumer, same every other row, so the eligible population shrinks by exactly one and there is
    // no ledger row anywhere that answers for it.
    const registration = EVENT_ANNOTATIONS[STALE_COVER_SEED_EVENT];
    expect(registration).toBeDefined();
    if (registration === undefined || registration.tier !== 'capability') return;
    const shrunk = catalogWith({
      [STALE_COVER_SEED_EVENT]: { ...registration, lifecycle: 'retired' },
    });

    const eligible = staleCoverEligibleWelds(bootResolvedWelds(shrunk));
    expect(eligible.length).toBe(baseline.eligibleCount - 1);

    // THE ASSERTION REDDENS — not "some diagnostic somewhere fired", but the exact expectation the
    // live test makes above, run against the shrunk population and shown to throw. This is the half
    // that carries the weight: a baseline nobody can fail against is decoration, not a guard.
    expect(() => expect(eligible.length).toBe(baseline.eligibleCount)).toThrow();

    // THE CONTROL: the untouched catalog still matches, so the failure above is caused by the
    // seeded retirement and by nothing else in this fixture.
    expect(staleCoverEligibleWelds(bootResolvedWelds(EVENT_ANNOTATIONS)).length).toBe(
      baseline.eligibleCount,
    );
  });
});
