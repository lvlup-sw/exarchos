// Co-located tests for the DR-2 tier + lifecycle annotations (task 010).
//
// @oracle-sources: ./schemas.ts, the emission-site and consumer-fold measurement recorded in event-annotations
//
// The two authorities, and why they are two. `event-store/schemas.ts` owns the event UNIVERSE and
// the DECLARED emission source — 170 entries accreted over dozens of prior PRs, each written by
// whoever added the event. The second authority is the tier/lifecycle judgment in
// `event-annotations.ts`, derived from a different pair of populations entirely: which code
// APPENDS each event (the handler tree) and which reducer or view FOLDS it (every
// `ViewProjection`/`ProjectionReducer` in the tree). Neither was read off the other — the registry's
// `source` column is what the annotation is CHECKED against here, so using it as an input would
// have made every assertion below self-consistent by construction.
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
  UNRECONCILED_REGISTRATIONS,
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

    // THE LIVE CATALOG. Exactly the registrations task 010 could not reconcile disagree, and no
    // others. `UNRECONCILED_REGISTRATIONS` is a named, owner-carrying, shrink-only list — not a
    // suppression: the assertion below requires each declared entry to STILL disagree, so a stale
    // entry that has been fixed elsewhere turns this red instead of silently excusing nothing.
    const live = tierSourceDisagreements(EVENT_EMISSION_REGISTRY).map((d) => d.eventType);
    const declaredUnreconciled = UNRECONCILED_REGISTRATIONS.map((u) => u.eventType).sort();
    expect(live.slice().sort()).toEqual(declaredUnreconciled);
    expect(declaredUnreconciled.length).toBeGreaterThan(0);
  });

  it('EventAnnotations_ReportCoupledCount_IsDerivedAtIntroduction', () => {
    // AUTHORITY 1 — what the registry declares. The report-coupled population as `schemas.ts`
    // records it: a dedicated append the model must remember to make.
    const declaredModelEmitted = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] === 'model',
    ).sort();

    // AUTHORITY 2 — what the ANNOTATIONS derive. `resolveEmissionSource` composes the two axes;
    // nothing here reads the registry's `source` column, so the number G3 seeds from is a
    // consequence of the coupling claims rather than a transcription of them.
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
