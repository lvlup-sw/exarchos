// RESERVED(issue: #1473, owner: exarchos, expires: 2026-11-30) — the DR-1 declaration bridge.
// Production code whose production consumers land next: task 010 supplies the annotations this
// module already accepts, task 013 censuses the report-coupled population through the seam it
// opens, and #1258 replaces `eventDeclarationSource` with a read of the Workflow Builder IR.
// Deliberately NOT filed as `declared-test-infra` — this is not gate machinery, it is the lift
// that puts the event catalog behind the declaration seam, and misfiling it would buy a permanent
// DR-7 exemption for a module that is load-bearing from task 010 onward. If those tasks never
// land, this expires and is deleted.
//
// ─── The declaration bridge for the event catalog (DR-1, task 008) ───────────
//
// `EventTypes` and `EVENT_EMISSION_REGISTRY` — the 170 built-in event declarations plus whatever
// `registerEventType` has added at runtime — carried as {@link Declaration} records so the
// declaration SITE can be relocated by #1258 without any consumer being re-bound.
//
// ## Why the envelope wraps the DATA and not `registerEventType`
//
// `registerEventType` is the runtime write seam, and it THROWS on every built-in name
// (`schemas.ts`, `BUILT_IN_EVENT_TYPES`). Anchoring the bridge there would have carried zero of
// the 170 shipped declarations and produced an envelope that was empty in every real process.
// The declarations live in the tuple and the record, so that is what is lifted.
//
// ## One declaration per event type, not two mega-declarations
//
// `Declaration` is addressable by `(kind, id)` and exists so a declaration can MOVE HOUSE
// intact. A single record whose subject was the whole 170-entry table would be storage smuggled
// through the envelope: it has one address, so relocating it relocates nothing. So `EventTypes`
// supplies the ids and `EVENT_EMISSION_REGISTRY` supplies the subjects, and both are carried.
//
// ## Read at CALL time, not at module load
//
// `EVENT_EMISSION_REGISTRY` is mutable: `registerEventType` writes custom types into it and
// `unregisterEventType` removes them. A frozen module-level array would snapshot the built-ins
// and silently miss every custom registration. {@link eventDeclarationSource} therefore lifts on
// each `read()`, which composes exactly with `openDeclarationSeam`'s documented contract — a seam
// snapshots its source once, and you re-open it to observe new declarations.
//
// ## Additivity — the hard constraint
//
// `events/schemas.ts` is NOT touched by this task: not the tuple, not the registry, not
// `registerEventType`. Lifting is a projection *out of* those values, so every existing
// registration site and every existing consumer compiles unchanged. The proofs at the bottom of
// this file pin the half of that claim `tsc` can check.
//
// ## Why this module is allowed to import both sides
//
// It imports the declaration contract AND a declaration store, which is the shape
// `layer-boundaries-seam.ts` reports as `DIRECT_STORAGE_READ`. That is correct and intended: a
// LIFT is the one job that necessarily touches both, so this module is declared a
// {@link DeclarationSourceAdapter} in `DECLARATION_SEAM.sourceAdapters` — the exemption Wave 1a
// left empty for exactly this. The exemption is not free cover: `STALE_SOURCE_ADAPTER` fails the
// census if this module ever stops importing the store it claims to adapt. Consumers get no such
// exemption; they call {@link openEventDeclarationSeam} and never see `schemas.ts`.
// ────────────────────────────────────────────────────────────────────────────

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
// Type-only, and solely for `_EventDeclarations_AnnotatedEvents_ImplementsThePort` below: the port
// names its implementation so the implementation need not name the port. Erased at compile time,
// so it adds no runtime edge and no cycle (`schemas.ts` -> `event-annotations.ts` is the live one).
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

// ─── Identity and topology ──────────────────────────────────────────────────

/**
 * The single source that OWNS every event declaration.
 *
 * The same id the authority-topology table records for the `event-catalog` boundary
 * (`architecture/authority-topology.ts`: `{ kind: 'single', authority: 'EVENT_EMISSION_REGISTRY' }`).
 * That table is NOT imported: it is an architecture-layer census *about* the tree, and a
 * production lift that read it would invert the direction — the census reads the source, never
 * the reverse. Agreement between the two is pinned by the co-located test instead, which is a
 * real two-authority comparison rather than a self-consistent derivation.
 */
export const EVENT_DECLARATION_AUTHORITY: AuthorityId = 'EVENT_EMISSION_REGISTRY';

/**
 * Representations mechanically bound to {@link EVENT_DECLARATION_AUTHORITY}: none, today.
 *
 * Not an oversight and not a stub — it is the measured state of the `event-catalog` row. That row
 * carries one *authoritative* representation (the registry itself) and three *unbound* ones (the
 * `autoEmits` rows, `PHASE_EXPECTED_EVENTS`, and skill prose); it carries no `bound` one, because
 * nothing regenerates any representation from the registry. `boundTo` MEANS mechanically bound,
 * so claiming any of them here would launder the DR-20 finding into a false binding. The census
 * that reports unbound representations reads the difference between the representation universe
 * and the union of every `boundTo[]`, and an honest empty list is what makes that difference
 * visible.
 */
const EVENT_DECLARATION_BOUND_TO: readonly string[] = [];

// ─── The subject, in its two migration states ───────────────────────────────

/**
 * The un-annotated subject: what `EVENT_EMISSION_REGISTRY` actually holds for one event type,
 * and nothing more.
 *
 * `source` records AUTHORSHIP — who composes the payload — which is precisely the property DR-2
 * found insufficient. Carrying it verbatim is the honest thing for this task to do: task 008
 * relocates the declaration, task 010 decides what each one is welded to.
 */
export interface EventEmissionSubject {
  /** The emission source `EVENT_EMISSION_REGISTRY` declares for this event type. */
  readonly source: EventEmissionSource;
}

/**
 * What an event declaration carries — a union with one arm per MIGRATION STATE, which is the
 * shape that lets task 010 annotate without reshaping anything here.
 *
 * Today every declaration takes the {@link EventEmissionSubject} arm. Task 010 supplies an
 * {@link EventAnnotationSource} and each annotated type flips to the {@link EventRegistration}
 * arm — a change of VALUES flowing through an unchanged type, one event at a time, with a
 * half-migrated catalog perfectly representable in between. A subject fixed to `EventRegistration`
 * would have forced task 010 to be atomic across all 170; a subject fixed to
 * `EventEmissionSubject` would have forced task 010 to reshape this module.
 *
 * The two arms are DISJOINT (`_EventDeclarations_EmissionSubjectIsNotARegistration`), which is
 * what makes {@link isEventRegistration} a real discriminator rather than a coin flip.
 */
export type EventSubject = EventEmissionSubject | EventRegistration;

/**
 * The emission vocabulary in DATA form, needed because {@link isEventEmissionSubject} must decide
 * membership at runtime and `schemas.ts` exports the type only.
 *
 * Declared here rather than in `schemas.ts` to keep this task's edit count at the storage module
 * exactly zero, and bound to the shipped union by
 * `_EventDeclarations_EmissionSourceData_MatchesTheUnion` so it cannot drift into a second
 * authority for the vocabulary.
 */
const EVENT_EMISSION_SOURCES: readonly ['auto', 'model', 'hook', 'planned', 'retired'] = [
  'auto',
  'model',
  'hook',
  'planned',
  'retired',
];

// ─── The annotation port (task 010's substitution point) ────────────────────

/**
 * Where a lifted declaration's DR-2 registration comes from, if it has one yet.
 *
 * A port rather than a table, for the same reason `openDeclarationSeam` takes its store by
 * interface: task 010 substitutes an implementation and edits nothing here. Shipping an empty
 * `Record` constant instead would have put a placeholder with no members into production and made
 * "not yet annotated" indistinguishable from "annotation lookup is broken".
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
 * The Wave-1b state of the world: nothing is annotated. The default for every entry point here,
 * so task 008's own output is honest about carrying authorship and not coupling.
 */
export const UNANNOTATED_EVENTS: EventAnnotationSource = Object.freeze({
  registrationOf: (): EventRegistration | undefined => undefined,
});

// ─── The lift ───────────────────────────────────────────────────────────────

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
 * Lift every registered event type into the declaration envelope.
 *
 * Both stores are read, and the order is load-bearing. `EventTypes` goes first because it is the
 * BUILT-IN universe and its totality is a compile-time guarantee — `EVENT_EMISSION_REGISTRY` is
 * typed `Record<EventType, EventEmissionSource>`, so every member of the tuple provably has a
 * source and no built-in can be dropped by a mis-keyed lookup. The registry's own keys are then
 * swept for anything the tuple does not name, which is exactly the set `registerEventType` added
 * at runtime. Neither read alone carries the catalog: the tuple misses every custom type, and the
 * registry alone would give up the totality proof.
 *
 * Sorted by id, so two lifts of the same inputs are byte-identical — the determinism rule
 * `makeDeclaration` applies to `boundTo` and `partitionByKind` applies to its buckets.
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
 * The event catalog as a {@link DeclarationSource} — the port `openDeclarationSeam` consumes, and
 * the ONE thing #1258 replaces.
 *
 * `read()` re-lifts on every call rather than closing over a snapshot, so a seam opened after a
 * `registerEventType` sees the new declaration.
 */
export function eventDeclarationSource(
  annotations: EventAnnotationSource = UNANNOTATED_EVENTS,
): DeclarationSource {
  return Object.freeze({
    read: (): Iterable<AnyDeclaration> => eventDeclarations(annotations),
  });
}

/**
 * Open a read-only seam over the event catalog. **The entry point consumers should use.**
 *
 * Exists so that reading an event declaration requires no consumer to name a store, a lift, or
 * even a `DeclarationSource`: one call yields the seam, and DR-1's rule — declarations arrive
 * through the accessor — becomes the path of least resistance rather than a convention.
 */
export function openEventDeclarationSeam(
  annotations: EventAnnotationSource = UNANNOTATED_EVENTS,
): DeclarationSeam {
  return openDeclarationSeam(eventDeclarationSource(annotations));
}

// ─── The subject guards (the caller-supplied half of `withSubject`) ──────────
//
// `contract/declaration-seam.ts` hands out `Declaration<K>` with an `unknown` subject and narrows
// only through a guard the CONSUMER supplies — the deliberate consequence of keeping the envelope
// storage-agnostic. Task 009 shipped no guard because writing one blind would have meant guessing
// at the runtime check. This module is the first consumer, so the guards are here.
//
// They VALIDATE. Every closed vocabulary is checked against its data form, every required field
// of every arm must be present and well-typed, and `consumedBy` must be non-empty — so a value
// this guard accepts is a value the TYPE accepts. The open reference aliases (`provider`,
// `consumedBy` members, `workflow`) are checked as non-empty strings, which is faithful to what
// those aliases promise; whether the id RESOLVES is task 012's boot-time job, the same split
// `contract/ir/references.ts` draws between structural validity and referential soundness.

/**
 * Membership in a closed vocabulary's data form.
 *
 * `.some` rather than `.includes` for the reason `contract/declaration.ts` gives: `includes` on a
 * literal tuple rejects an `unknown` argument and the usual repair is a widening assertion.
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
 * A non-empty consumer list. The emptiness check is the point: `CapabilityRegistration.consumedBy`
 * is a non-empty tuple precisely so "declared a capability, consumed by nobody" — a report with
 * extra steps — does not compile, and a guard that accepted `[]` would hand that form back at
 * runtime.
 */
function isNonEmptyConsumerList(value: unknown): value is readonly [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0) return false;
  // `Array.isArray` narrows `unknown` to `any[]`; re-binding at `readonly unknown[]` contains
  // that `any` rather than letting it propagate into the `.every` callback position.
  const consumers: readonly unknown[] = value;
  return consumers.every(isNonEmptyString);
}

/**
 * A live Zod schema, checked structurally by the two methods every consumer of `contentSchema`
 * actually calls. This is the one field DR-2 knowingly allows to be behaviour rather than data,
 * so a structural probe is the only check available — and it is a real one: a plain object, a
 * string, or a schema-shaped stub missing `safeParse` all fail.
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
 * The guard `withSubject` needs to narrow an event declaration onto {@link EventRegistration}.
 *
 * Fail-closed and arm-exact. The `switch` has no `default` beyond the exhaustiveness binding, so
 * a sixth tier added to `EventTierVariant` without a case here is a `tsc` error naming the
 * unhandled variant — the same tooth `weldReferenceOf` carries, which is what stops this guard
 * from silently rejecting (or, worse, blanket-accepting) a tier nobody taught it about.
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
    default: {
      const unhandled: never = tier;
      return unhandled;
    }
  }
}

// ─── Compile-time proofs (the real gate is `tsc --noEmit`) ──────────────────
//
// Exported type aliases in a NON-TEST source file, per the `_Pola*` idiom and the precedent set
// by `contract/declaration.ts` and `event-registration.ts`: `tsconfig.json` excludes
// `**/*.test.ts`, so the same assertions written in the co-located test would never be checked by
// the build. These are the compile half of
// `DeclarationBridge_ExistingConsumers_CompileUnchanged`; the test file carries the runtime half.

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
 * **The additivity proof.** A lifted declaration widens to the form the seam accessor hands out,
 * so `DeclarationSeam.get`/`list` — written against `Declaration<K>` in Wave 1a, before this
 * subject existed — keep compiling untouched. This is `_DeclarationSubjectWidensToUnknown`
 * discharged at a real consumer rather than on a hypothetical `{ source: 'auto' }`.
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
 * **The no-reshape guarantee for task 010.** A DR-2 registration is already a valid subject, so
 * annotating an event type changes a VALUE and reshapes no type here. Fixing `EventSubject` to
 * the emission arm alone flips this to `false`.
 * @proof
 */
export type _EventDeclarations_RegistrationIsUsableAsSubject = Expect<
  Assignable<EventRegistration, EventSubject>
>;

/**
 * The two migration arms are disjoint: an emission subject is NOT a registration. Without this,
 * {@link isEventRegistration} could be trivially satisfied by the un-annotated arm and the
 * `SubjectFailingTheGuard` test would be passing for the wrong reason.
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
 * The shipped annotation table satisfies the port task 008 opened. If {@link EventAnnotationSource}
 * ever changes shape this is where it is felt — not in {@link eventDeclarations}, which would keep
 * compiling against {@link UNANNOTATED_EVENTS} and silently carry an un-annotated catalog.
 *
 * **Lives here rather than in `event-annotations.ts` (task 011).** It is the same assertion checked
 * by the same `tsc` run, but writing it there would require that module to NAME this one — and
 * `schemas.ts` imports `event-annotations.ts` to derive `EVENT_EMISSION_REGISTRY`, so the type-only
 * specifier would make `contract/declaration.ts` statically reachable from every registration site
 * and falsify DR-1's claim that the two can genuinely disagree. The dependency runs the correct way
 * around here: the port's module names its implementation, and `import type` keeps the edge off the
 * runtime graph.
 @proof
 * */
export type _EventDeclarations_AnnotatedEvents_ImplementsThePort = Expect<
  Assignable<typeof ANNOTATED_EVENTS, EventAnnotationSource>
>;
