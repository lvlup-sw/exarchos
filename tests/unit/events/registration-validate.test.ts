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
  EVENT_TIERS,
  weldReferenceOf,
  type EventRegistration,
} from '../../../src/events/event-registration.js';
import {
  DIAGNOSTIC_SEVERITY_POLICY,
  EMISSION_DENOMINATOR_FLOOR,
  EMISSION_PROVIDER_MISMATCH_CODE,
  PROVIDER_REGISTRY_DRIFT_CODE,
  RegistrationWeldError,
  UNRESOLVABLE_PROVIDER_CODE,
  WELD_RESOLUTION_POLICY,
  assertRegistrationWeldsAtStartup,
  bootResolvedWelds,
  declaredEmissionEdges,
  resolvableProviderIds,
  validateRegistrationWelds,
  type EmissionEdge,
  type WeldDiagnosticCode,
  type WeldDiagnosticSeverity,
} from '../../../src/events/registration-validate.js';

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

/** Every live capability registration as `(eventType, declaredProvider)`, read off the catalog. */
function liveCapabilityRegistrations(): { eventType: string; provider: string }[] {
  const rows: { eventType: string; provider: string }[] = [];
  for (const [eventType, registration] of Object.entries(EVENT_ANNOTATIONS)) {
    if (registration.tier !== 'capability') continue;
    rows.push({ eventType, provider: registration.provider });
  }
  return rows.sort((a, b) => (a.eventType < b.eventType ? -1 : a.eventType > b.eventType ? 1 : 0));
}

/**
 * An emission population that AGREES with the live catalog everywhere: one edge per live capability
 * registration, declared on the very tool that registration names.
 *
 * DERIVED from the annotation table rather than written down, so it stays conforming as the catalog
 * moves and cannot rot into a fixture that disagrees for a reason nobody meant. The seeds below hold
 * it fixed so each one varies exactly ONE population — without it, the live registry's real
 * disagreements would ride along in every seeded verdict and no seed would isolate anything.
 */
function conformingEmissionEdges(): readonly EmissionEdge[] {
  return liveCapabilityRegistrations().map(({ eventType, provider }) => ({
    event: eventType,
    action: `${eventType}-emitter`,
    declaringTool: provider,
  }));
}

const CONFORMING_EMISSIONS = conformingEmissionEdges();

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
 * A seed per diagnostic code. Each varies ONE population and holds the other three at a value that
 * reports nothing — which is why every seed carries an explicit emission population rather than
 * falling through to the live registry, whose real disagreements would otherwise appear in all six
 * verdicts and make "exactly one fault fired" untestable.
 */
const DIAGNOSTIC_SEEDS: readonly DiagnosticSeed[] = [
  {
    code: UNRESOLVABLE_PROVIDER_CODE,
    annotations: catalogWith({
      'seeded.severity-unresolvable': capabilityNaming('exarchos_no_such_provider'),
    }),
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
    emissions: CONFORMING_EMISSIONS,
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
    // Every finding is the emission comparison's. If a REFERENCE-integrity fault ever appears here
    // it is a real defect, not a flake — and it would arrive as a blocking count above zero.
    expect([...new Set(verdict.diagnostics.map((d) => d.code))]).toEqual([
      EMISSION_PROVIDER_MISMATCH_CODE,
    ]);

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
        .map((d) => ('action' in d ? `${d.eventType} ${d.action}` : '')),
    );
    for (const edge of agreeing) {
      expect(faulted.has(`${edge.event} ${edge.action}`)).toBe(false);
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
    expect(verdict.diagnostics.map((d) => d.code)).toEqual(['EMPTY_EMISSION_DENOMINATOR']);
    expect(verdict.ok).toBe(false);
    // The other two populations are untouched, so the fault is unambiguously the emission set's.
    expect(verdict.bootResolvedCount).toBe(liveCapabilityTypes().length);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);

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
    expect(offTier.diagnostics.map((d) => d.code)).toEqual(['EMPTY_EMISSION_DENOMINATOR']);

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
        toolByAction.set(`${tool.name} ${action.name}`, tool.name);
        declaredEmissionCount += action.autoEmits?.length ?? 0;
      }
    }
    expect(edges.length).toBe(declaredEmissionCount);
    for (const edge of edges) {
      expect(toolByAction.get(`${edge.declaringTool} ${edge.action}`)).toBe(edge.declaringTool);
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
    expect(emptied.diagnostics.map((d) => d.code)).toEqual(['EMPTY_EMISSION_DENOMINATOR']);
  });
});
