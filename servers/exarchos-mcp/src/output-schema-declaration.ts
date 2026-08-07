/**
 * The `outputSchema` declaration surface (DR-4).
 *
 * ── What this module removes ────────────────────────────────────────────────
 * `outputSchema` used to record PRESENCE, not SUBSTANCE. The field was typed
 * `z.ZodType`, so the cheapest thing an author could write —
 * `EnvelopeSchema(z.unknown())` — satisfied it, and 112 of 122 declarations did
 * exactly that (`architecture/output-schema-census.ts` measures it). A schema
 * whose success-branch `data` is `z.unknown()` is TOTAL over every payload
 * shape including the wrong ones, so INV-17's totality precondition is met
 * trivially and INV-2's "schema-checked in addition to byte-checked" reduces to
 * byte-checked plus a tautology.
 *
 * This module makes that declaration UNCONSTRUCTIBLE rather than merely
 * counted. `ToolAction.outputSchema` no longer accepts `z.ZodType`; it accepts
 * {@link DeclaredOutputSchema}, a brand only two constructors in this file can
 * mint:
 *
 *   • {@link withCappedShape} — the sole constructor of a SUBSTANTIVE schema.
 *     It is already the only form the live tree uses for its 10 typed actions,
 *     so nothing had to be invented for the happy path.
 *   • {@link vacuityWaiver} — the explicit allowlist escape, whose id parameter
 *     is the literal union of the seeded ids in
 *     `output-schema-vacuity-allowlist.ts`. A new action's id is not in that
 *     union, so a new vacuous declaration does not compile.
 *
 * ── Why a constructor restriction and not a ratchet ─────────────────────────
 * A one-constructor surface does not need counting. DR-2 made report-coupling
 * have no constructible variant rather than budgeting it, and the same move
 * applies here: a count threshold is satisfied by swapping one vacuous
 * declaration for another, while an allowlist plus a closed constructor set is
 * not. The runtime half of the ratchet (`auditVacuityAllowlist`) lives in
 * `architecture/output-schema-census.ts`, where the census that measures the
 * population already lives.
 *
 * ── Why the brand is a real runtime property ────────────────────────────────
 * A phantom (declaration-only) brand would have to be minted with a type
 * assertion, and this wave's `as` budget is effectively zero. A `unique symbol`
 * property attached with `Object.assign` costs no assertion, keeps object
 * identity (so every existing `z.ZodType` consumer of `action.outputSchema` is
 * untouched), and is observable — which is what lets a test prove the branded
 * set really is exactly `{withCappedShape, vacuityWaiver}` output instead of
 * taking the type system's word for it.
 */
import { z } from 'zod';
import { EnvelopeSchema } from './schemas/envelope.js';
import { extractEnvelopeDataSchema } from './orchestrate/worktree/schemas.js';
import type { VacuityWaiverId } from './output-schema-vacuity-allowlist.js';

/**
 * The nominal marker carried by every schema this module blesses.
 *
 * Exported ONLY because `declaration: true` cannot emit a `.d.ts` for
 * {@link DeclaredOutputSchema} while the symbol is private. Importing it does
 * not hand out a bypass worth having: forging the brand takes a deliberate,
 * reviewable `Object.assign` at the declaration site, and the runtime ratchet
 * (`auditVacuityAllowlist`) still reddens on the resulting unwaived vacuity.
 */
export const OUTPUT_SCHEMA_BRAND: unique symbol = Symbol('exarchos.outputSchema.declared');

const BRAND_VALUE: 'declared' = 'declared';

/**
 * An `outputSchema` that went through one of this module's constructors.
 *
 * Assignable to `z.ZodType` in every direction that matters, so the ~20
 * consumers that read `action.outputSchema` (the MCP D.5 validator, `describe`,
 * the contract compiler, the census) needed no change. What it is NOT is
 * assignable FROM a bare `z.ZodType` — which is the whole mechanism.
 */
export type DeclaredOutputSchema = z.ZodType & {
  readonly [OUTPUT_SCHEMA_BRAND]: typeof BRAND_VALUE;
};

/**
 * Attach the brand. Deliberately NOT exported: an exported "bless any schema"
 * function would be a universal bypass and would make the compile-time tooth
 * decorative.
 */
function declareOutputSchema(schema: z.ZodType): DeclaredOutputSchema {
  return Object.assign(schema, { [OUTPUT_SCHEMA_BRAND]: BRAND_VALUE });
}

/** Runtime counterpart of the brand, so tests can observe the closed set. */
export function isDeclaredOutputSchema(schema: z.ZodType): schema is DeclaredOutputSchema {
  return OUTPUT_SCHEMA_BRAND in schema && schema[OUTPUT_SCHEMA_BRAND] === BRAND_VALUE;
}

// ─── Capped-shape outputSchema union (DR-1/DR-3/DR-8, Task 022) ───────────────
//
// outputSchema honesty (contract-canonical): the registered `outputSchema` IS
// the canonical response contract (system-design "one contract, one core"), so
// a capped/summary response whose shape the schema does not declare violates the
// contract itself — regardless of which facade renders it. The MCP adapter's
// D.5 validator (`adapters/mcp.ts`, `validateAgainstActionSchema`) enforces
// that contract today by replacing a non-conforming envelope with an
// INTERNAL_ERROR. So every action carrying a TYPED `data` outputSchema must have
// its schema made TOTAL over its emittable shapes (baseline + capped) BEFORE the
// dispatch-core economy enforcement (Task 003) can emit a capped response —
// this is also the §05 output-codegen precondition (you cannot generate a
// presentation client from a schema that does not enumerate the response shapes).

/**
 * The generic capped-fallback `data` shape the dispatch-core economy seam
 * (Task 003) emits when an over-budget response has no declared summarizer:
 * a `summary` (human-readable message or a structured roll-up), counts-by-group
 * `counts`, and a `firstPage` preview of the first items.
 *
 * Declared ONCE and unioned into every typed-`data` outputSchema via
 * {@link withCappedShape}. `.passthrough()` tolerates the extra capped-envelope
 * decorators a summarizer may attach (`total`, `truncated`, `page`, …) without
 * re-cutting the fragment — the same "do NOT over-constrain" discipline the
 * per-action data schemas already follow (a stricter schema would make the D.5
 * validator replace a real capped response with an INTERNAL_ERROR).
 */
export const CappedDataSchema = z
  .object({
    summary: z.union([z.string(), z.record(z.string(), z.unknown())]),
    counts: z.record(z.string(), z.number()),
    firstPage: z.array(z.unknown()),
  })
  .passthrough();

/**
 * Union {@link CappedDataSchema} into an existing typed-`data`
 * `EnvelopeSchema(...)` output schema, keeping the result a single
 * `success`-discriminated envelope union whose `data` branch is
 * `z.union([<baseData>, CappedDataSchema])`. Unioning at the `data` level (not
 * the envelope level) preserves the discriminated-union shape that
 * `extractEnvelopeDataSchema` / `envelopeDataSchemaIsTyped` rely on, so the
 * action stays a "typed output" after the widening.
 *
 * THE SOLE CONSTRUCTOR OF A SUBSTANTIVE `outputSchema`. That was already true
 * by measurement before DR-4 — all 10 substantive declarations in the live tree
 * spell `withCappedShape(...)` — and it is now true by construction, because
 * this is the only branding path that does not go through the allowlist.
 *
 * No-op passthrough for a schema whose success-branch `data` cannot be
 * extracted; such a schema is not made substantive by being passed here, and
 * the census will still classify it vacuous (and the allowlist audit will then
 * demand a waiver it does not have).
 */
export function withCappedShape(outputSchema: z.ZodType): DeclaredOutputSchema {
  const baseData = extractEnvelopeDataSchema(outputSchema);
  if (baseData === undefined) return declareOutputSchema(outputSchema);
  return declareOutputSchema(EnvelopeSchema(z.union([baseData, CappedDataSchema])));
}

/**
 * Declare a KNOWN-VACUOUS `outputSchema` against its allowlist entry.
 *
 * The `id` parameter is typed {@link VacuityWaiverId} — the literal union of
 * the seeded ids — so this escape is closed to anything not already on the
 * list. That is the compile-time half of "the allowlist may only shrink": you
 * cannot waive a NEW declaration without editing the generated seed file, and
 * the runtime audit reddens the moment a waived declaration stops being
 * vacuous.
 *
 * `schema` defaults to a fresh `EnvelopeSchema(z.unknown())` — the shape 109 of
 * the 112 seeded declarations wrote literally. The two declarations that reach
 * vacuity through a NAMED BINDING (`exarchos_workflow.update`,
 * `exarchos_workflow.transition`, the latter intersecting a `_meta.deprecation`
 * constraint over a still-`unknown` `data`) pass their binding explicitly, so
 * the waiver records the vacuity without changing the shape those actions have
 * always advertised.
 */
export function vacuityWaiver(
  id: VacuityWaiverId,
  schema: z.ZodType = EnvelopeSchema(z.unknown()),
): DeclaredOutputSchema {
  // `id` is load-bearing at the TYPE level only: it is what ties this call site
  // to an owned, expiring allowlist entry. Nothing is read from it at runtime,
  // and nothing should be — the audit resolves ids from the census, not from
  // whatever a declaration site passed.
  void id;
  return declareOutputSchema(schema);
}

/**
 * The one escape for `ToolAction`s that are NOT part of the built-in registry
 * and therefore have no census id to waive: user-declared custom tools built
 * from `.exarchos.yml` (`config/register.ts`) and the oracle's registration
 * probe (`contract/oracle/fixtures.ts`). Their action names come from config or
 * from a fixture, so no compile-time literal union can cover them.
 *
 * This is bounded, not open: any use of it INSIDE the built-in registry
 * produces a live vacuous declaration with no allowlist entry, which
 * `auditVacuityAllowlist` reports as `UNWAIVED_VACUITY`. The type system stops
 * new vacuity in `registry.ts`; this constant's blast radius is stopped by the
 * runtime ratchet instead.
 */
export function unregisteredActionOutputSchema(): DeclaredOutputSchema {
  return declareOutputSchema(EnvelopeSchema(z.unknown()));
}

// ─── Compile-time guarantees (verified by `npm run typecheck`) ───────────────
//
// These exported type aliases live in a NON-TEST source file on purpose: the
// package tsconfig excludes `*.test.ts`, so a `@ts-expect-error` in a test would
// never be checked by the build. The `_Pola*` aliases in `capabilities/
// resolver.ts` are the precedent. `Expect<T extends true>` is a compile error
// unless T is exactly `true`.
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;

/** The vacuous form is not a declared schema. This is DR-4's whole point. */
export type _OutputSchemaVacuousEnvelopeIsNotDeclared = Expect<
  IsNotAssignable<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, DeclaredOutputSchema>
>;
/** Neither is a TYPED envelope that skipped the constructor. */
export type _OutputSchemaUnbrandedTypedEnvelopeIsNotDeclared = Expect<
  IsNotAssignable<ReturnType<typeof EnvelopeSchema<z.ZodObject>>, DeclaredOutputSchema>
>;
/** Nor any bare `z.ZodType` — the field's old type admitted every schema. */
export type _OutputSchemaBareZodTypeIsNotDeclared = Expect<
  IsNotAssignable<z.ZodType, DeclaredOutputSchema>
>;
/** An id that is not seeded cannot be waived. This is the shrink-only tooth. */
export type _OutputSchemaUnseededIdCannotBeWaived = Expect<
  IsNotAssignable<'exarchos_workflow.a_brand_new_action', VacuityWaiverId>
>;
/**
 * …and the guarantee is not vacuous: both constructors DO produce the brand, so
 * the aliases above are rejecting the unbranded case rather than rejecting
 * everything.
 */
export type _OutputSchemaCappedShapeIsDeclared = Expect<
  ReturnType<typeof withCappedShape> extends DeclaredOutputSchema ? true : false
>;
export type _OutputSchemaWaiverIsDeclared = Expect<
  ReturnType<typeof vacuityWaiver> extends DeclaredOutputSchema ? true : false
>;
/** A declared schema is still a `z.ZodType`, so no consumer had to change. */
export type _OutputSchemaDeclaredIsStillZodType = Expect<
  DeclaredOutputSchema extends z.ZodType ? true : false
>;
