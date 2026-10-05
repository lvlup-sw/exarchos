// Tests for the tier and lifecycle annotations of the event catalog.
//
// @oracle-sources: ../../../src/events/schemas.ts, the emission-site and consumer-fold measurement recorded in event-annotations
//
// `events/schemas.ts` owns the set of event types. It derives `EVENT_EMISSION_REGISTRY` from the
// annotations, so the registry agrees with the tier by construction. The seeded cases carry the
// falsifying weight: they take the declared-source map as a parameter and can come out wrong.
//
// The second authority is a label and not a module path. The derivation check walks module
// reachability, and `event-annotations.ts` reaches `schemas.ts` through type imports. With both
// authorities as paths, the check reports a derivation that does not exist at the value level.
// A person writes the annotations from emission and consumer evidence.
//
// `tsconfig.json` excludes test files, so the type-level assertions are the exported
// `_EventAnnotations_*` aliases in the source module.

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

/** The live registry with the `overrides` entries replaced. The seeded cases use it. */
function registryWith(
  overrides: Readonly<Record<string, EventEmissionSource>>,
): DeclaredEmissionSources {
  return { ...EVENT_EMISSION_REGISTRY, ...overrides };
}

describe('EventAnnotations — the DR-2 tier and lifecycle assignment for the event catalog', () => {
  /**
   * Each assertion is relative: the test reads the count from the registry and holds no literal.
   * The population must not be empty, because a census over nothing reports no gaps.
   * The coverage check runs in both directions, so a mistyped key shows as an unregistered
   * annotation. Each annotation must carry a tier and a lifecycle from the shipped vocabularies,
   * and a non-empty weld reference. Each declaration must pass the `isEventRegistration` guard.
   */
  it('EventAnnotations_EveryRegisteredType_CarriesATierAndLifecycle', () => {
    const registered = Object.keys(EVENT_EMISSION_REGISTRY);
    expect(EventTypes.length).toBeGreaterThan(0);
    expect(EventTypes.length).toBe(registered.length);
    expect(Object.keys(EVENT_ANNOTATIONS).length).toBe(registered.length);

    const missing = unannotatedEventTypes(EventTypes);
    expect(missing).toEqual([]);
    const unregistered = unregisteredAnnotations(EventTypes);
    expect(unregistered).toEqual([]);

    const offTaxonomy = EventTypes.filter((eventType) => {
      const registration = ANNOTATED_EVENTS.registrationOf(eventType);
      if (registration === undefined) return true;
      return (
        !EVENT_TIERS.some((tier) => tier === registration.tier) ||
        !EVENT_LIFECYCLES.some((lifecycle) => lifecycle === registration.lifecycle)
      );
    });
    expect(offTaxonomy).toEqual([]);

    const weldless = EventTypes.filter((eventType) => {
      const registration = ANNOTATED_EVENTS.registrationOf(eventType);
      if (registration === undefined) return true;
      return weldReferenceOf(registration).ref.trim().length === 0;
    });
    expect(weldless).toEqual([]);

    const declarations = eventDeclarations(ANNOTATED_EVENTS);
    const failingTheGuard = declarations
      .filter((declaration) => !isEventRegistration(declaration.subject))
      .map((declaration) => declaration.id);
    expect(failingTheGuard).toEqual([]);
    expect(declarations.length).toBe(registered.length);
  });

  /**
   * The git and worktree mutation owner appends these three events around each non-idempotent git
   * effect. `substrate` with `operation-record` claims only that the code that does the operation
   * owns the append. It claims no consumer, provider or gate.
   * The test reads through the port, because `schemas.ts` derives the emission registry through it.
   * The derived source must be `auto`, so no model has to emit a ledger record.
   * `workflow.started` is the negative case: a row of the same table with a different rationale.
   */
  it('VcsLedgerEvents_SubstrateTier_CarryOperationRecordRationale', () => {
    const LEDGER = ['vcs.requested', 'vcs.executed', 'vcs.compensated'] as const;

    for (const eventType of LEDGER) {
      const registration = ANNOTATED_EVENTS.registrationOf(eventType);
      expect(registration, `${eventType} carries no annotation`).toBeDefined();
      expect(registration).toEqual({
        lifecycle: 'active',
        tier: 'substrate',
        rationale: 'operation-record',
      });

      expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('auto');
    }

    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled.length, 'the report-coupled census is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    for (const eventType of LEDGER) expect(reportCoupled).not.toContain(eventType);

    expect(ANNOTATED_EVENTS.registrationOf('workflow.started')).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'transition-record',
    });
  });

  /**
   * `promotion.executed` records the atomic tree promotion in `install/atomic-promotion.ts`.
   * The tier claims only that the promoting code owns the record, with no provider, consumer or
   * gate. The lifecycle is `planned` because no production caller appends the event.
   *
   * The lifecycle resolves before the tier, so the derived source is `planned`. `workflow.started`
   * is a substrate event with the source `auto`, so the tier did not give `planned`.
   * Two rows make the rationale falsifiable. `workflow.started` has a different rationale, and
   * `admission.cutover-ready` has the `capability` tier.
   */
  it('PromotionEvent_SubstrateTier_CarriesOperationRecordRationale', () => {
    const PROMOTION = 'promotion.executed';

    const registration = ANNOTATED_EVENTS.registrationOf(PROMOTION);
    expect(registration, `${PROMOTION} carries no annotation`).toBeDefined();
    expect(registration).toEqual({
      lifecycle: 'planned',
      tier: 'substrate',
      rationale: 'operation-record',
    });

    expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

    expect(EVENT_EMISSION_REGISTRY[PROMOTION]).toBe('planned');

    expect(EVENT_EMISSION_REGISTRY['workflow.started']).toBe('auto');

    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled.length, 'the report-coupled census is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    expect(reportCoupled).not.toContain(PROMOTION);

    expect(ANNOTATED_EVENTS.registrationOf('workflow.started')).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'transition-record',
    });

    const cutoverReady = ANNOTATED_EVENTS.registrationOf('admission.cutover-ready');
    expect(cutoverReady).toBeDefined();
    expect(cutoverReady!.tier).toBe('capability');
    expect(cutoverReady).not.toEqual(registration);
  });

  /**
   * `emission.violated` is the finding of the post-dispatch verifier: a handler completed an
   * operation without an event that its registration declares unconditionally.
   * The verifier appends its own finding, so the derived source is `auto` and no model reports it.
   * `workflow.started` is a substrate row with a different rationale, so the tier alone does not
   * satisfy the equality.
   *
   * The `substrate` tier keeps the event out of the boot-resolved weld set and the stale-cover set.
   * The weld set must be non-empty and hold `task.completed`, so an empty resolver fails here.
   */
  it('EmissionViolation_SubstrateTier_CarriesOperationRecordRationale', () => {
    const VIOLATION = 'emission.violated';

    const registration = ANNOTATED_EVENTS.registrationOf(VIOLATION);
    expect(registration, `${VIOLATION} carries no annotation`).toBeDefined();
    expect(registration).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'operation-record',
    });

    expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

    expect(EVENT_EMISSION_REGISTRY[VIOLATION]).toBe('auto');

    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled.length, 'the report-coupled census is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    expect(reportCoupled).not.toContain(VIOLATION);

    expect(ANNOTATED_EVENTS.registrationOf('workflow.started')).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'transition-record',
    });

    const welds = bootResolvedWelds();
    const eligible = staleCoverEligibleWelds(welds);
    const boundTypes = welds.map((w) => w.eventType);
    expect(boundTypes.length, 'the boot-resolved weld set is empty — it cannot discriminate')
      .toBeGreaterThan(0);
    expect(boundTypes).toContain('task.completed');
    expect(boundTypes).not.toContain(VIOLATION);
    expect(eligible.map((w) => w.eventType)).not.toContain(VIOLATION);
  });

  /**
   * The handler of `execute_intent` appends this operation record, and no caller reports it.
   * The action contract needs a derived source of `auto` and rejects each other source.
   * The test fails when the annotation leaves `substrate`.
   */
  it('IntentExecuted_SubstrateTier_DerivesAutoSource', () => {
    const EXECUTED = 'orchestrate.intent_executed';

    const registration = ANNOTATED_EVENTS.registrationOf(EXECUTED);
    expect(registration, `${EXECUTED} carries no annotation`).toBeDefined();
    expect(registration).toEqual({
      lifecycle: 'active',
      tier: 'substrate',
      rationale: 'operation-record',
    });

    expect(weldReferenceOf(registration!).ref.trim().length).toBeGreaterThan(0);

    expect(EVENT_EMISSION_REGISTRY[EXECUTED]).toBe('auto');

    const reportCoupled = reportCoupledEventTypes(EventTypes);
    expect(reportCoupled).not.toContain(EXECUTED);
  });

  /**
   * The falsifier. `task.completed` has the `capability` tier, which derives `auto`, so the census
   * must report a declared `model` by name.
   * The lifecycle gives the source of a `retired` or `planned` entry directly. Thus `merge.rollback`
   * and `admission.waiver-recorded` are not disagreements, but a retired entry declared `auto` is.
   *
   * The live catalog has zero disagreements, because the registry derives from the annotations.
   * The census skips each type that it cannot resolve, so the test asserts the compared count first.
   */
  it('EventAnnotations_SeededTierSourceDisagreement_IsReported', () => {
    const seeded = tierSourceDisagreements(registryWith({ 'task.completed': 'model' }));
    const seededTypes = seeded.map((d) => d.eventType);
    expect(seededTypes).toContain('task.completed');

    const reported = seeded.find((d) => d.eventType === 'task.completed');
    expect(reported?.code).toBe('TIER_SOURCE_DISAGREEMENT');
    expect(reported?.declared).toBe('model');
    expect(reported?.derived).toBe('auto');
    expect(reported?.tier).toBe('capability');

    expect(seededTypes).not.toContain('merge.rollback');
    expect(seededTypes).not.toContain('admission.waiver-recorded');

    const misdeclaredRetired = tierSourceDisagreements(registryWith({ 'merge.rollback': 'auto' }));
    expect(misdeclaredRetired.map((d) => d.eventType)).toContain('merge.rollback');

    const comparable = Object.keys(EVENT_EMISSION_REGISTRY).filter(
      (eventType) => ANNOTATED_EVENTS.registrationOf(eventType) !== undefined,
    );
    expect(comparable.length).toBe(EventTypes.length);
    const live = tierSourceDisagreements(EVENT_EMISSION_REGISTRY).map((d) => d.eventType);
    expect(live).toEqual([]);
  });

  /**
   * The registry is a projection of the annotations. The test compares it with a second pass over
   * the same table, `reportCoupledEventTypes`. A derivation that drops, defaults or mis-keys an
   * entry fails. A wrong tier does not.
   * The count is computed, and no literal pins it. It must be more than zero.
   *
   * Only `judgment` and `workflow-local` derive `model`, and both must appear, so the count alone
   * is not the whole assertion. `harness` derives `auto`, because a harness composes its payload
   * in code.
   */
  it('EventAnnotations_ReportCoupledCount_IsDerivedAtIntroduction', () => {
    const declaredModelEmitted = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] === 'model',
    ).sort();

    const derivedReportCoupled = reportCoupledEventTypes(EventTypes);

    const seed = derivedReportCoupled.length;
    expect(seed).toBe(declaredModelEmitted.length);
    expect([...derivedReportCoupled]).toEqual([...declaredModelEmitted]);

    expect(seed).toBeGreaterThan(0);

    const tiersInPlay = new Set(
      derivedReportCoupled.map((eventType) => EVENT_ANNOTATIONS[eventType]?.tier),
    );
    expect([...tiersInPlay].sort()).toEqual(['judgment', 'workflow-local']);
  });
});
