// ─── The declaration seam accessor (DR-1, task 006) ─────────────────────────
//
// THE ONE WAY TO READ A DECLARATION. Every consumer of an event-tier, action or
// CLI-verb declaration obtains it from a {@link DeclarationSeam}; nobody reaches
// into the registry storage that currently holds those declarations. The rule
// that keeps it true is mechanical, not a convention: the declaration-seam
// census in `architecture/layer-boundaries-seam.ts` fails a module that imports
// the declaration contract AND a declaration-storage module in the same file.
//
// ## Why an accessor at all
//
// DR-1's relocation claim is that #1258 can move the declaration SITE into the
// Workflow Builder IR without re-binding any representation. The proof it
// carries is a compile-time substitution (task 007): swap what implements
// {@link DeclarationSource} and require `tsc` to pass with no consumer edit.
// That proof only works if consumers name the seam and never the store — which
// is why {@link openDeclarationSeam} takes the store by INTERFACE. There is no
// module-level singleton here and no import of any registry: a declaration
// arrives through the port or it does not arrive.
//
// ## Zero storage imports, deliberately
//
// This module imports exactly one thing — the envelope it hands out. If the
// accessor imported `registry.ts` or `event-store/schemas.ts`, the seam would
// be a passthrough for the coupling it exists to close, and #1258 would have to
// edit the accessor to relocate. Enforced, not asserted: the live census in
// `architecture/layer-boundaries-seam.ts` reports this module's storage imports
// and `layer-boundaries-seam.test.ts` requires the count to be zero.
//
// ─────────────────────────────────────────────────────────────────────────────
// ## DECISION (DR-1 rev 4, open refinement) — `subject` stays a DEFAULTED TYPE
// ## PARAMETER. The kind-indexed subject map is REJECTED.
//
// Rev 4 ratified `subject` and left one refinement open, naming task 006 — the
// first real consumer — the decider between the shipped
// `Declaration<K, S = unknown>` and a kind-indexed map
// (`subject: DeclarationSubjects[K]`). Decision: keep the defaulted parameter.
// Three measured findings, in descending weight:
//
//   1. **The map would force the contract foundation to import declaration
//      STORAGE.** A `DeclarationSubjects` map must NAME all three subject types
//      in `contract/declaration.ts`. Two of the three live in the stores this
//      seam exists to hide: the action and CLI-verb subjects are `CompositeTool`
//      / `CliActionHints` in `registry.ts`, and the event subject becomes
//      `EventRegistration` in `event-store/`. So `contract/declaration.ts` —
//      today a zero-import module — would acquire a type import from
//      `registry.ts`. That is precisely the edge the census below rejects, and
//      it would be introduced by the declaration foundation itself. The
//      refinement is not merely more expensive; it contradicts DR-1.
//
//   2. **The map buys nothing at the accessor.** Measured directly, both forms
//      behave identically where it matters: TypeScript will not narrow a
//      heterogeneous `AnyDeclaration` to `Declaration<K>` for a type PARAMETER
//      `K` under either shape (`'"action"' is assignable to the constraint of
//      type 'K', but 'K' could be instantiated with a different subtype`). The
//      fix is the kind-partitioned index below, which is the same code for both
//      forms. The refinement's promised precision does not reach the accessor.
//
//   3. **The map costs the no-reshape guarantee.** With a defaulted parameter,
//      `Declaration<'event', EventRegistration>` is a SUBTYPE of
//      `Declaration<'event'>` (`_DeclarationSubjectWidensToUnknown`), so task
//      008 narrows locally and edits no shared type. A kind-indexed map fixes
//      the subject per kind, deleting that proof and forcing an edit to a Wave
//      1a foundation module at each of task 009, DR-10 and DR-19.
//
// **What the map would concretely have been better at, and how that is
// recovered.** Exactness at the READ site: `seam.get('event', id)?.subject`
// would be typed `EventRegistration` instead of `unknown`, so a consumer would
// need no runtime guard. That is a real loss and it is paid for by
// {@link withSubject}, which narrows an individual declaration through a
// caller-supplied type guard — the same exactness, obtained per consumer at the
// point of use, with the storage-typing dependency pushed to the consumer that
// already depends on it instead of into the shared foundation. Guarding is also
// the correct posture once #1258 relocates declarations into the IR: after a
// deserialization round-trip the subject genuinely IS untrusted, and a map
// would have promised a type nothing had checked.
// ─────────────────────────────────────────────────────────────────────────────

import {
  declarationKey,
  type AnyDeclaration,
  type Declaration,
  type DeclarationId,
  type DeclarationKind,
} from './declaration.js';

// ─── The port ───────────────────────────────────────────────────────────────

/**
 * Where declarations come from — the ONE substitution point DR-1's relocation
 * proof turns. Today an adapter over registry storage; after #1258 a read of
 * the Workflow Builder IR. Consumers name {@link DeclarationSeam}, never this,
 * so swapping the implementation is a compile-time substitution that touches no
 * consumer.
 *
 * A method rather than a bare array so a source may be lazy — the relocated IR
 * store need not materialize every declaration to be plugged in.
 */
export interface DeclarationSource {
  /** Every declaration this source holds, in any order. */
  read(): Iterable<AnyDeclaration>;
}

// ─── The accessor ───────────────────────────────────────────────────────────

/**
 * Declarations partitioned by kind. A MAPPED type, not a `Map`: indexing it by
 * a type parameter `K` yields `readonly Declaration<K>[]` directly, which is
 * what lets {@link DeclarationSeam}'s generic methods return a kind-precise
 * type with no type assertion anywhere in this module.
 */
export type DeclarationsByKind = {
  readonly [K in DeclarationKind]: readonly Declaration<K>[];
};

/**
 * The read surface for declarations. Read-only by construction: there is no
 * `set`, no `register`, and no handle on the underlying source, so a consumer
 * cannot write through the seam into whatever currently stores declarations.
 */
export interface DeclarationSeam {
  /**
   * Every declaration of one kind, ordered by {@link Declaration.id}.
   * Duplicates are PRESERVED — two declarations sharing a `(kind, id)` is the
   * G1/G5 two-authorities finding, and hiding it here would put it beyond the
   * reach of the authority census that is supposed to report it.
   */
  list<K extends DeclarationKind>(kind: K): readonly Declaration<K>[];

  /**
   * One declaration by its `(kind, id)` address, or `undefined`. First match in
   * {@link list} order when a `(kind, id)` is claimed twice — deterministic, and
   * deliberately not an error: ambiguity is reported by the census that ranges
   * over {@link list}, not by every read.
   */
  get<K extends DeclarationKind>(kind: K, id: DeclarationId): Declaration<K> | undefined;

  /** Whether any declaration occupies this `(kind, id)` address. */
  has(kind: DeclarationKind, id: DeclarationId): boolean;

  /**
   * Every declaration's composite `kind:id` key, sorted. The seam's addressable
   * surface in DATA form — what a census enumerates instead of walking storage.
   */
  keys(): readonly string[];

  /** Total declarations held, duplicates included. */
  readonly size: number;
}

/**
 * Partition a flat declaration stream by kind.
 *
 * The `switch` uses LITERAL cases rather than a comparison against a type
 * parameter, which is what makes the narrowing sound: `d` genuinely narrows to
 * `Declaration<'event'>` inside `case 'event'`. Attempting the same filter
 * generically (`all.filter(d => d.kind === kind)`) does not typecheck under
 * either subject shape, and the usual repair is a type assertion — avoided here.
 *
 * A kind absent from the switch would leave its bucket permanently empty rather
 * than fail, so the co-located test pins the bucket set against the exported
 * `DECLARATION_KINDS` tuple: adding a fourth kind reddens that test.
 */
function partitionByKind(source: DeclarationSource): DeclarationsByKind {
  const action: Declaration<'action'>[] = [];
  const cliVerb: Declaration<'cli-verb'>[] = [];
  const event: Declaration<'event'>[] = [];

  for (const declaration of source.read()) {
    switch (declaration.kind) {
      case 'action':
        action.push(declaration);
        break;
      case 'cli-verb':
        cliVerb.push(declaration);
        break;
      case 'event':
        event.push(declaration);
        break;
    }
  }

  // Sorted by id so two opens of the same source are byte-identical, matching
  // the deterministic-normalization rule `makeDeclaration` applies to
  // `boundTo`. `Array.prototype.sort` is stable, so declarations sharing an id
  // keep their source order and a duplicate pair stays reportable in sequence.
  const byId = <K extends DeclarationKind>(
    declarations: Declaration<K>[],
  ): readonly Declaration<K>[] =>
    Object.freeze([...declarations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  return Object.freeze({
    action: byId(action),
    'cli-verb': byId(cliVerb),
    event: byId(event),
  });
}

/**
 * Open a read-only seam over a declaration source.
 *
 * The source is drained ONCE and snapshotted, so a seam handed to a consumer
 * cannot change underneath it — a consumer that read a declaration and a
 * consumer that listed them see the same world. Re-open to observe new
 * declarations.
 *
 * @param source - the store to read through. The only substitution point.
 */
export function openDeclarationSeam(source: DeclarationSource): DeclarationSeam {
  const byKind = partitionByKind(source);
  const size = byKind.action.length + byKind['cli-verb'].length + byKind.event.length;

  const keys = Object.freeze(
    [...byKind.action, ...byKind['cli-verb'], ...byKind.event].map(declarationKey).sort(),
  );

  return Object.freeze({
    list<K extends DeclarationKind>(kind: K): readonly Declaration<K>[] {
      return byKind[kind];
    },
    get<K extends DeclarationKind>(kind: K, id: DeclarationId): Declaration<K> | undefined {
      return byKind[kind].find((declaration) => declaration.id === id);
    },
    has(kind: DeclarationKind, id: DeclarationId): boolean {
      return byKind[kind].some((declaration) => declaration.id === id);
    },
    keys(): readonly string[] {
      return keys;
    },
    size,
  });
}

// ─── Subject narrowing (the recovered half of the rejected refinement) ──────

/**
 * Narrow a declaration's subject through a caller-supplied type guard.
 *
 * This is the exactness a kind-indexed subject map would have given at the read
 * site, obtained per consumer instead of by typing the shared foundation
 * against registry storage (see the decision block at the top of this file).
 * The consumer that knows what an event subject looks like supplies the guard;
 * the envelope stays storage-agnostic.
 *
 * Returns `undefined` when the guard rejects, so a subject that does not match
 * can never be mistaken for one that does — the fail-closed posture
 * `makeDeclaration` takes for the identity fields, applied to the payload.
 *
 * @param declaration - a declaration obtained from a {@link DeclarationSeam}.
 * @param isSubject - the consumer's guard over the subject payload.
 */
export function withSubject<K extends DeclarationKind, S>(
  declaration: Declaration<K>,
  isSubject: (value: unknown) => value is S,
): Declaration<K, S> | undefined {
  const subject = declaration.subject;
  if (!isSubject(subject)) return undefined;
  return Object.freeze({
    kind: declaration.kind,
    id: declaration.id,
    authority: declaration.authority,
    boundTo: declaration.boundTo,
    subject,
  });
}
