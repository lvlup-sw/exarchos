/**
 * Minimal ambient type declarations for the `bun` module.
 *
 * At runtime `scripts/build-binary.ts` is executed by Bun (`bun run
 * scripts/build-binary.ts`), so the import resolves to Bun's built-in module.
 * Under Node it is never imported.
 *
 * This exists because `tsconfig.scripts.json` (task 066) brought the root
 * `scripts/` tree under `tsc` for the first time, and `build-binary.ts`'s
 * `import { $ } from 'bun'` had never been resolved by a typechecker.
 *
 * It follows the idiom `servers/exarchos-mcp/src/storage/__shims__/bun-sqlite.d.ts`
 * already established, and for the same stated reason: declaring only the surface
 * actually used is deliberately narrower than `@types/bun`'s full contract, which
 * would pull a competing `Bun` global into the project — and it keeps a
 * Bun-runtime type package out of the root dependency tree, which is Node-only.
 *
 * Covered surface: the `$` shell tag, awaited for its exit, at the single call
 * site in `scripts/build-binary.ts`. Widen this declaration when a call site
 * needs more, rather than swapping in the full package.
 */

declare module 'bun' {
  /** Bun's shell tag. `await $`…`` runs the command and throws on a non-zero exit. */
  export const $: (
    strings: TemplateStringsArray,
    ...expressions: readonly unknown[]
  ) => PromiseLike<unknown>;
}
