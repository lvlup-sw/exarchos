// Co-located tests for the DR-2 tier + lifecycle annotations (task 010).
//
// @oracle-sources: ./schemas.ts, the emission-site and consumer-fold measurement recorded in event-annotations
//
// The authorities, and what task 011 did to them. `events/schemas.ts` owns the event
// UNIVERSE. It used to own the DECLARED emission source as well — 170 hand-written entries
// accreted over dozens of prior PRs — and task 010's assertions here were a genuine two-authority
// comparison: the tier/lifecycle judgment in `event-annotations.ts` was derived from a different
// pair of populations entirely (which code APPENDS each event, and which reducer or view FOLDS
// it), and neither was read off the other.
//
// **Task 011 collapsed the two into one, on purpose.** `EVENT_EMISSION_REGISTRY` is now DERIVED
// from these annotations, so "the registry agrees with the tier" is true by construction and is no
// longer a thing this file can meaningfully assert. Where an assertion below would now be
// self-consistent by construction it says so, and the falsifying weight moves to the SEEDED cases,
// which take their declared-source map as a parameter and can still come out wrong.
//
// The second authority is declared as a label rather than a module path on purpose. DR-30's
// derivation check is a static MODULE-REACHABILITY walk (see `suite-invariants/LIMITATIONS.md`:
// an over-approximation of dependency, an under-approximation of value derivation).
// `event-annotations.ts` necessarily imports `event-registration.ts`, which type-imports
// `schemas.ts`, so declaring both as paths would report a derivation that does not exist at the
// value level — the annotations are hand-authored from emission and consumer evidence, not
// computed from the registry.
//
// The COMPILE-time half is not here. `tsconfig.json` excludes `**/*.test.ts`, so type-level
// assertions in this file would be decorative; they live as exported `_EventAnnotations_*` aliases
// in the source module, where `tsc` actually checks them.

import { describe, it, expect } from 'vitest';
import {
  EVENT_EMISSION_REGISTRY,
  EventTypes,
  type EventEmissionSource,
} from './schemas.js';
import {
  EVENT_LIFECYCLES,
  EVENT_TIERS,
  weldReferenceOf,
} from './event-registration.js';
import { eventDeclarations, isEventRegistration } from './event-declarations.js';
import {
  ANNOTATED_EVENTS,
  EVENT_ANNOTATIONS,
  reportCoupledEventTypes,
  tierSourceDisagreements,
  unannotatedEventTypes,
  unregisteredAnnotations,
  type DeclaredEmissionSources,
} from './event-annotations.js';

/** The live registry with one entry overwritten — the seeding seam for the falsifiers below. */
function registryWith(
  overrides: Readonly<Record<string, EventEmissionSource>>,
): DeclaredEmissionSources {
  return { ...EVENT_EMISSION_REGISTRY, ...overrides };
}

describe('EventAnnotations — the DR-2 tier and lifecycle assignment for the event catalog', () => {
  it('EventAnnotations_All170Types_CarryATierAndLifecycle', () => {
    // NON-VACUOUS DENOMINATOR, from two independent reads of the storage module. A census over an
    // empty population reports "no gaps" and means nothing; a census over one store cannot notice
    // that the other store grew.
    const registered = Object.keys(EVENT_EMISSION_REGISTRY);
    expect(EventTypes.length).toBeGreaterThan(0);
    expect(EventTypes.length).toBe(registered.length);
    expect(Object.keys(EVENT_ANNOTATIONS).length).toBe(registered.length);

    // AUTHORITY 1 (`schemas.ts`) supplies the population; the annotations supply the coverage.
    // Both directions, so a typo'd key shows up as an unregistered annotation rather than hiding
    // inside the missing list.
    const missing = unannotatedEventTypes(EventTypes);
    expect(missing).toEqual([]);
    const unregistered = unregisteredAnnotations(EventTypes);
    expect(unregistered).toEqual([]);

    // Every annotation carries BOTH axes, drawn from the shipped vocabularies. `EVENT_TIERS` and
    // `EVENT_LIFECYCLES` are the data forms task 009 pins to their unions by mutual assignability,
    // so this cannot pass against a tier the type does not admit.
    const offTaxonomy = EventTypes.filter((eventType) => {
      const registration = ANNOTATED_EVENTS.registrationOf(eventType);
      if (registration === undefined) return true;
      return (
        !EVENT_TIERS.some((tier) => tier === registration.tier) ||
        !EVENT_LIFECYCLES.some((lifecycle) => lifecycle === registration.lifecycle)
      );
    });
    expect(offTaxonomy).toEqual([]);

    // Every annotation carries a resolvable WELD. `weldReferenceOf` is the runtime carrier of the
    // union's exhaustiveness (its switch has no default beyond the `never` binding), so an empty
    // ref here would mean a registration that named its tier and nothing else — the form DR-2
    // says has no variant.
    const weldless = EventTypes.filter((eventType) => {
      const registration = ANNOTATED_EVENTS.registrationOf(eventType);
      if (registration === undefined) return true;
      return weldReferenceOf(registration).ref.trim().length === 0;
    });
    expect(weldless).toEqual([]);

    // The runtime consequence, and the point of the whole task: task 008's guard had no production
    // positive case because every declaration still took the emission arm. Lifted through the port,
    // every declaration now inhabits `EventRegistration` — checked by the guard that VALIDATES
    // rather than by the type that produced them.
    const declarations = eventDeclarations(ANNOTATED_EVENTS);
    const failingTheGuard = declarations
      .filter((declaration) => !isEventRegistration(declaration.subject))
      .map((declaration) => declaration.id);
    expect(failingTheGuard).toEqual([]);
    expect(declarations.length).toBe(registered.length);
  });

  it('EventAnnotations_SeededTierSourceDisagreement_IsReported', () => {
    // THE FALSIFIER. `task.completed` is annotated `capability`, which derives `'auto'`. Declaring
    // it `'model'` is a tier<->source disagreement and must be reported by name — this is what
    // makes the "derivation is total over the emission axis" claim capable of being wrong.
    const seeded = tierSourceDisagreements(registryWith({ 'task.completed': 'model' }));
    const seededTypes = seeded.map((d) => d.eventType);
    expect(seededTypes).toContain('task.completed');

    const reported = seeded.find((d) => d.eventType === 'task.completed');
    expect(reported?.code).toBe('TIER_SOURCE_DISAGREEMENT');
    expect(reported?.declared).toBe('model');
    expect(reported?.derived).toBe('auto');
    expect(reported?.tier).toBe('capability');

    // A `retired` entry declaring `'retired'` is NOT a disagreement. Lifecycle produces the source
    // directly and strictly precedes the question of what emits it, so `merge.rollback` agrees
    // even though its `capability` tier would derive `'auto'` were it active. Reporting it would
    // be the rev-2 error: it would force every retired event to be re-tiered into a coupling class
    // it has not had since it stopped being emitted.
    expect(seededTypes).not.toContain('merge.rollback');
    // Same for `planned`, the mirror case.
    expect(seededTypes).not.toContain('admission.waiver-recorded');

    // ... and a retired entry declared something ELSE still fails, so the exemption above is a
    // property of the lifecycle axis rather than a blanket pass for the word "retired".
    const misdeclaredRetired = tierSourceDisagreements(registryWith({ 'merge.rollback': 'auto' }));
    expect(misdeclaredRetired.map((d) => d.eventType)).toContain('merge.rollback');

    // THE LIVE CATALOG, after task 011. Zero disagreements — not because the exceptions were
    // excused but because the registry is now DERIVED from these annotations, so a built-in type
    // has no independently-authored source left to disagree with. Task 010's shrink-only
    // `UNRECONCILED_REGISTRATIONS` shrank to nothing and was deleted with the population it named.
    //
    // The denominator is asserted alongside it: this census skips event types it cannot resolve,
    // so "zero disagreements" over zero compared subjects is the failure mode a moved or renamed
    // registry would produce, and it must not read as a clean run.
    const comparable = Object.keys(EVENT_EMISSION_REGISTRY).filter(
      (eventType) => ANNOTATED_EVENTS.registrationOf(eventType) !== undefined,
    );
    expect(comparable.length).toBe(EventTypes.length);
    const live = tierSourceDisagreements(EVENT_EMISSION_REGISTRY).map((d) => d.eventType);
    expect(live).toEqual([]);
  });

  it('EventAnnotations_ReportCoupledCount_IsDerivedAtIntroduction', () => {
    // WHAT THE REGISTRY HOLDS. Since task 011 this is a PROJECTION of the annotations, not an
    // independent authority, so the comparison below no longer pits two judgments against each
    // other — it checks that the projection `schemas.ts` builds
    // (`deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf)`) agrees with a second,
    // independently-written pass over the same table. A derivation that mis-keyed, dropped or
    // defaulted an entry still turns this red; a wrong TIER does not, and is not claimed to.
    const declaredModelEmitted = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] === 'model',
    ).sort();

    // The census pass: `resolveEmissionSource` composed over the two axes, walking the annotations
    // directly rather than the registry, so the number G3 seeds from is a consequence of the
    // coupling claims rather than a transcription of them.
    const derivedReportCoupled = reportCoupledEventTypes(EventTypes);

    // The seed is COMPUTED — `.length` of a list this test can also print. No cardinality literal
    // appears in this file or in `event-annotations.ts`; a task-013 ratchet that hard-coded 25
    // would be pinning a number nobody can re-derive when an event migrates off the model path.
    const seed = derivedReportCoupled.length;
    expect(seed).toBe(declaredModelEmitted.length);
    expect([...derivedReportCoupled]).toEqual([...declaredModelEmitted]);

    // NON-VACUITY. Task 009 chose `judgment: 'model'` specifically so the census would have a real
    // subject to shrink; a seed of zero would make the G3 ratchet trivially satisfied forever.
    expect(seed).toBeGreaterThan(0);

    // The population splits across the two tiers that derive `'model'`, and both halves are
    // non-empty — the correction task 010 measured. Collapsing either half back into the other
    // (all 25 `judgment`, or all 25 `workflow-local`) would leave the count right and the welds
    // wrong, so the count alone is not allowed to be the whole assertion.
    const tiersInPlay = new Set(
      derivedReportCoupled.map((eventType) => EVENT_ANNOTATIONS[eventType]?.tier),
    );
    expect([...tiersInPlay].sort()).toEqual(['judgment', 'workflow-local']);
  });
});
