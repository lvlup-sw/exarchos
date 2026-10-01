/**
 * A `.js` re-export shim for `load.ts`.
 * Some modules and tests import this path with a NodeNext `.js` specifier, but only the `.ts` source ships.
 * The shim lets `vite-node` and `bun build --compile` resolve that import with no extension fallback or alias.
 * `export *` keeps the shim in step with `load.ts`. With `allowJs` off, tsc skips this file.
 */
export * from './load.ts';