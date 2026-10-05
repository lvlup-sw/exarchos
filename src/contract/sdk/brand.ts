/**
 * Generation brands for the owned MCP SDK seam. The v1 and v2 SDKs both declare a structural
 * `Transport`, so `tsc --strict` accepts a mix of the two. The mixed tree compiles and then hangs at run time.
 *
 * A third-party structural type cannot carry a brand, but the handle types of the seam can.
 * `./seam.ts` applies these brands. A handle from one generation in the position of the other
 * is a compile error.
 *
 * The phantom `__gen` property is optional. Thus a raw SDK value is assignable to the handle of
 * its own generation, and the seam factories need no `as` assertion. `{ __gen?: 'v1' }` is still
 * not assignable to `{ __gen?: 'v2' }`.
 *
 * An unbranded value passes into either position. The `SDK_SEAM_BOUNDARY` rule in
 * `architecture/layer-boundaries-seam.ts` and the lint in `architecture/sdk-generation-seam.ts`
 * cover that gap.
 */

/**
 * The two MCP SDK generations. `v1` is `@modelcontextprotocol/sdk` and its subpaths, and
 * `package.json` does not depend on it. `v2` is `@modelcontextprotocol/{core,server,client}`.
 * `architecture/sdk-generation-seam.ts` re-exports this type, so the lint and the brand agree.
 */
export type SdkGeneration = 'v1' | 'v2';

/**
 * The phantom discriminant of a seam handle. `__gen` does not exist at run time. It lets the
 * checker tell apart two structurally identical protocol types from different packages.
 */
export interface SdkGenerationBrand<G extends SdkGeneration> {
  readonly __gen?: G;
}

/** `T`, marked as a value from generation `G`. */
export type Branded<T, G extends SdkGeneration> = T & SdkGenerationBrand<G>;

/** `T`, marked as a value from the v1 SDK. */
export type V1<T> = Branded<T, 'v1'>;

/** `T`, marked as a value from the v2 SDK. */
export type V2<T> = Branded<T, 'v2'>;

/**
 * A typed hole: a surface that one generation has and the other does not. For example, v2
 * `2.0.0` has no Tasks store seam. No real value is assignable to this type, so a use of the
 * missing surface fails typecheck with `Reason` in the error. `never` is assignable to all
 * types, so it cannot do this.
 */
export interface SdkSurfaceGap<Reason extends string> {
  readonly __sdkSurfaceGap: Reason;
}
