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
import {
  EVENT_TIERS,
  weldReferenceOf,
  type EventRegistration,
} from '../../../src/events/event-registration.js';
import {
  DIAGNOSTIC_SEVERITY_POLICY,
  PROVIDER_REGISTRY_DRIFT_CODE,
  RegistrationWeldError,
  UNRESOLVABLE_PROVIDER_CODE,
  WELD_RESOLUTION_POLICY,
  assertRegistrationWeldsAtStartup,
  bootResolvedWelds,
  resolvableProviderIds,
  validateRegistrationWelds,
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
  readonly code: string;
  readonly annotations: Readonly<Record<string, EventRegistration>>;
  readonly providers: readonly EffectProvider[];
  readonly rules: readonly EffectOwnershipRule[];
}

/**
 * A seed per diagnostic code. Every one of these is an input the gate ALREADY reported on before
 * the severity axis existed; nothing here introduces a new fault class.
 */
const DIAGNOSTIC_SEEDS: readonly DiagnosticSeed[] = [
  {
    code: UNRESOLVABLE_PROVIDER_CODE,
    annotations: catalogWith({
      'seeded.severity-unresolvable': capabilityNaming('exarchos_no_such_provider'),
    }),
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
  },
  {
    code: PROVIDER_REGISTRY_DRIFT_CODE,
    annotations: EVENT_ANNOTATIONS,
    providers: [...EFFECT_PROVIDERS, GHOST_PROVIDER],
    rules: EFFECT_OWNERSHIP,
  },
  {
    code: 'EMPTY_CAPABILITY_DENOMINATOR',
    annotations: {},
    providers: EFFECT_PROVIDERS,
    rules: EFFECT_OWNERSHIP,
  },
  {
    code: 'EMPTY_PROVIDER_REGISTRY',
    annotations: EVENT_ANNOTATIONS,
    providers: [],
    rules: EFFECT_OWNERSHIP,
  },
];

/**
 * The live severity table with every row rewritten to `severity` — DERIVED from the shipped table's
 * keys rather than transcribed, so it stays total as codes are added and cannot quietly leave a
 * code on its default.
 */
function everyDiagnosticAt(severity: WeldDiagnosticSeverity): Record<string, WeldDiagnosticSeverity> {
  const table: Record<string, WeldDiagnosticSeverity> = {};
  for (const code of Object.keys(DIAGNOSTIC_SEVERITY_POLICY)) table[code] = severity;
  return table;
}

describe('RegistrationValidate — the DR-2 boot-time weld resolution gate', () => {
  it('RegistrationWelds_LiveCatalog_ResolvesAgainstNonEmptyPopulations', () => {
    const verdict = validateRegistrationWelds();

    // The shipped catalog boots. If this ever goes red it is a real defect, not a flake.
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.ok).toBe(true);

    // NON-VACUOUS DENOMINATORS, both of them, and both derived. A gate that resolved zero welds
    // (or resolved them against zero providers) would report exactly this same `ok: true`, which
    // is the failure mode the two EMPTY_* diagnostics exist to make impossible.
    const capabilityTypes = liveCapabilityTypes();
    expect(capabilityTypes.length).toBeGreaterThan(0);
    expect(verdict.bootResolvedCount).toBe(capabilityTypes.length);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBe(resolvableProviderIds().length);

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

    expect(verdict.report).toContain('event registration welds OK');
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
    // THE UNCHANGED-BEHAVIOUR PIN. Every diagnostic the gate can emit today is `blocking` in the
    // shipped table, so the set of inputs that refuse startup is exactly what it was before
    // severity was expressible. Naming the four codes is the point: this is a pin on the
    // PRE-EXISTING population, and it must redden if one of them is renamed or downgraded, not
    // shrug and pass over a phantom.
    const shipped = Object.entries(DIAGNOSTIC_SEVERITY_POLICY);
    const shippedCodes = shipped.map(([code]) => code);
    expect(shippedCodes).toEqual(
      expect.arrayContaining([
        UNRESOLVABLE_PROVIDER_CODE,
        PROVIDER_REGISTRY_DRIFT_CODE,
        'EMPTY_CAPABILITY_DENOMINATOR',
        'EMPTY_PROVIDER_REGISTRY',
      ]),
    );
    for (const [, severity] of shipped) expect(severity).toBe('blocking');

    // NON-VACUOUS SEED SET: one input per code, and the codes come from the same table asserted
    // above — so a code that no seed exercises is a hole this loop reports rather than skips.
    expect(DIAGNOSTIC_SEEDS.map((s) => s.code).sort()).toEqual([...shippedCodes].sort());

    for (const seed of DIAGNOSTIC_SEEDS) {
      // The pure verdict first: the diagnostic fires, it is stamped `blocking`, and the boot
      // decision follows from the stamp rather than from "the list is non-empty".
      const verdict = validateRegistrationWelds(seed.annotations, seed.providers, seed.rules);
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
        ),
      ).toThrow(RegistrationWeldError);
      expect(reported).toEqual([]);
    }
  });

  it('StartupAssertion_ObserveSeverity_ReportsWithoutThrowing', () => {
    // THE OTHER ARM, over the same four inputs. Identical populations, one row-set flipped: the
    // gate must now RETURN and report rather than refuse. Running it over the same seeds as the
    // blocking test is what makes the pair evidence — each input is shown to be refusable AND
    // survivable purely as a function of the severity table.
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
    // reported unconditionally would still satisfy "does not throw" — so the clean tree must
    // produce NO report at all. This is also the live-catalog control for the axis: flipping every
    // row to observe changes nothing about a tree that has nothing to say.
    const reported: string[] = [];
    const verdict = assertRegistrationWeldsAtStartup(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      everyDiagnosticAt('observe'),
      (message) => reported.push(message),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.bootable).toBe(true);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.observeCount).toBe(0);
    expect(reported).toEqual([]);
    // ...over a non-empty population, so "nothing to report" is not "nothing to look at".
    expect(verdict.bootResolvedCount).toBeGreaterThan(0);
    expect(verdict.resolvableProviderCount).toBeGreaterThan(0);
  });

  it('StartupAssertion_MixedSeverities_RefusesOnTheBlockingOneAndStillNamesTheObservation', () => {
    // The case the flip to blocking will actually walk through: one fault of each severity in the
    // same verdict. `bootable` must follow the BLOCKING one — a severity axis that let an
    // observation dilute a refusal would be worse than no axis at all — while the observation is
    // still carried, so the operator is not shown half the picture.
    const seeded = catalogWith({
      'seeded.severity-mixed': capabilityNaming('exarchos_no_such_provider'),
    });
    const mixed: Record<string, WeldDiagnosticSeverity> = {
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
