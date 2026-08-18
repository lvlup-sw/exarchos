// Co-located tests for the DR-2 tier + lifecycle annotations (task 010).
//
// @oracle-sources: ../../../src/events/schemas.ts, the emission-site and consumer-fold measurement recorded in event-annotations
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
} from '../../../src/events/schemas.js';
import {
  EVENT_LIFECYCLES,
  EVENT_TIERS,
  weldReferenceOf,
} from '../../../src/events/event-registration.js';
import { eventDeclarations, isEventRegistration } from '../../../src/events/event-declarations.js';
import {
  bootResolvedWelds,
  staleCoverEligibleWelds,
} from '../../../src/events/registration-validate.js';
import {
  ANNOTATED_EVENTS,
  EVENT_ANNOTATIONS,
  reportCoupledEventTypes,
  tierSourceDisagreements,
  unannotatedEventTypes,
  unregisteredAnnotations,
  type DeclaredEmissionSources,
} from '../../../src/events/event-annotations.js';

/** The live registry with one entry overwritten — the seeding seam for the falsifiers below. */
function registryWith(
  overrides: Readonly<Record<string, EventEmissionSource>>,
): DeclaredEmissionSources {
  return { ...EVENT_EMISSION_REGISTRY, ...overrides };
}

describe('EventAnnotations — the DR-2 tier and lifecycle assignment for the event catalog', () => {
  it('EventAnnotations_EveryRegisteredType_CarriesATierAndLifecycle', () => {
    // The name carried a cardinality (`All170Types`) and the catalog outgrew it twice without
    // anything going red, because every assertion in this test is RELATIVE — the denominator is
    // read from the registry, never written down. A number in the name of a test that
    // deliberately holds no number was the only stale part of it, so the number is gone rather
    // than bumped.
    //
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

  it('VcsLedgerEvents_SubstrateTier_CarryOperationRecordRationale', () => {
    // The three names the git & worktree mutation owner appends around every
    // non-idempotent git effect: the intent before it and one of two terminals after.
    //
    // They are the WEAKEST weld in the union, and the assertions below say exactly that and
    // no more. `substrate`/`operation-record` claims only that the code performing the
    // operation owns the append; it does NOT claim a consumer, a provider or a gate.
    const LEDGER = ['vcs.requested', 'vcs.executed', 'vcs.compensated'] as const;

    for (const eventType of LEDGER) {
      // Read through the PORT, not the table literal — the port is what `schemas.ts` derives
      // the emission registry through, so an annotation the port cannot resolve is one the
      // registry derivation cannot see either.
      const registration = ANNOTATED_EVENTS.registrationOf(eventType);
      expect(registration, `${eventType} carries no annotation`).toBeDefined();
      expect(registration).toEqual({
        lifecycle: 'active',
        tier: 'substrate',
        rationale: 'operation-record',
      });

      // The weld has to RESOLVE, not merely be spelled. `weldReferenceOf` is the runtime
      // carrier of the union's exhaustiveness, so an empty ref would mean a registration that
      // named a tier and nothing else.
      expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

      // The consequence that reaches the rest of the system: the derived registry classifies
      // all three `auto`. This is what "the handler owns the append" means on the emission
      // axis, and it is the reason no model is ever nagged to hand-emit a ledger record.
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('auto');
    }

    // NOT report-coupled — the population a shrink ratchet reads. A ledger record that landed
    // in the model-emitted set would be a durable effect record the model could forget to make.
    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled.length, 'the report-coupled census is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    for (const eventType of LEDGER) expect(reportCoupled).not.toContain(eventType);

    // And the negative direction, so the block above is not passing because every event in the
    // catalog happens to be an operation record: a sibling in the SAME table is welded
    // elsewhere, and reading it back gives a different rationale.
    expect(ANNOTATED_EVENTS.registrationOf('workflow.started')).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'transition-record',
    });
  });

  it('PromotionEvent_SubstrateTier_CarriesOperationRecordRationale', () => {
    // The atomic tree-promotion record. `install/atomic-promotion.ts` swaps a verified staged
    // tree into a live destination with a bounded sequence of renames; that commit rename is
    // the non-idempotent step, and the promoting code owns the append of the record for it.
    //
    // The weld claims only that. It names no provider, no consumer and no gate, and every
    // assertion below is scoped to the claim rather than to the fact of registration.
    const PROMOTION = 'promotion.executed';

    // Read through the PORT, not the table literal — the port is what `schemas.ts` derives the
    // emission registry through, so an annotation the port cannot resolve is one the derivation
    // cannot see either.
    const registration = ANNOTATED_EVENTS.registrationOf(PROMOTION);
    expect(registration, `${PROMOTION} carries no annotation`).toBeDefined();
    expect(registration).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'operation-record',
    });

    // The weld has to RESOLVE, not merely be spelled. An empty ref would mean a registration
    // that named a tier and nothing else.
    expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

    // The consequence that reaches the rest of the system: the derived registry classifies it
    // `auto`, which is what "the promoting code owns the append" means on the emission axis.
    expect(EVENT_EMISSION_REGISTRY[PROMOTION]).toBe('auto');

    // NOT report-coupled. A durable effect record that landed in the model-emitted set would be
    // a record the model could simply forget to make.
    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled.length, 'the report-coupled census is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    expect(reportCoupled).not.toContain(PROMOTION);

    // ── The rationale is the subject, so it has to be capable of being wrong ──
    //
    // Two independent discriminations, because `substrate` alone is the most populated tier in
    // the table and asserting it proves almost nothing.
    //
    // First: a sibling welded `substrate` for a DIFFERENT reason reads back with a different
    // rationale, so the equality above is not satisfied by every substrate registration.
    expect(ANNOTATED_EVENTS.registrationOf('workflow.started')).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'transition-record',
    });

    // Second, and the one this task exists to keep straight: the cutover-readiness export
    // record is a neighbouring, already-registered fact about promotion — and it is a
    // materially different weld, `capability` with a named provider and a real consumer fold.
    // Reusing it for the promotion effect would have claimed a provider and a consumer that the
    // promotion has neither of. Reading both back here is what makes the difference an
    // assertion rather than a note in a commit message.
    const cutoverReady = ANNOTATED_EVENTS.registrationOf('admission.cutover-ready');
    expect(cutoverReady).toBeDefined();
    expect(cutoverReady!.tier).toBe('capability');
    expect(cutoverReady).not.toEqual(registration);
  });

  it('EmissionViolation_SubstrateTier_CarriesOperationRecordRationale', () => {
    // The post-dispatch verifier's report that a handler completed an operation without an
    // event its own registration declares unconditionally. The code that detects the miss owns
    // the append of the finding, which is the whole of the claim `substrate`/`operation-record`
    // makes — no provider, no consumer, no gate.
    const VIOLATION = 'emission.violated';

    // Read through the PORT, not the table literal — the port is what `schemas.ts` derives the
    // emission registry through, so an annotation the port cannot resolve is one the derivation
    // cannot see either.
    const registration = ANNOTATED_EVENTS.registrationOf(VIOLATION);
    expect(registration, `${VIOLATION} carries no annotation`).toBeDefined();
    expect(registration).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'operation-record',
    });

    // The weld has to RESOLVE, not merely be spelled. An empty ref would mean a registration
    // that named a tier and nothing else.
    expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

    // The consequence that reaches the rest of the system: the derived registry classifies it
    // `auto`. The verifier appends its own finding, so no model is ever asked to report that
    // Exarchos dropped an emission — which is a record the party at fault would be writing.
    expect(EVENT_EMISSION_REGISTRY[VIOLATION]).toBe('auto');

    // NOT report-coupled. A violation report in the model-emitted set would be a bug report the
    // model could decline to file, and the one thing a missed-emission check cannot tolerate is
    // a missed emission of its own.
    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled.length, 'the report-coupled census is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    expect(reportCoupled).not.toContain(VIOLATION);

    // ── The rationale is the subject, so it has to be capable of being wrong ──
    //
    // `substrate` is the most populated tier in the table, so asserting it alone proves nearly
    // nothing. A sibling welded `substrate` for a DIFFERENT reason reads back with a different
    // rationale, which is what stops the equality above from being satisfied by any substrate
    // row at all.
    expect(ANNOTATED_EVENTS.registrationOf('workflow.started')).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'transition-record',
    });

    // ── The tier's operative consequence, asserted against a non-empty population ──
    //
    // `substrate` keeps this registration OUT of the boot-resolved weld set, and therefore out
    // of the stale-cover population the boot gate ranges over. That is the honest reading and
    // not a dodge: the finding is read by whoever investigates the bug, and reading is not
    // folding — there is no reducer, view or telemetry surface to name as a `ConsumerId`.
    //
    // Guarded against vacuity in both directions, because "absent from a set" is the classic
    // assertion that passes by the set being empty or by the check having stopped running: the
    // population is asserted non-empty AND asserted to contain a known capability event, so a
    // resolver that returned nothing would fail here rather than agree.
    const welds = bootResolvedWelds();
    const eligible = staleCoverEligibleWelds(welds);
    const boundTypes = welds.map((w) => w.eventType);
    expect(boundTypes.length, 'the boot-resolved weld set is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    expect(boundTypes).toContain('task.completed');
    expect(boundTypes).not.toContain(VIOLATION);
    expect(eligible.map((w) => w.eventType)).not.toContain(VIOLATION);
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
