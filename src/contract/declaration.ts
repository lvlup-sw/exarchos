/**
 * The IR-shaped declaration envelope. Event, action, and CLI-verb declarations are three instances
 * of `Declaration<K>`, discriminated by `kind`, not three parallel shapes.
 *
 * The registry is the current storage of the IR, not a second authority. A declaration must move to
 * new storage with no change of shape. Thus a declaration is data with no closures. It refers to
 * other nodes by id only, its `boundTo` is sorted, and it is frozen.
 *
 * This module has no imports, so it does not depend on registry storage. A caller lifts each
 * registration into a declaration, and the existing registration types do not change.
 *
 * The root `tsconfig.json` excludes test files, and no typecheck covers `tests/unit`. Thus the
 * compile-time proofs are exported type aliases at the end of this file.
 */

/**
 * The declaration kinds, in alphabetical order. The iteration order has no meaning. A new
 * declaration family must be added here, because a parallel record type fails the shape proofs.
 * The explicit tuple type keeps this module free of type assertions.
 */
export const DECLARATION_KINDS: readonly ['action', 'cli-verb', 'event'] = [
  'action',
  'cli-verb',
  'event',
];

/** `'action' | 'cli-verb' | 'event'`. */
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

/**
 * The identity of a declaration within its kind. It is unique per `(kind, id)` pair, not globally,
 * so events and actions use different id spaces. {@link declarationKey} gives the global key. The
 * id aliases are structural, not nominal brands. Reference integrity is a run-time check, as in
 * `contract/ir/references.ts`.
 */
export type DeclarationId = string;

/**
 * The one source that owns a declaration, such as `registry`, `outputSchema`, or `handshake`.
 * {@link Declaration.authority} is one field, so one declaration cannot name two authorities. Two
 * declarations that claim the same subject are a census finding, not a malformed record.
 */
export type AuthorityId = string;

/**
 * A derived consumer that is mechanically bound to the authority of a declaration, such as the CLI
 * tree or the MCP tool list. Membership in {@link Declaration.boundTo} means bound. The census finds
 * an unbound representation by a comparison with the union of all `boundTo[]`.
 */
export type RepresentationId = string;

/**
 * The one declaration record. Event, action, and CLI-verb declarations are instances of this type
 * at different `K`.
 *
 * @typeParam K - the declaration kind, and the discriminant.
 * @typeParam S - the declared subject: the registration data in the envelope. The default is
 *   `unknown`, the widened form that the seam hands out.
 *
 * `subject` carries the payload, so a consumer does not read past the seam into storage. It is a
 * defaulted generic, not a per-kind union. A kind can narrow `S` and keep the widened supertype.
 */
export interface Declaration<K extends DeclarationKind = DeclarationKind, S = unknown> {
  /** The declaration family, and the discriminant for narrowing. */
  readonly kind: K;
  /** The identity within {@link kind}. It is non-empty and unique per `(kind, id)`. */
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

/** The sorted envelope field names as data, so a test can check that all kinds share one shape. */
export const DECLARATION_FIELDS: readonly [
  'authority',
  'boundTo',
  'id',
  'kind',
  'subject',
] = ['authority', 'boundTo', 'id', 'kind', 'subject'];

/** A field name of {@link Declaration}. */
export type DeclarationField = (typeof DECLARATION_FIELDS)[number];

/** The field a {@link DeclarationError} is about. */
export type DeclarationErrorField = 'kind' | 'id' | 'authority' | 'boundTo';

/**
 * A declaration that cannot be built. The check fails closed. It does not normalize an ill-formed
 * declaration, because the seam then hands out an authority that nobody asserted.
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
 * The membership test uses `.some`, not `.includes`. `.includes` on a literal tuple rejects an
 * `unknown` argument, and the usual fix is a type assertion.
 */
function isDeclarationKind(value: unknown): value is DeclarationKind {
  return typeof value === 'string' && DECLARATION_KINDS.some((kind) => kind === value);
}

/**
 * Build a validated, normalized, frozen declaration. The type rejects a missing `authority` in
 * typed code. This function rejects a blank one from untyped input, such as relocated storage or a
 * JSON round trip through the seam.
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
 * Lift an event-type registration into the envelope. The three kind helpers name the lift per kind
 * and keep one record type.
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

/**
 * The globally unique key of a declaration. Ids are unique only within a kind, so a store keyed by
 * one string must use this key. The key does not depend on the storage.
 */
export function declarationKey(declaration: AnyDeclaration): string {
  return `${declaration.kind}:${declaration.id}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A structural type guard for a value from a boundary, such as relocated storage or an IR document.
 * It checks the four identity and topology fields and that `subject` is present. The declaring kind
 * owns the subject shape. `boundTo` is rebound as `readonly unknown[]`, so the `any[]` from
 * `Array.isArray` does not reach the `.every` callback.
 */
export function isDeclaration(value: unknown): value is AnyDeclaration {
  if (value === null || typeof value !== 'object') return false;
  if (!('kind' in value) || !isDeclarationKind(value.kind)) return false;
  if (!('id' in value) || !isNonEmptyString(value.id)) return false;
  if (!('authority' in value) || !isNonEmptyString(value.authority)) return false;
  if (!('boundTo' in value) || !Array.isArray(value.boundTo)) return false;
  const boundTo: readonly unknown[] = value.boundTo;
  if (!boundTo.every(isNonEmptyString)) return false;
  return 'subject' in value;
}

/**
 * A compile error unless `T` is `true`. `tsc --noEmit` checks the proofs below. The `[A] extends [B]`
 * tuple form stops distribution over union members, so a union cannot pass for the wrong reason.
 */
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
 * @proof
 */
export type _DeclarationMissingAuthority_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'authority'>, Declaration<'event'>>
>;

/**
 * Control for the proof above: WITH `authority`, the same record IS assignable.
 * @proof
 */
export type _DeclarationWithAuthority_Compiles = Expect<
  Assignable<WellFormedEvent, Declaration<'event'>>
>;

/**
 * `kind` is required — a declaration is never anonymous about its family.
 * @proof
 */
export type _DeclarationMissingKind_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'kind'>, Declaration<'event'>>
>;

/**
 * `id` is required — a declaration is always addressable.
 * @proof
 */
export type _DeclarationMissingId_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'id'>, Declaration<'event'>>
>;

/**
 * `boundTo` is required — "binds nothing" is stated as `[]`, never omitted.
 * @proof
 */
export type _DeclarationMissingBoundTo_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedEvent, 'boundTo'>, Declaration<'event'>>
>;

/**
 * Authority is singular. A record that names two authorities does not typecheck.
 * @proof
 */
export type _DeclarationPluralAuthority_FailsCompile = Expect<
  NotAssignable<
    Omit<WellFormedEvent, 'authority'> & { authority: readonly string[] },
    Declaration<'event'>
  >
>;

/**
 * The field sets of the three kinds are mutually assignable, so they are equal. A kind with its own
 * interface and an extra field breaks this.
 */
type FieldsOf<K extends DeclarationKind> = keyof Declaration<K>;
/** @proof */
export type _DeclarationEventActionFieldsEqual = Expect<
  Assignable<FieldsOf<'event'>, FieldsOf<'action'>>
>;
/** @proof */
export type _DeclarationActionEventFieldsEqual = Expect<
  Assignable<FieldsOf<'action'>, FieldsOf<'event'>>
>;
/** @proof */
export type _DeclarationActionCliVerbFieldsEqual = Expect<
  Assignable<FieldsOf<'action'>, FieldsOf<'cli-verb'>>
>;
/** @proof */
export type _DeclarationCliVerbActionFieldsEqual = Expect<
  Assignable<FieldsOf<'cli-verb'>, FieldsOf<'action'>>
>;

/**
 * The declared field list is exactly the envelope's key set — both directions.
 * @proof
 */
export type _DeclarationFieldsMatchType = Expect<
  Assignable<DeclarationField, FieldsOf<DeclarationKind>>
>;
/** @proof */
export type _DeclarationTypeMatchesFields = Expect<
  Assignable<FieldsOf<DeclarationKind>, DeclarationField>
>;

/**
 * Every kind is an INSTANCE of the one shape — nothing sits outside the union.
 * @proof
 */
export type _DeclarationEventIsInstance = Expect<Assignable<Declaration<'event'>, AnyDeclaration>>;
/** @proof */
export type _DeclarationActionIsInstance = Expect<Assignable<Declaration<'action'>, AnyDeclaration>>;
/** @proof */
export type _DeclarationCliVerbIsInstance = Expect<
  Assignable<Declaration<'cli-verb'>, AnyDeclaration>
>;

/**
 * Kinds do NOT collapse into each other: an action declaration is not usable
 * where an event declaration is required. This is what makes `Declaration<K>` a
 * family of distinct types rather than one loose record with a label.
 * @proof
 */
export type _DeclarationActionIsNotEvent = Expect<
  NotAssignable<Declaration<'action'>, Declaration<'event'>>
>;

/**
 * A declaration with a concrete subject widens to the `unknown`-subject form. A seam accessor typed
 * against `Declaration<K>` thus accepts a narrowed subject.
 * @proof
 */
export type _DeclarationSubjectWidensToUnknown = Expect<
  Assignable<Declaration<'event', { source: 'auto' }>, Declaration<'event'>>
>;

/**
 * The widened form does NOT narrow back — a consumer holding the seam's
 * `Declaration<'event'>` cannot silently treat the subject like a concrete
 * registration without a guard.
 * @proof
 */
export type _DeclarationUnknownDoesNotNarrow = Expect<
  NotAssignable<Declaration<'event'>, Declaration<'event', { source: 'auto' }>>
>;
