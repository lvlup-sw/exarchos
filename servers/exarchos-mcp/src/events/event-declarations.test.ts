// Co-located tests for the DR-1 event declaration bridge (task 008).
//
// @oracle-sources: ./schemas.ts, ../architecture/authority-topology.ts
//
// The two authorities, and why they are two. `events/schemas.ts` owns the event UNIVERSE —
// which types exist and what each one's emission source is. `architecture/authority-topology.ts`
// owns the BOUNDARY record — who the `event-catalog` authority is and what is bound to it. They
// sit in different layers, neither imports the other, and they are maintained by different tasks,
// so a disagreement between them is a real finding rather than a value compared with itself.
// Neither is the module under test: deriving the expectation from `event-declarations.ts` would
// make every assertion here self-consistent by construction.
//
// The COMPILE-time half of the additivity claim is not here. `tsconfig.json` excludes
// `**/*.test.ts`, so type-level assertions in this file would be decorative; they live as
// exported `_EventDeclarations_*` aliases in the source module, where `tsc` actually checks them.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AUTHORITY_TOPOLOGY } from '../architecture/authority-topology.js';
import { isDeclaration } from '../contract/declaration.js';
import { withSubject } from '../contract/declaration-seam.js';
import {
  EVENT_EMISSION_REGISTRY,
  EventTypes,
  getValidEventTypes,
  registerEventType,
  unregisterEventType,
} from './schemas.js';
import type { EventRegistration } from './event-registration.js';
import {
  EVENT_DECLARATION_AUTHORITY,
  eventDeclarations,
  isEventEmissionSubject,
  isEventRegistration,
  openEventDeclarationSeam,
  type EventAnnotationSource,
} from './event-declarations.js';

/** An annotation source that annotates exactly the types named, and nothing else. */
function annotating(table: Readonly<Record<string, EventRegistration>>): EventAnnotationSource {
  return { registrationOf: (eventType: string) => table[eventType] };
}

const SUBSTRATE: EventRegistration = {
  lifecycle: 'active',
  tier: 'substrate',
  rationale: 'transition-record',
};

describe('DeclarationBridge — carrying the event catalog through the DR-1 envelope', () => {
  it('DeclarationBridge_EventTypesAndRegistry_AreCarriedAsDeclarations', () => {
    const seam = openEventDeclarationSeam();
    const declared = seam.list('event');

    // AUTHORITY 1 (`schemas.ts`) — the id population. Every built-in event type in `EventTypes`
    // has a declaration at its own address, so the tuple is carried in full.
    const carried = new Set(declared.map((declaration) => declaration.id));
    const missing = [...EventTypes].filter((eventType) => !carried.has(eventType));
    expect(missing).toEqual([]);

    // AUTHORITY 1 again, on the other store — the SUBJECT. Each declaration carries the emission
    // source `EVENT_EMISSION_REGISTRY` declares for it, which is what makes this a lift of the
    // registry rather than a lift of the name list.
    const sourceMismatches = [...EventTypes].filter((eventType) => {
      const declaration = seam.get('event', eventType);
      if (declaration === undefined) return true;
      const subject = declaration.subject;
      return (
        !isEventEmissionSubject(subject) || subject.source !== EVENT_EMISSION_REGISTRY[eventType]
      );
    });
    expect(sourceMismatches).toEqual([]);

    // The registry is the LIVE key set, so nothing may be carried that no store declares — the
    // other direction of the census, which catches a lift that invents addresses.
    const registered = new Set(Object.keys(EVENT_EMISSION_REGISTRY));
    const unregistered = declared.filter((declaration) => !registered.has(declaration.id));
    expect(unregistered).toEqual([]);

    // AUTHORITY 2 (`authority-topology.ts`) — identity and topology. Every record must be a
    // well-formed declaration naming the boundary's authority, with the binding state that
    // table actually records.
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

    // Non-vacuity: an empty catalog would satisfy every filter above.
    expect(declared.length).toBeGreaterThan(EventTypes.length - 1);
    expect(seam.has('event', 'workflow.started')).toBe(true);
  });

  it('DeclarationBridge_ExistingConsumers_CompileUnchanged', () => {
    // The claim is that lifting is a PROJECTION out of the stores, never a rewrite of them, so no
    // existing registration site or consumer had to change. `tsc` checks the type half (and the
    // `_EventDeclarations_*` proofs in the source module pin the specific substitutions). What is
    // checkable at runtime is the other half of "unchanged": the stores every existing consumer
    // reads must be byte-identical, and identical by OBJECT IDENTITY, after the bridge has run.
    const registryBefore = Object.entries(EVENT_EMISSION_REGISTRY);
    const typesBefore = [...EventTypes];
    const validBefore = getValidEventTypes();

    // Exercise every entry point, including the annotated path task 010 will use.
    eventDeclarations();
    eventDeclarations(annotating({ 'workflow.started': SUBSTRATE }));
    openEventDeclarationSeam().list('event');

    expect(Object.entries(EVENT_EMISSION_REGISTRY)).toStrictEqual(registryBefore);
    expect([...EventTypes]).toStrictEqual(typesBefore);
    expect(getValidEventTypes()).toStrictEqual(validBefore);

    // The bridge must not have substituted a copy of the store for the store: a consumer holding
    // the shipped binding and the bridge must be looking at the same object.
    expect(EVENT_EMISSION_REGISTRY['workflow.started']).toBe(registryBefore[0]?.[1]);

    // A consumer cannot write back INTO the catalog through a declaration it was handed.
    const declaration = openEventDeclarationSeam().get('event', 'workflow.started');
    expect(declaration).toBeDefined();
    expect(Object.isFrozen(declaration)).toBe(true);
  });

  it('DeclarationBridge_SubjectFailingTheGuard_IsNotNarrowed', () => {
    const unannotated = openEventDeclarationSeam().get('event', 'workflow.started');
    expect(unannotated).toBeDefined();
    if (unannotated === undefined) return;

    // The subject is an emission source, not a DR-2 registration. `withSubject` must hand back
    // `undefined` rather than a declaration typed as something nothing checked.
    expect(withSubject(unannotated, isEventRegistration)).toBeUndefined();

    // POSITIVE CONTROL — the same guard, the same seam, an annotated subject. Without this the
    // assertion above would pass just as well against a guard that always returns false.
    const annotated = openEventDeclarationSeam(
      annotating({ 'workflow.started': SUBSTRATE }),
    ).get('event', 'workflow.started');
    expect(annotated).toBeDefined();
    if (annotated === undefined) return;

    const narrowed = withSubject(annotated, isEventRegistration);
    expect(narrowed).toBeDefined();
    expect(narrowed?.subject.tier).toBe('substrate');
    expect(narrowed?.id).toBe('workflow.started');

    // Narrowing is per-declaration, not per-seam: the types the annotation source did not name
    // stay un-narrowed in the very same seam.
    const sibling = openEventDeclarationSeam(annotating({ 'workflow.started': SUBSTRATE })).get(
      'event',
      'workflow.cancel',
    );
    expect(sibling).toBeDefined();
    if (sibling === undefined) return;
    expect(withSubject(sibling, isEventRegistration)).toBeUndefined();
  });

  it('DeclarationBridge_RuntimeRegisteredEventType_IsCarriedOnReopen', () => {
    // `EVENT_EMISSION_REGISTRY` is mutable and `EventTypes` is not, so a bridge that lifted only
    // the tuple — or that snapshotted at module load — would silently drop every custom type.
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

      // The already-opened seam is a snapshot and must NOT have changed underneath its holder.
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

  it('IsEventRegistration_WeldlessOrOutOfVocabularySubjects_AreRejected', () => {
    // Each of these is a value the TYPE rejects. A guard that merely asserted — `typeof x ===
    // 'object'`, or a per-field `typeof x.rationale === 'string'` — would accept most of them and
    // narrow a subject onto a type it does not inhabit.
    const accepted = [
      // the un-annotated arm: a source is not a coupling declaration
      { source: 'auto' },
      // weldless: tier + lifecycle and nothing else, at every tier
      { lifecycle: 'active', tier: 'substrate' },
      { lifecycle: 'active', tier: 'capability' },
      { lifecycle: 'active', tier: 'observation' },
      { lifecycle: 'active', tier: 'judgment' },
      { lifecycle: 'active', tier: 'workflow-local' },
      // closed vocabularies, violated one at a time
      { lifecycle: 'active', tier: 'substrate', rationale: 'because' },
      { lifecycle: 'active', tier: 'observation', reconciler: 'worktree', groundTruth: 'filesystem' },
      { lifecycle: 'active', tier: 'observation', reconciler: 'nothing', groundTruth: 'process' },
      {
        lifecycle: 'active',
        tier: 'judgment',
        gate: 'not-a-gate',
        contentSchema: z.object({}),
      },
      // a capability nobody consumes is a report with extra steps
      { lifecycle: 'active', tier: 'capability', provider: 'exarchos_orchestrate', consumedBy: [] },
      { lifecycle: 'active', tier: 'capability', provider: 'exarchos_orchestrate', consumedBy: [''] },
      // `contentSchema` must be a live schema, not a schema-shaped stub
      { lifecycle: 'active', tier: 'judgment', gate: 'test-adequacy', contentSchema: {} },
      { lifecycle: 'active', tier: 'judgment', gate: 'test-adequacy', contentSchema: 'z.string()' },
      // lifecycle and tier are both required, and both are closed
      { tier: 'substrate', rationale: 'transition-record' },
      { lifecycle: 'someday', tier: 'substrate', rationale: 'transition-record' },
      { lifecycle: 'active', tier: 'sixth-tier', rationale: 'transition-record' },
      // blank open-reference ids are not references
      { lifecycle: 'active', tier: 'workflow-local', workflow: '   ' },
      // non-objects
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
