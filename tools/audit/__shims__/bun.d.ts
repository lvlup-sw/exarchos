/**
 * Minimal ambient types for the `bun` module.
 *
 * Bun runs `tools/release/build-binary.ts`, so its `import { $ } from 'bun'`
 * resolves to the Bun built-in. Node never imports it. `tsconfig.scripts.json`
 * typechecks that file, so `tsc` needs this declaration.
 *
 * It declares only the used surface, as `src/storage/__shims__/bun-sqlite.d.ts` does.
 * The full `@types/bun` adds a competing `Bun` global and a Bun type package to a
 * Node-only dependency tree. Widen this declaration when a call site needs more.
 */

declare module 'bun' {
  /** Bun's shell tag. `await $`…`` runs the command and throws on a non-zero exit. */
  export const $: (
    strings: TemplateStringsArray,
    ...expressions: readonly unknown[]
  ) => PromiseLike<unknown>;
}
