// RESERVED(issue: #1473, owner: exarchos, expires: 2026-11-30) — the declaration bridge for the
// event catalog. Each registered event type is one {@link Declaration} record, so the
// declaration site can move without a new binding for any consumer.
//
// The bridge lifts the data in `EventTypes` and `EVENT_EMISSION_REGISTRY`. It does not wrap
// `registerEventType`, because that function throws on every built-in name. The lift runs at
// call time, because `registerEventType` and `unregisterEventType` change the registry. The lift
// reads `schemas.ts` and changes nothing in it.
//
// This module imports the declaration contract and a declaration store. The seam census reports
// that shape as `DIRECT_STORAGE_READ`, but a lift needs both. This module is therefore a
// {@link DeclarationSourceAdapter} in `DECLARATION_SEAM.sourceAdapters`. `STALE_SOURCE_ADAPTER`
// fails the census if this module stops importing the store. Consumers call
// {@link openEventDeclarationSeam} and never see `schemas.ts`.

import type { z } from 'zod';
import {
  declareEvent,
  type AnyDeclaration,
  type AuthorityId,
  type Declaration,
} from '../contract/declaration.js';
import {
  openDeclarationSeam,
  type DeclarationSeam,
  type DeclarationSource,
} from '../contract/declaration-seam.js';
import {
  EVENT_EMISSION_REGISTRY,
  EventTypes,
  type EventEmissionSource,
} from './schemas.js';
import type { ANNOTATED_EVENTS } from './event-annotations.js';
import {
  EVENT_LIFECYCLES,
  EVENT_TIERS,
  GROUND_TRUTH_SOURCES,
  JUDGMENT_GATE_CLASSES,
  RECONCILER_IDS,
  SUBSTRATE_RATIONALES,
  type EventRegistration,
  type EventTier,
} from './event-registration.js';

/**
 * The single source that owns every event declaration. The authority-topology table records the
 * same id for the `event-catalog` boundary. This module does not import that table, because the
 * census reads the source and never the reverse. A test compares the two.
 */
export const EVENT_DECLARATION_AUTHORITY: AuthorityId = 'EVENT_EMISSION_REGISTRY';

/**
 * The representations that are mechanically bound to {@link EVENT_DECLARATION_AUTHORITY}. The list
 * is empty because nothing regenerates a representation from the registry. The `autoEmits` rows,
 * `PHASE_EVENT_CONTRACTS` and skill prose are unbound, and the census reports them.
 */
const EVENT_DECLARATION_BOUND_TO: readonly string[] = [];

/**
 * The subject without an annotation: the emission source that `EVENT_EMISSION_REGISTRY` holds for
 * one event type. `source` records who writes the payload, not what the event is welded to.
 */
export interface EventEmissionSubject {
  /** The emission source `EVENT_EMISSION_REGISTRY` declares for this event type. */
  readonly source: EventEmissionSource;
}

/**
 * What an event declaration carries, with one arm for each migration state. An event type with an
 * annotation takes the {@link EventRegistration} arm. An event type without one takes the
 * {@link EventEmissionSubject} arm. The two arms are disjoint, so {@link isEventRegistration} can
 * tell them apart.
 */
export type EventSubject = EventEmissionSubject | EventRegistration;

/**
 * The emission vocabulary as data, because {@link isEventEmissionSubject} checks membership at
 * runtime and `schemas.ts` exports only the type. A compile-time proof binds it to the union.
 */
const EVENT_EMISSION_SOURCES: readonly ['auto', 'model', 'hook', 'planned', 'retired'] = [
  'auto',
  'model',
  'hook',
  'planned',
  'retired',
];

/**
 * Supplies the registration for a lifted declaration, when the event type has one. A caller
 * substitutes an implementation through this port, with no edit to this module.
 */
export interface EventAnnotationSource {
  /**
   * The registration for an event type, or `undefined` when it is not yet annotated.
   *
   * Takes a `string`, not an `EventType`: runtime-registered custom types are carried too, and
   * they are absent from the built-in union by construction.
   */
  registrationOf(eventType: string): EventRegistration | undefined;
}

/**
 * The annotation source with no annotations. Every entry point here uses it by default, so each
 * declaration then carries only its emission source.
 */
export const UNANNOTATED_EVENTS: EventAnnotationSource = Object.freeze({
  registrationOf: (): EventRegistration | undefined => undefined,
});

function liftOne(
  id: string,
  source: EventEmissionSource,
  annotations: EventAnnotationSource,
): Declaration<'event', EventSubject> {
  const registration = annotations.registrationOf(id);
  return declareEvent<EventSubject>({
    id,
    authority: EVENT_DECLARATION_AUTHORITY,
    boundTo: EVENT_DECLARATION_BOUND_TO,
    subject: registration ?? { source },
  });
}

/**
 * Lift every registered event type into the declaration envelope, sorted by id.
 *
 * The lift reads `EventTypes` first. The registry type is `Record<EventType, EventEmissionSource>`,
 * so each built-in has a source. Then the lift reads the registry keys that the tuple does not
 * name. These are the custom types that `registerEventType` added at runtime.
 */
export function eventDeclarations(
  annotations: EventAnnotationSource = UNANNOTATED_EVENTS,
): readonly Declaration<'event', EventSubject>[] {
  const byId = new Map<string, Declaration<'event', EventSubject>>();

  for (const eventType of EventTypes) {
    byId.set(eventType, liftOne(eventType, EVENT_EMISSION_REGISTRY[eventType], annotations));
  }

  for (const [name, source] of Object.entries(EVENT_EMISSION_REGISTRY)) {
    if (byId.has(name)) continue;
    byId.set(name, liftOne(name, source, annotations));
  }

  return Object.freeze(
    [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

/**
 * The event catalog as a {@link DeclarationSource} for `openDeclarationSeam`. `read()` lifts
 * again on each call, so a seam opened after `registerEventType` sees the new declaration.
 */
export function eventDeclarationSource(
  annotations: EventAnnotationSource = UNANNOTATED_EVENTS,
): DeclarationSource {
  return Object.freeze({
    read: (): Iterable<AnyDeclaration> => eventDeclarations(annotations),
  });
}

/**
 * Open a read-only seam over the event catalog. Consumers use this entry point, so no consumer
 * names a store, a lift, or a `DeclarationSource`.
 */
export function openEventDeclarationSeam(
  annotations: EventAnnotationSource = UNANNOTATED_EVENTS,
): DeclarationSeam {
  return openDeclarationSeam(eventDeclarationSource(annotations));
}

/**
 * A membership guard for the data form of a closed vocabulary. It uses `.some`, because
 * `.includes` on a literal tuple rejects an `unknown` argument.
 */
function memberOf<T extends string>(vocabulary: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T =>
    typeof value === 'string' && vocabulary.some((member) => member === value);
}

const isEventEmissionSource = memberOf(EVENT_EMISSION_SOURCES);
const isEventTier = memberOf(EVENT_TIERS);
const isEventLifecycle = memberOf(EVENT_LIFECYCLES);
const isSubstrateRationale = memberOf(SUBSTRATE_RATIONALES);
const isReconcilerId = memberOf(RECONCILER_IDS);
const isGroundTruthSource = memberOf(GROUND_TRUTH_SOURCES);
const isJudgmentGateClass = memberOf(JUDGMENT_GATE_CLASSES);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A non-empty list of non-empty consumer ids. `CapabilityRegistration.consumedBy` is a non-empty
 * tuple, so a guard that accepts `[]` brings back at runtime a form that does not compile.
 * The body binds the array as `readonly unknown[]`, so the `any` from `Array.isArray` does not
 * reach the `.every` callback.
 */
function isNonEmptyConsumerList(value: unknown): value is readonly [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const consumers: readonly unknown[] = value;
  return consumers.every(isNonEmptyString);
}

/**
 * A live Zod schema, checked by the two methods that each consumer of `contentSchema` calls.
 * This field is behavior, not data, so a structural probe is the only check available.
 */
function isZodSchema(value: unknown): value is z.ZodSchema {
  if (value === null || typeof value !== 'object') return false;
  if (!('safeParse' in value) || typeof value.safeParse !== 'function') return false;
  return 'parse' in value && typeof value.parse === 'function';
}

/** The un-annotated arm: an emission source drawn from the shipped vocabulary, and nothing else. */
export function isEventEmissionSubject(value: unknown): value is EventEmissionSubject {
  if (value === null || typeof value !== 'object') return false;
  return 'source' in value && isEventEmissionSource(value.source);
}

/**
 * The guard that `withSubject` needs to narrow an event declaration onto {@link EventRegistration}.
 *
 * The guard checks each closed vocabulary against its data form, and each required field of each
 * arm. An open reference (`provider`, `module`, `workflow`, a consumer id) only needs to be a
 * non-empty string. The boot step in `registration-validate.ts` checks that it resolves.
 * The `switch` is exhaustive, so a new tier without a case here is a `tsc` error.
 */
export function isEventRegistration(value: unknown): value is EventRegistration {
  if (value === null || typeof value !== 'object') return false;
  if (!('lifecycle' in value) || !isEventLifecycle(value.lifecycle)) return false;
  if (!('tier' in value) || !isEventTier(value.tier)) return false;

  const tier: EventTier = value.tier;
  switch (tier) {
    case 'substrate':
      return 'rationale' in value && isSubstrateRationale(value.rationale);
    case 'capability':
      return (
        'provider' in value &&
        isNonEmptyString(value.provider) &&
        'consumedBy' in value &&
        isNonEmptyConsumerList(value.consumedBy)
      );
    case 'observation':
      return (
        'reconciler' in value &&
        isReconcilerId(value.reconciler) &&
        'groundTruth' in value &&
        isGroundTruthSource(value.groundTruth)
      );
    case 'judgment':
      return (
        'gate' in value &&
        isJudgmentGateClass(value.gate) &&
        'contentSchema' in value &&
        isZodSchema(value.contentSchema)
      );
    case 'workflow-local':
      return 'workflow' in value && isNonEmptyString(value.workflow);
    case 'harness':
      return (
        'module' in value &&
        isNonEmptyString(value.module) &&
        'consumedBy' in value &&
        isNonEmptyConsumerList(value.consumedBy)
      );
    default: {
      const unhandled: never = tier;
      return unhandled;
    }
  }
}

type Expect<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type NotAssignable<A, B> = [A] extends [B] ? false : true;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * {@link EVENT_EMISSION_SOURCES} is exactly the shipped `EventEmissionSource`, both directions.
 * @proof
 */
export type _EventDeclarations_EmissionSourceData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof EVENT_EMISSION_SOURCES)[number], EventEmissionSource>
>;

/**
 * A lifted declaration widens to the form that the seam accessor returns. `DeclarationSeam.get`
 * and `list` therefore compile with no change.
 * @proof
 */
export type _EventDeclarations_LiftedSubjectWidensToTheSeamForm = Expect<
  Assignable<Declaration<'event', EventSubject>, Declaration<'event'>>
>;

/**
 * A lifted declaration is an instance of the one envelope — nothing sits outside the union.
 * @proof
 */
export type _EventDeclarations_LiftedDeclarationIsAnyDeclaration = Expect<
  Assignable<Declaration<'event', EventSubject>, AnyDeclaration>
>;

/**
 * A registration is already a valid subject, so an annotation changes a value and no type.
 * @proof
 */
export type _EventDeclarations_RegistrationIsUsableAsSubject = Expect<
  Assignable<EventRegistration, EventSubject>
>;

/**
 * The two arms are disjoint: an emission subject is not a registration. Without this proof, the
 * arm without an annotation can satisfy {@link isEventRegistration} and give a false test pass.
 * @proof
 */
export type _EventDeclarations_EmissionSubjectIsNotARegistration = Expect<
  NotAssignable<EventEmissionSubject, EventRegistration>
>;

/**
 * The lift does not narrow the store: every `EventEmissionSource` the registry can hold is a
 * subject this bridge can carry. A `planned` or `retired` event is carried like any other, so the
 * lifted catalog is the whole catalog rather than the emitted part of it.
 * @proof
 */
export type _EventDeclarations_EverySourceIsCarryable = Expect<
  Assignable<{ readonly source: EventEmissionSource }, EventSubject>
>;

/**
 * The shipped annotation table implements the port. A change to the shape of
 * {@link EventAnnotationSource} fails here, not in {@link eventDeclarations}.
 * The proof is in this module because `event-annotations.ts` must not name the port. That name
 * makes `contract/declaration.ts` reachable from every registration site.
 * @proof
 */
export type _EventDeclarations_AnnotatedEvents_ImplementsThePort = Expect<
  Assignable<typeof ANNOTATED_EVENTS, EventAnnotationSource>
>;
