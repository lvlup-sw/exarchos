// ─── The IR-shaped declaration envelope (DR-1) ───────────────────────────────
//
// One record type for EVERY declaration this program introduces — event tier,
// action contract, CLI verb. Not three parallel shapes: three *instances* of
// `Declaration<K>`, discriminated by `kind`.
//
// ## Why an envelope, and why now
//
// DR-1: "Every declaration this program introduces is defined to be an
// IR-shaped record carried through the existing seam, so #1258 relocates the
// declaration SITE rather than re-binding representations."
//
// The registry is the IR's **current storage, not a competing authority**. That
// distinction is the whole design constraint: when #1258 lands the Workflow
// Builder IR, the declarations must *move house* without changing shape, and
// without any consumer noticing. A record that is addressable by `(kind, id)`,
// references everything else by id, carries no object graph, and is immutable
// can be relocated. A record that closes over registry internals cannot.
//
// ## IR-shaped means, concretely
//
//   1. **Data, not behaviour.** No closures, no live schema objects in the
//      identity fields — a declaration is serializable and comparable.
//   2. **Cross-references are ids, never pointers.** `authority` and `boundTo[]`
//      name other nodes; they do not embed them. This mirrors the repo's shipped
//      IR precedent (`contract/ir/admission-ir.ts` + `references.ts`), where
//      structural validity and REFERENTIAL soundness are deliberately separate
//      layers: ids are plain strings here and resolved by a reference pass, not
//      made unforgeable by nominal branding.
//   3. **Deterministic normalization.** `boundTo` is sorted at construction, so
//      two builds of the same inputs are byte-identical — the same rule
//      `contract/ir/builder.ts` applies when lowering to the shared IR.
//   4. **Immutable.** Frozen record + frozen array, so the seam (task 006) can
//      hand a declaration out without defensive copying.
//
// ## Zero imports, deliberately
//
// This module imports NOTHING. A declaration foundation that reached into
// registry storage would itself be the layering violation task 006's
// `layer-boundaries-seam` rule exists to reject, and would pin the envelope to
// the very storage #1258 needs to relocate. Registrations are *lifted* into
// declarations by the caller; the envelope never goes looking for them.
//
// ## Additivity — the hard constraint
//
// Nothing here modifies, wraps, or is intersected into an existing registration
// type. `EVENT_EMISSION_REGISTRY`, `TOOL_REGISTRY` and the CLI hints compile
// untouched, because lifting is a projection *out of* those values into a new
// record. If landing this type had forced edits at existing registration sites,
// the design would be wrong.
//
// ## Compile-time proofs live at the bottom of THIS file
//
// `tsconfig.json` excludes `**/*.test.ts`, so a type-level assertion in a test
// is never checked by `tsc` — it would be decorative. The proofs are therefore
// exported type aliases in this source file, following the `_Pola*` idiom in
// `capabilities/resolver.ts`.
// ────────────────────────────────────────────────────────────────────────────

// ─── Kinds ──────────────────────────────────────────────────────────────────

/**
 * The declaration kinds DR-1 unifies. Ordered alphabetically so the tuple is a
 * stable, diff-friendly enumeration; iteration order is not semantic.
 *
 * Adding a kind here is the ONLY way to introduce one — a new declaration
 * family cannot be smuggled in via a fourth parallel record type without
 * failing the shape proofs below.
 *
 * Annotated with an explicit readonly tuple type rather than a const
 * assertion: both produce the same literal element types, and the annotation
 * form keeps this module free of type assertions entirely (the repo counts
 * them, and a declaration foundation should not spend from that budget).
 */
export const DECLARATION_KINDS: readonly ['action', 'cli-verb', 'event'] = [
  'action',
  'cli-verb',
  'event',
];

/** `'action' | 'cli-verb' | 'event'`. */
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

// ─── Reference vocabulary ───────────────────────────────────────────────────
//
// Structural aliases, not nominal brands. They exist to give tasks 006/007/024
// a shared vocabulary to import and to make signatures self-describing. Making
// them unforgeable would require an assertion at every construction site and
// would force a conversion step into every lift — which is exactly the kind of
// friction that breaks additivity. Reference INTEGRITY is a runtime concern,
// resolved the way `contract/ir/references.ts` already resolves it.

/**
 * A declaration's identity WITHIN its kind. Unique per `(kind, id)` pair, never
 * globally — an event named `worktree.acquired` and an action id
 * `exarchos_orchestrate.acquire_worktree` occupy different id spaces on purpose.
 * Use {@link declarationKey} for the globally-unique composite key.
 */
export type DeclarationId = string;

/**
 * The single source that OWNS a declaration — the "Authoritative" column of the
 * spec's authority-topology table (`registry`, `outputSchema`, `handshake`, …).
 *
 * Singular by construction: {@link Declaration.authority} is one field, not an
 * array, so "this boundary has two authorities" — the G1/G5 defect class — is
 * not expressible in a single declaration. It can only arise as *two
 * declarations claiming the same subject*, which is a census-level finding
 * (task 024/025) rather than a malformed record.
 */
export type AuthorityId = string;

/**
 * A representation mechanically bound to a declaration's authority — a derived
 * consumer (the CLI tree, the MCP tool list, the docs generator, …).
 *
 * Membership in {@link Declaration.boundTo} MEANS bound. A representation that
 * exists but is not mechanically bound is absent from every `boundTo[]`, and is
 * detected by comparing the representation universe against the union of all
 * `boundTo[]` — the census computation, not a per-record flag.
 */
export type RepresentationId = string;

// ─── The envelope ───────────────────────────────────────────────────────────

/**
 * The one declaration record. Event, action and CLI-verb declarations are
 * instances of this type at different `K`; there is no second shape.
 *
 * @typeParam K - the declaration kind, and the discriminant.
 * @typeParam S - the declared SUBJECT: the registration data this envelope
 *   carries. Defaults to `unknown`, which is the widened form the seam hands
 *   out and the form every consumer can hold.
 *
 * ## On `subject` (the fifth field)
 *
 * DR-1's acceptance criteria enumerate four fields — `kind`, `id`, `authority`,
 * `boundTo[]`. Those four are the *identity and topology* of a declaration. An
 * envelope with only those is a label: it can say that an event exists and who
 * owns it, but not what was declared, so tasks 007/008 would have to reach past
 * the seam into storage for the payload — re-opening precisely the coupling
 * DR-1 closes.
 *
 * `subject` is therefore a generic slot with an `unknown` default rather than a
 * concrete per-kind payload union. That ordering matters: a per-kind union
 * would have to name `EventRegistration` (task 009, Wave 1b) and the tightened
 * action contract (DR-10, Wave 2) before either exists, and every later wave
 * would RESHAPE this type when it landed. With a defaulted parameter, task 008
 * writes `Declaration<'event', EventRegistration>` and reshapes nothing — the
 * widened `Declaration<'event'>` remains its supertype (see
 * `_DeclarationSubjectWidensToUnknown` below), so a seam accessor typed against
 * the widened form keeps compiling.
 */
export interface Declaration<K extends DeclarationKind = DeclarationKind, S = unknown> {
  /** The declaration family, and the discriminant for narrowing. */
  readonly kind: K;
  /** Identity within {@link kind}. Non-empty; unique per `(kind, id)`. */
  readonly id: DeclarationId;
  /** The one source that owns this declaration. Required — see the proofs. */
  readonly authority: AuthorityId;
  /** Representations mechanically bound to {@link authority}. Sorted, deduped. */
  readonly boundTo: readonly RepresentationId[];
  /** The registration data being declared. */
  readonly subject: S;
}

/**
 * Any declaration, narrowable on `kind`. Written using a distributed mapped
 * type rather than `Declaration<DeclarationKind>` so `d.kind === 'event'`
 * narrows `d` to `Declaration<'event'>` at a consumer.
 */
export type AnyDeclaration = { [K in DeclarationKind]: Declaration<K> }[DeclarationKind];

/**
 * The envelope's field names in DATA form, so "the three kinds share one shape"
 * is a checkable rule rather than prose inside a test body (PDD §3a). Sorted,
 * so a key-set comparison needs no re-sorting at the assertion site.
 */
export const DECLARATION_FIELDS: readonly [
  'authority',
  'boundTo',
  'id',
  'kind',
  'subject',
] = ['authority', 'boundTo', 'id', 'kind', 'subject'];

/** A field name of {@link Declaration}. */
export type DeclarationField = (typeof DECLARATION_FIELDS)[number];

// ─── Construction ───────────────────────────────────────────────────────────

/** The field a {@link DeclarationError} is about. */
export type DeclarationErrorField = 'kind' | 'id' | 'authority' | 'boundTo';

/**
 * A declaration could not be constructed. Fail-closed: an ill-formed
 * declaration is never silently normalized into a well-formed one, because the
 * seam would then hand out a record whose authority nobody actually asserted.
 */
export class DeclarationError extends Error {
  readonly field: DeclarationErrorField;

  constructor(field: DeclarationErrorField, message: string) {
    super(message);
    this.name = 'DeclarationError';
    this.field = field;
  }
}

/**
 * Authoring input for {@link makeDeclaration}. `boundTo` is the only optional
 * field — a declaration with no bound representations is legitimate (and is
 * exactly the unbound-representation finding the census reports), whereas
 * omitting `authority` is a COMPILE error by design.
 */
export interface DeclarationInput<K extends DeclarationKind, S> {
  readonly kind: K;
  readonly id: DeclarationId;
  readonly authority: AuthorityId;
  readonly boundTo?: readonly RepresentationId[] | undefined;
  readonly subject: S;
}

function requireNonEmpty(
  value: string,
  field: DeclarationErrorField,
  what: string,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DeclarationError(field, `declaration ${what} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Normalize bound representations: reject blanks, dedupe, and sort. Sorting is
 * what makes two constructions of the same declaration byte-identical, matching
 * `contract/ir/builder.ts`'s lowering rule.
 */
function normalizeBoundTo(
  boundTo: readonly RepresentationId[] | undefined,
): readonly RepresentationId[] {
  if (boundTo === undefined) return Object.freeze([]);
  const seen = new Set<RepresentationId>();
  for (const representation of boundTo) {
    seen.add(requireNonEmpty(representation, 'boundTo', 'bound representation'));
  }
  return Object.freeze([...seen].sort());
}

/**
 * Membership test written with `.some` rather than `.includes` deliberately:
 * `DECLARATION_KINDS.includes(value)` rejects an `unknown`/`string` argument
 * against a literal tuple, and the usual workaround is a widening type
 * assertion. Comparing each element instead needs no assertion at all.
 */
function isDeclarationKind(value: unknown): value is DeclarationKind {
  return typeof value === 'string' && DECLARATION_KINDS.some((kind) => kind === value);
}

/**
 * Build a validated, normalized, frozen declaration.
 *
 * The runtime half of the missing-authority guarantee: the type makes a
 * declaration without an `authority` unrepresentable in typed code, and this
 * rejects a blank one arriving from untyped input (relocated storage, a JSON
 * round-trip through the seam). Both halves must hold — a compile-time-only
 * guarantee evaporates the moment a declaration crosses a `unknown` boundary,
 * which is exactly what task 007's relocation makes it do.
 */
export function makeDeclaration<K extends DeclarationKind, S>(
  input: DeclarationInput<K, S>,
): Declaration<K, S> {
  if (!isDeclarationKind(input.kind)) {
    throw new DeclarationError(
      'kind',
      `unknown declaration kind ${JSON.stringify(input.kind)}; expected one of ${DECLARATION_KINDS.join(', ')}`,
    );
  }
  return Object.freeze({
    kind: input.kind,
    id: requireNonEmpty(input.id, 'id', 'id'),
    authority: requireNonEmpty(input.authority, 'authority', 'authority'),
    boundTo: normalizeBoundTo(input.boundTo),
    subject: input.subject,
  });
}

/** Authoring input for a kind-specific helper — {@link DeclarationInput} less `kind`. */
export type KindedDeclarationInput<K extends DeclarationKind, S> = Omit<
  DeclarationInput<K, S>,
  'kind'
>;

/**
 * Lift an event-type registration into the envelope.
 *
 * These three helpers exist so the *lift* is named per kind while the *record*
 * stays single. They are the natural place a fourth field would creep into one
 * kind and not the others — which is why the shape proof compares their outputs
 * rather than comparing the type to itself.
 */
export function declareEvent<S>(
  input: KindedDeclarationInput<'event', S>,
): Declaration<'event', S> {
  return makeDeclaration({ ...input, kind: 'event' });
}

/** Lift an action-contract registration into the envelope. */
export function declareAction<S>(
  input: KindedDeclarationInput<'action', S>,
): Declaration<'action', S> {
  return makeDeclaration({ ...input, kind: 'action' });
}

/** Lift a CLI-verb registration into the envelope. */
export function declareCliVerb<S>(
  input: KindedDeclarationInput<'cli-verb', S>,
): Declaration<'cli-verb', S> {
  return makeDeclaration({ ...input, kind: 'cli-verb' });
}

// ─── Addressing and validation ──────────────────────────────────────────────

/**
 * The globally-unique composite key for a declaration. Ids are unique only
 * within a kind, so any store keyed by a single string must key by this.
 * Storage-agnostic on purpose: it is what lets task 007 swap the backing store
 * for a stand-in IR without consumers learning a new addressing scheme.
 */
export function declarationKey(declaration: AnyDeclaration): string {
  return `${declaration.kind}:${declaration.id}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Structural type guard for a value crossing a boundary — relocated storage, a
 * deserialized IR document, a test fixture. Checks the four identity/topology
 * fields and the presence of `subject`; the subject's own shape is the
 * declaring kind's business, not the envelope's.
 */
export function isDeclaration(value: unknown): value is AnyDeclaration {
  if (value === null || typeof value !== 'object') return false;
  if (!('kind' in value) || !isDeclarationKind(value.kind)) return false;
  if (!('id' in value) || !isNonEmptyString(value.id)) return false;
  if (!('authority' in value) || !isNonEmptyString(value.authority)) return false;
  if (!('boundTo' in value) || !Array.isArray(value.boundTo)) return false;
  // `Array.isArray` narrows an `unknown` to `any[]`; re-binding at
  // `readonly unknown[]` contains that `any` instead of letting it propagate
  // into the `.every` callback position.
  const boundTo: readonly unknown[] = value.boundTo;
  if (!boundTo.every(isNonEmptyString)) return false;
  return 'subject' in value;
}

// ─── Compile-time proofs (the real gate is `tsc --noEmit`) ──────────────────
//
// Exported type aliases in a NON-TEST source file, per the `_Pola*` idiom in
// `capabilities/resolver.ts`: `tsconfig.json` excludes `**/*.test.ts`, so an
// assertion in the test file would never be checked by the build. `Expect<T>`
// is a compile error unless `T` resolves to `true`.
//
// `[A] extends [B]` is tuple-wrapped throughout to suppress distribution over
// union members — without it, a union `A` would be checked member-by-member and
// a proof could report `true` for the wrong reason.

type Expect<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type NotAssignable<A, B> = [A] extends [B] ? false : true;

/** A well-formed event declaration. The positive control for the proofs below. */
type WellFormedEvent = {
  kind: 'event';
  id: string;
  authority: string;
  boundTo: readonly string[];
  subject: unknown;
};

/**
 * **`Declaration_MissingAuthority_FailsCompile`** — the load-bearing proof.
 *
 * A record carrying every other field but not `authority` is NOT assignable to
 * `Declaration`. Making `authority` optional flips this to `false` and fails
 * `tsc`, so "every declaration names an authority" is enforced by the compiler
 * rather than asserted by a reviewer.
 */
export type _DeclarationMissingAuthority_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'authority'>, Declaration<'event'>>
>;

/** Control for the proof above: WITH `authority`, the same record IS assignable. */
export type _DeclarationWithAuthority_Compiles = Expect<
  Assignable<WellFormedEvent, Declaration<'event'>>
>;

/** `kind` is required — a declaration is never anonymous about its family. */
export type _DeclarationMissingKind_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'kind'>, Declaration<'event'>>
>;

/** `id` is required — a declaration is always addressable. */
export type _DeclarationMissingId_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'id'>, Declaration<'event'>>
>;

/** `boundTo` is required — "binds nothing" is stated as `[]`, never omitted. */
export type _DeclarationMissingBoundTo_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'boundTo'>, Declaration<'event'>>
>;

/**
 * Authority is SINGULAR. A record naming two authorities does not typecheck, so
 * the G1/G5 "2 authorities on one boundary" defect cannot be expressed within
 * a single declaration.
 */
export type _DeclarationPluralAuthority_FailsCompile = Expect<
  NotAssignable<
    Omit<WellFormedEvent, 'authority'> & { authority: readonly string[] },
    Declaration<'event'>
  >
>;

/**
 * **`Declaration_EventActionCliVerb_ShareOneShape`** (compile-time half).
 *
 * The three kinds' field sets are mutually assignable — i.e. EQUAL. Splitting
 * any kind into its own interface with an extra field breaks this.
 */
type FieldsOf<K extends DeclarationKind> = keyof Declaration<K>;
export type _DeclarationEventActionFieldsEqual = Expect<
  Assignable<FieldsOf<'event'>, FieldsOf<'action'>>
>;
export type _DeclarationActionEventFieldsEqual = Expect<
  Assignable<FieldsOf<'action'>, FieldsOf<'event'>>
>;
export type _DeclarationActionCliVerbFieldsEqual = Expect<
  Assignable<FieldsOf<'action'>, FieldsOf<'cli-verb'>>
>;
export type _DeclarationCliVerbActionFieldsEqual = Expect<
  Assignable<FieldsOf<'cli-verb'>, FieldsOf<'action'>>
>;

/** The declared field list is exactly the envelope's key set — both directions. */
export type _DeclarationFieldsMatchType = Expect<
  Assignable<DeclarationField, FieldsOf<DeclarationKind>>
>;
export type _DeclarationTypeMatchesFields = Expect<
  Assignable<FieldsOf<DeclarationKind>, DeclarationField>
>;

/** Every kind is an INSTANCE of the one shape — nothing sits outside the union. */
export type _DeclarationEventIsInstance = Expect<Assignable<Declaration<'event'>, AnyDeclaration>>;
export type _DeclarationActionIsInstance = Expect<Assignable<Declaration<'action'>, AnyDeclaration>>;
export type _DeclarationCliVerbIsInstance = Expect<
  Assignable<Declaration<'cli-verb'>, AnyDeclaration>
>;

/**
 * Kinds do NOT collapse into each other: an action declaration is not usable
 * where an event declaration is required. This is what makes `Declaration<K>` a
 * family of distinct types rather than one loose record with a label.
 */
export type _DeclarationActionIsNotEvent = Expect<
  NotAssignable<Declaration<'action'>, Declaration<'event'>>
>;

/**
 * **The no-reshape guarantee for task 006.** A declaration carrying a concrete
 * subject widens to the `unknown`-subject form, so a seam accessor whose
 * signature is written against `Declaration<K>` keeps compiling when task 008
 * lands `Declaration<'event', EventRegistration>`. If `subject` were invariant
 * (mutable rather than `readonly`), this would fail and every later wave would
 * force a reshape of this type.
 */
export type _DeclarationSubjectWidensToUnknown = Expect<
  Assignable<Declaration<'event', { source: 'auto' }>, Declaration<'event'>>
>;

/**
 * The widened form does NOT narrow back — a consumer holding the seam's
 * `Declaration<'event'>` cannot silently treat the subject like a concrete
 * registration without a guard.
 */
export type _DeclarationUnknownDoesNotNarrow = Expect<
  NotAssignable<Declaration<'event'>, Declaration<'event', { source: 'auto' }>>
>;
