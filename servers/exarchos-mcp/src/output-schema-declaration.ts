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
 * counted. A registered action's `outputSchema` no longer accepts `z.ZodType`;
 * a built-in declaration (`BuiltinToolAction`, the type `TOOL_REGISTRY` carries)
 * accepts {@link DeclaredOutputSchema}, a brand only two constructors in this
 * file can mint:
 *
 *   • {@link withCappedShape} — the sole constructor of a SUBSTANTIVE schema.
 *     It is already the only form the live tree uses for its 10 typed actions,
 *     so nothing had to be invented for the happy path.
 *   • {@link vacuityWaiver} — the explicit allowlist escape, whose id parameter
 *     is the literal union of the seeded ids in
 *     `output-schema-vacuity-allowlist.ts`. A new action's id is not in that
 *     union, so a new vacuous declaration does not compile.
 *
 * ── Two brands, not one (task 060) ──────────────────────────────────────────
 * Task 055 reported a hole against its own claim: `unregisteredActionOutputSchema()`
 * minted the SAME brand as the two registry constructors, so a new REGISTRY
 * action could reach for the out-of-registry escape and compile. The failure was
 * still detected — `auditVacuityAllowlist` reports it as `UNWAIVED_VACUITY` —
 * but at run time, while DR-4 claims the compile-time rung.
 *
 * The brand value is therefore a two-member literal set, not a constant:
 * {@link DeclaredOutputSchema} carries `'declared'` and {@link ExtensionOutputSchema}
 * carries `'extension'`. Neither is assignable to the other. `BuiltinToolAction`
 * (the type `TOOL_REGISTRY` is declared with) takes `DeclaredOutputSchema` only,
 * so the escape does not typecheck inside the registry; `ExtensionToolAction`
 * (the type `config/register.ts` and `contract/oracle/fixtures.ts` build) takes
 * `ExtensionOutputSchema` only, so the extension surface keeps working. The
 * `.exarchos.yml` custom-tool path is NOT closed — it is given its own nominal
 * type, which is what makes the registry path closable without breaking it.
 *
 * ── Why a constructor restriction and not a ratchet ─────────────────────────
 * A one-constructor surface does not need counting. DR-2 made report-coupling
 * have no constructible variant rather than budgeting it, and the same move
 * applies here: a count threshold is satisfied by swapping one vacuous
 * declaration for another, while an allowlist plus a closed constructor set is
 * not. The runtime half of the ratchet (`auditVacuityAllowlist` plus, since task
 * 060, `auditVacuitySeedIntegrity`) lives in
 * `architecture/output-schema-census.ts`, where the census that measures the
 * population already lives. The second of those closes the residual the
 * constructor restriction alone cannot: a swap that edits the ALLOWLIST itself,
 * which every check against today's registry agrees with. See
 * `output-schema-seed-pin.ts` for the prior state that makes it detectable and
 * for why that call went the opposite way from `LEGACY_SHAPE_DEBT`'s precedent.
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

const DECLARED_BRAND: 'declared' = 'declared';
const EXTENSION_BRAND: 'extension' = 'extension';

/**
 * An `outputSchema` that went through one of this module's REGISTRY
 * constructors ({@link withCappedShape} / {@link vacuityWaiver}).
 *
 * Assignable to `z.ZodType` in every direction that matters, so the ~20
 * consumers that read `action.outputSchema` (the MCP D.5 validator, `describe`,
 * the contract compiler, the census) needed no change. What it is NOT is
 * assignable FROM a bare `z.ZodType` — nor from {@link ExtensionOutputSchema},
 * which is the task-060 half of the mechanism.
 */
export type DeclaredOutputSchema = z.ZodType & {
  readonly [OUTPUT_SCHEMA_BRAND]: typeof DECLARED_BRAND;
};

/**
 * An `outputSchema` for an action declared OUTSIDE the built-in registry — a
 * `.exarchos.yml` custom tool or the oracle's registration probe. Minted only by
 * {@link unregisteredActionOutputSchema}.
 *
 * A distinct brand VALUE, so this type is not assignable to
 * {@link DeclaredOutputSchema} and therefore cannot satisfy `BuiltinToolAction.
 * outputSchema`. That is what makes the escape unreachable from the registry
 * construction path while leaving the extension path fully supported.
 */
export type ExtensionOutputSchema = z.ZodType & {
  readonly [OUTPUT_SCHEMA_BRAND]: typeof EXTENSION_BRAND;
};

/**
 * Either brand. This is what `ToolAction` — the type every CONSUMER of a
 * registered action reads — declares, so dispatch, the MCP adapter, the CLI
 * adapter and `describe` handle built-in and extension actions uniformly. The
 * narrowing that closes the hole is applied at the DECLARATION types
 * (`BuiltinToolAction` / `ExtensionToolAction`), not here.
 */
export type RegisteredOutputSchema = DeclaredOutputSchema | ExtensionOutputSchema;

/**
 * Attach the registry brand. Deliberately NOT exported: an exported "bless any
 * schema" function would be a universal bypass and would make the compile-time
 * tooth decorative.
 */
function declareOutputSchema(schema: z.ZodType): DeclaredOutputSchema {
  return Object.assign(schema, { [OUTPUT_SCHEMA_BRAND]: DECLARED_BRAND });
}

/** Attach the extension brand. Not exported, for the same reason. */
function declareExtensionOutputSchema(schema: z.ZodType): ExtensionOutputSchema {
  return Object.assign(schema, { [OUTPUT_SCHEMA_BRAND]: EXTENSION_BRAND });
}

/** Runtime counterpart of the registry brand, so tests can observe the closed set. */
export function isDeclaredOutputSchema(schema: z.ZodType): schema is DeclaredOutputSchema {
  return OUTPUT_SCHEMA_BRAND in schema && schema[OUTPUT_SCHEMA_BRAND] === DECLARED_BRAND;
}

/**
 * Runtime counterpart of the EXTENSION brand.
 *
 * The two predicates are mutually exclusive by construction, which is what lets
 * a test observe the nominal split instead of taking the type printer's word for
 * it: every live `TOOL_REGISTRY` declaration answers `true` to
 * {@link isDeclaredOutputSchema} and `false` here.
 */
export function isExtensionOutputSchema(schema: z.ZodType): schema is ExtensionOutputSchema {
  return OUTPUT_SCHEMA_BRAND in schema && schema[OUTPUT_SCHEMA_BRAND] === EXTENSION_BRAND;
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
 * The one escape for actions that are NOT part of the built-in registry and
 * therefore have no census id to waive: user-declared custom tools built from
 * `.exarchos.yml` (`config/register.ts`) and the oracle's registration probe
 * (`contract/oracle/fixtures.ts`). Their action names come from config or from a
 * fixture, so no compile-time literal union can cover them.
 *
 * TASK 060 — this is now BOUNDED AT COMPILE TIME, not just by the runtime
 * ratchet. It returns {@link ExtensionOutputSchema}, whose brand value differs
 * from {@link DeclaredOutputSchema}'s, so it satisfies `ExtensionToolAction.
 * outputSchema` and does NOT satisfy `BuiltinToolAction.outputSchema`. A new
 * action in `registry.ts` that reaches for this escape fails `npm run
 * typecheck`; `TOOL_REGISTRY` is declared `readonly BuiltinCompositeTool[]`, so
 * the door is the registry constant itself and not any one array's annotation.
 *
 * Task 055 shipped this as a run-time-only bound (`UNWAIVED_VACUITY` from
 * `auditVacuityAllowlist`) and said so. That ratchet is unchanged and still
 * covers vacuity that reaches the registry through a path the type system does
 * not govern — a forged brand, or a custom tool. What changed is that the
 * registry construction path is no longer such a path.
 */
export function unregisteredActionOutputSchema(): ExtensionOutputSchema {
  return declareExtensionOutputSchema(EnvelopeSchema(z.unknown()));
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
 * TASK 060, HOLE 1 — the out-of-registry escape mints a DIFFERENT brand, so it
 * is not a `DeclaredOutputSchema` and cannot satisfy `BuiltinToolAction.
 * outputSchema`. The other half of this claim (that `BuiltinToolAction` really
 * does demand `DeclaredOutputSchema`) is stated in `registry.ts`, at the
 * boundary it governs.
 */
export type _OutputSchemaExtensionEscapeIsNotDeclared = Expect<
  IsNotAssignable<ReturnType<typeof unregisteredActionOutputSchema>, DeclaredOutputSchema>
>;
/** …and symmetrically, a registry-blessed schema is not an extension schema. */
export type _OutputSchemaDeclaredIsNotExtension = Expect<
  IsNotAssignable<ReturnType<typeof withCappedShape>, ExtensionOutputSchema>
>;
export type _OutputSchemaWaiverIsNotExtension = Expect<
  IsNotAssignable<ReturnType<typeof vacuityWaiver>, ExtensionOutputSchema>
>;
/**
 * …and the guarantee is not vacuous: all three constructors DO produce their
 * brand, so the aliases above are rejecting the wrong-brand case rather than
 * rejecting everything. Without these lines, narrowing any of the three brands
 * to something nothing can produce would leave every negative proof passing.
 */
export type _OutputSchemaCappedShapeIsDeclared = Expect<
  ReturnType<typeof withCappedShape> extends DeclaredOutputSchema ? true : false
>;
export type _OutputSchemaWaiverIsDeclared = Expect<
  ReturnType<typeof vacuityWaiver> extends DeclaredOutputSchema ? true : false
>;
export type _OutputSchemaEscapeIsExtension = Expect<
  ReturnType<typeof unregisteredActionOutputSchema> extends ExtensionOutputSchema ? true : false
>;
/** A declared schema is still a `z.ZodType`, so no consumer had to change. */
export type _OutputSchemaDeclaredIsStillZodType = Expect<
  DeclaredOutputSchema extends z.ZodType ? true : false
>;
/** …and so is an extension schema — `ToolAction` consumers see one shape. */
export type _OutputSchemaExtensionIsStillZodType = Expect<
  ExtensionOutputSchema extends z.ZodType ? true : false
>;
/** Both brands satisfy the consumer-facing union, which is why nothing rippled. */
export type _OutputSchemaBothBrandsAreRegistered = Expect<
  DeclaredOutputSchema extends RegisteredOutputSchema
    ? ExtensionOutputSchema extends RegisteredOutputSchema
      ? true
      : false
    : false
>;
