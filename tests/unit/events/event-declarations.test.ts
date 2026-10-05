// Tests for the event declaration bridge.
//
// @oracle-sources: ../../../src/events/schemas.ts, ../../../tools/conformance/src/authority-topology.ts
//
// `events/schemas.ts` owns the event types and the emission source of each one.
// `tools/conformance/src/authority-topology.ts` owns the boundary record: the authority of
// `event-catalog` and the representations bound to it. Neither module imports the other, so a
// disagreement between them is a real finding. Neither is the module under test. An expectation
// derived from `event-declarations.ts` is self-consistent by construction.
//
// `tsconfig.json` excludes test files, so the type-level assertions are the exported
// `_EventDeclarations_*` aliases in the source module.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AUTHORITY_TOPOLOGY } from '../../../tools/conformance/src/authority-topology.js';
import { isDeclaration } from '../../../src/contract/declaration.js';
import { withSubject } from '../../../src/contract/declaration-seam.js';
import {
  EVENT_EMISSION_REGISTRY,
  EventTypes,
  getValidEventTypes,
  registerEventType,
  unregisterEventType,
} from '../../../src/events/schemas.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';
import {
  EVENT_DECLARATION_AUTHORITY,
  eventDeclarations,
  isEventEmissionSubject,
  isEventRegistration,
  openEventDeclarationSeam,
  type EventAnnotationSource,
} from '../../../src/events/event-declarations.js';

/** An annotation source that annotates only the types in `table`. */
function annotating(table: Readonly<Record<string, EventRegistration>>): EventAnnotationSource {
  return { registrationOf: (eventType: string) => table[eventType] };
}

const SUBSTRATE: EventRegistration = {
  lifecycle: 'active',
  tier: 'substrate',
  rationale: 'transition-record',
};

describe('DeclarationBridge — carrying the event catalog through the DR-1 envelope', () => {
  /**
   * `schemas.ts` supplies the ids and the subjects. Each type in `EventTypes` has a declaration,
   * which carries the source that `EVENT_EMISSION_REGISTRY` declares.
   * The census also runs in the other direction, which catches a lift that invents an address.
   * `authority-topology.ts` supplies the authority and the count of bound representations.
   * An empty catalog satisfies each filter, so the test asserts the size last.
   */
  it('DeclarationBridge_EventTypesAndRegistry_AreCarriedAsDeclarations', () => {
    const seam = openEventDeclarationSeam();
    const declared = seam.list('event');

    const carried = new Set(declared.map((declaration) => declaration.id));
    const missing = [...EventTypes].filter((eventType) => !carried.has(eventType));
    expect(missing).toEqual([]);

    const sourceMismatches = [...EventTypes].filter((eventType) => {
      const declaration = seam.get('event', eventType);
      if (declaration === undefined) return true;
      const subject = declaration.subject;
      return (
        !isEventEmissionSubject(subject) || subject.source !== EVENT_EMISSION_REGISTRY[eventType]
      );
    });
    expect(sourceMismatches).toEqual([]);

    const registered = new Set(Object.keys(EVENT_EMISSION_REGISTRY));
    const unregistered = declared.filter((declaration) => !registered.has(declaration.id));
    expect(unregistered).toEqual([]);

    const row = AUTHORITY_TOPOLOGY['event-catalog'];
    const expectedAuthority =
      row.authority.kind === 'single' ? row.authority.authority : '<not single-authority>';
    const boundRepresentations = row.representations.filter((r) => r.binding.kind === 'bound');

    const malformed = declared.filter(
      (declaration) =>
        !isDeclaration(declaration) ||
        declaration.kind !== 'event' ||
        declaration.authority !== expectedAuthority ||
        declaration.boundTo.length !== boundRepresentations.length,
    );
    expect(malformed).toEqual([]);

    expect(declared.length).toBeGreaterThan(EventTypes.length - 1);
    expect(seam.has('event', 'workflow.started')).toBe(true);
  });

  /**
   * The lift is a projection out of the stores and not a rewrite of them. `tsc` checks the type
   * half. At runtime, the stores that the consumers read must be equal before and after each entry
   * point runs. A declaration from the seam is frozen, so a consumer cannot write into the catalog
   * through it.
   */
  it('DeclarationBridge_ExistingConsumers_CompileUnchanged', () => {
    const registryBefore = Object.entries(EVENT_EMISSION_REGISTRY);
    const typesBefore = [...EventTypes];
    const validBefore = getValidEventTypes();

    eventDeclarations();
    eventDeclarations(annotating({ 'workflow.started': SUBSTRATE }));
    openEventDeclarationSeam().list('event');

    expect(Object.entries(EVENT_EMISSION_REGISTRY)).toStrictEqual(registryBefore);
    expect([...EventTypes]).toStrictEqual(typesBefore);
    expect(getValidEventTypes()).toStrictEqual(validBefore);

    expect(EVENT_EMISSION_REGISTRY['workflow.started']).toBe(registryBefore[0]?.[1]);

    const declaration = openEventDeclarationSeam().get('event', 'workflow.started');
    expect(declaration).toBeDefined();
    expect(Object.isFrozen(declaration)).toBe(true);
  });

  /**
   * The subject of an unannotated declaration is an emission source, so `withSubject` must return
   * `undefined`. Positive control: the same guard narrows an annotated subject. Without that
   * control, a guard that always returns `false` also passes.
   * Narrowing is per declaration: a type that the annotation source does not name stays
   * un-narrowed in the same seam.
   */
  it('DeclarationBridge_SubjectFailingTheGuard_IsNotNarrowed', () => {
    const unannotated = openEventDeclarationSeam().get('event', 'workflow.started');
    expect(unannotated).toBeDefined();
    if (unannotated === undefined) return;

    expect(withSubject(unannotated, isEventRegistration)).toBeUndefined();

    const annotated = openEventDeclarationSeam(
      annotating({ 'workflow.started': SUBSTRATE }),
    ).get('event', 'workflow.started');
    expect(annotated).toBeDefined();
    if (annotated === undefined) return;

    const narrowed = withSubject(annotated, isEventRegistration);
    expect(narrowed).toBeDefined();
    expect(narrowed?.subject.tier).toBe('substrate');
    expect(narrowed?.id).toBe('workflow.started');

    const sibling = openEventDeclarationSeam(annotating({ 'workflow.started': SUBSTRATE })).get(
      'event',
      'workflow.cancel',
    );
    expect(sibling).toBeDefined();
    if (sibling === undefined) return;
    expect(withSubject(sibling, isEventRegistration)).toBeUndefined();
  });

  /**
   * `EVENT_EMISSION_REGISTRY` is mutable and `EventTypes` is not. A bridge that lifts only the
   * tuple, or that takes a snapshot at module load, drops each custom type.
   * A seam that is already open is a snapshot and must not change.
   */
  it('DeclarationBridge_RuntimeRegisteredEventType_IsCarriedOnReopen', () => {
    const custom = 'probe.declaration-bridge';
    const before = openEventDeclarationSeam();
    expect(before.has('event', custom)).toBe(false);

    registerEventType(custom, { source: 'hook' });
    try {
      const after = openEventDeclarationSeam();
      const declaration = after.get('event', custom);
      expect(declaration).toBeDefined();
      expect(declaration?.authority).toBe(EVENT_DECLARATION_AUTHORITY);
      const subject = declaration?.subject;
      expect(isEventEmissionSubject(subject)).toBe(true);
      if (isEventEmissionSubject(subject)) expect(subject.source).toBe('hook');

      expect(before.has('event', custom)).toBe(false);
    } finally {
      unregisterEventType(custom);
    }

    expect(openEventDeclarationSeam().has('event', custom)).toBe(false);
  });

  it('DeclarationBridge_TwoLifts_ProduceIdenticalOrderedOutput', () => {
    const first = eventDeclarations().map((declaration) => declaration.id);
    const second = eventDeclarations().map((declaration) => declaration.id);
    const sorted = [...first].sort();

    expect(second).toStrictEqual(first);
    expect(first).toStrictEqual(sorted);
    expect(new Set(first).size).toBe(first.length);
  });
});

describe('isEventRegistration — the caller-supplied guard for withSubject', () => {
  it('IsEventRegistration_EveryTierArm_IsAccepted', () => {
    const arms: readonly EventRegistration[] = [
      SUBSTRATE,
      {
        lifecycle: 'active',
        tier: 'capability',
        provider: 'exarchos_orchestrate',
        consumedBy: ['task-store@v1'],
      },
      { lifecycle: 'retired', tier: 'observation', reconciler: 'worktree', groundTruth: 'process' },
      {
        lifecycle: 'planned',
        tier: 'judgment',
        gate: 'test-adequacy',
        contentSchema: z.object({ verdict: z.string() }),
      },
      { lifecycle: 'active', tier: 'workflow-local', workflow: 'my-workflow' },
    ];

    const rejected = arms.filter((registration) => !isEventRegistration(registration));
    expect(rejected).toEqual([]);
  });

  /**
   * The type rejects each of these values. A guard that checks only `typeof` accepts most of them
   * and narrows a subject onto a type that it does not have.
   * The first cases are an emission source and a registration with no weld at each tier but
   * `harness`.
   * The next cases break one closed vocabulary at a time or give a capability no consumer.
   * Two cases give `contentSchema` a value that is not a live schema.
   * The last cases drop or misname the lifecycle or the tier, blank a reference id, or are not
   * objects.
   */
  it('IsEventRegistration_WeldlessOrOutOfVocabularySubjects_AreRejected', () => {
    const accepted = [
      { source: 'auto' },
      { lifecycle: 'active', tier: 'substrate' },
      { lifecycle: 'active', tier: 'capability' },
      { lifecycle: 'active', tier: 'observation' },
      { lifecycle: 'active', tier: 'judgment' },
      { lifecycle: 'active', tier: 'workflow-local' },
      { lifecycle: 'active', tier: 'substrate', rationale: 'because' },
      { lifecycle: 'active', tier: 'observation', reconciler: 'worktree', groundTruth: 'filesystem' },
      { lifecycle: 'active', tier: 'observation', reconciler: 'nothing', groundTruth: 'process' },
      {
        lifecycle: 'active',
        tier: 'judgment',
        gate: 'not-a-gate',
        contentSchema: z.object({}),
      },
      { lifecycle: 'active', tier: 'capability', provider: 'exarchos_orchestrate', consumedBy: [] },
      { lifecycle: 'active', tier: 'capability', provider: 'exarchos_orchestrate', consumedBy: [''] },
      { lifecycle: 'active', tier: 'judgment', gate: 'test-adequacy', contentSchema: {} },
      { lifecycle: 'active', tier: 'judgment', gate: 'test-adequacy', contentSchema: 'z.string()' },
      { tier: 'substrate', rationale: 'transition-record' },
      { lifecycle: 'someday', tier: 'substrate', rationale: 'transition-record' },
      { lifecycle: 'active', tier: 'sixth-tier', rationale: 'transition-record' },
      { lifecycle: 'active', tier: 'workflow-local', workflow: '   ' },
      null,
      undefined,
      'substrate',
      42,
      [],
    ].filter((candidate) => isEventRegistration(candidate));

    expect(accepted).toEqual([]);
  });

  it('IsEventEmissionSubject_ValuesOutsideTheShippedVocabulary_AreRejected', () => {
    expect(isEventEmissionSubject({ source: 'auto' })).toBe(true);
    expect(isEventEmissionSubject({ source: 'retired' })).toBe(true);

    const accepted = [
      { source: 'invented' },
      { source: undefined },
      {},
      null,
      'auto',
      SUBSTRATE,
    ].filter((candidate) => isEventEmissionSubject(candidate));

    expect(accepted).toEqual([]);
  });
});
