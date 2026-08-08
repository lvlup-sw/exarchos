/**
 * Generation brands for the owned MCP SDK seam (DR-26).
 *
 * ── The claim this file exists to make true ─────────────────────────────────
 * DR-0 originally required that *"a partially-migrated tree must fail typecheck
 * rather than resolve two copies of the protocol types"*. Task 049 measured that
 * and it is **false**: v1 and v2 both declare a *structural* `Transport`, and
 * TypeScript has no notion of nominal package identity, so `tsc --strict`
 * accepts every mixing direction — including the cross-package
 * `InMemoryTransport` linked pair the criterion named as its kill fixture. The
 * resulting failure is the dangerous kind: the tree compiles clean and hangs (or
 * returns nothing) at runtime.
 *
 * The criterion was not wrong; it was **assigned to a subject that cannot carry
 * it.** You cannot brand a third party's structural type. You *can* brand your
 * own seam's handle types — which is what this module provides and what
 * `./seam.ts` applies. Once a handle is drawn through the seam it carries a
 * generation discriminant, and handing it to the other generation is a compile
 * error. That is DR-0's rung-2 criterion, relocated to a subject that can bear
 * it.
 *
 * ── The mechanism, and why the discriminant is OPTIONAL ─────────────────────
 * The brand is a phantom property `__gen` whose type is the generation literal.
 * It is declared **optional** on purpose, and the choice is load-bearing in both
 * directions:
 *
 *   • Optional ⇒ a raw SDK value IS assignable to its own generation's branded
 *     handle. That is what lets every factory in `./seam.ts` return a branded
 *     handle by plain `return`, with **zero `as` assertions**. A required brand
 *     would force one assertion per factory — and the wave's entire remaining
 *     `asCast` allowance is 5 sites (see `src/tsconfig-strictness.test.ts`).
 *     Buying nominality with assertions would also be self-defeating: an `as`
 *     is exactly the escape hatch that lets a wrong-generation value through.
 *
 *   • Optional does NOT weaken the rejection. `{ __gen?: 'v1' }` is not
 *     assignable to `{ __gen?: 'v2' }` — the property is declared on both sides
 *     and the literal types disagree — so a v1 handle in a v2 position is an
 *     error with or without `exactOptionalPropertyTypes`. Both directions were
 *     measured under this package's own strict settings before the mechanism was
 *     chosen.
 *
 * ── What this brand deliberately does NOT do ────────────────────────────────
 * An optional brand admits an **unbranded** value into either generation's
 * position: a module that bypasses the seam and imports the SDK directly still
 * compiles. That hole is intentional and is covered by a different instrument at
 * a different rung — `architecture/sdk-generation-seam.ts` (the rung-3
 * generation-mixing lint, shipped by task 049) and
 * `architecture/layer-boundaries-seam.ts`'s `SDK_SEAM_BOUNDARY` rule (task 053),
 * which rejects a direct SDK import outright and, as of task 053, has no
 * exemptions and no live subject in the tree. The three are complementary by
 * design: the rule decides *who may import the SDK*, the lint decides *who may
 * hold both generations at once*, the brand decides *what may be passed to
 * what*. None subsumes another, and DR-26 retains all three for that reason.
 */

/**
 * The two MCP SDK generations that coexist in this package.
 *
 *   • `v1` — `@modelcontextprotocol/sdk` (and every `…/sdk/*` subpath)
 *   • `v2` — `@modelcontextprotocol/{core,server,client}`
 *
 * This is the single authority for the generation vocabulary;
 * `architecture/sdk-generation-seam.ts` re-exports it rather than declaring its
 * own copy, so the lint and the brand can never disagree about what a generation
 * is.
 */
export type SdkGeneration = 'v1' | 'v2';

/**
 * The phantom discriminant carried by every handle that crosses the seam.
 *
 * `__gen` has no runtime existence: nothing ever writes it and nothing ever
 * reads it. It exists so the checker can tell two structurally identical
 * protocol types apart by the package they came from.
 */
export interface SdkGenerationBrand<G extends SdkGeneration> {
  readonly __gen?: G;
}

/** `T`, marked as having been drawn from generation `G`. */
export type Branded<T, G extends SdkGeneration> = T & SdkGenerationBrand<G>;

/** `T`, marked as having been drawn from the v1 SDK. */
export type V1<T> = Branded<T, 'v1'>;

/** `T`, marked as having been drawn from the v2 SDK. */
export type V2<T> = Branded<T, 'v2'>;

/**
 * A **typed hole**: a surface one generation has and the other does not.
 *
 * v2 `2.0.0` deleted the experimental Tasks *store* seam — there is no
 * `ServerOptions.taskStore`, and `TaskStore` / `CreateTaskOptions` / `isTerminal`
 * have zero matches anywhere in either v2 package. The honest representation of
 * that is a named, uninhabited type rather than an invented replacement: nothing
 * real is assignable to it, so any attempt to use the missing surface fails
 * typecheck with `Reason` printed in the error.
 *
 * `never` was rejected for this role precisely because it is assignable to
 * everything and would let the gap pass silently.
 */
export interface SdkSurfaceGap<Reason extends string> {
  readonly __sdkSurfaceGap: Reason;
}
