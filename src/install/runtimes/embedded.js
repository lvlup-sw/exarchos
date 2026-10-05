/**
 * `.js` re-export shim for `embedded.ts`.
 *
 * `src/lifecycle/install-skills-bridge.js` imports this module with a NodeNext `.js` specifier, but only the
 * `.ts` original ships. This shim lets `vite-node` and `bun build --compile` follow that import with no
 * extension fallback or alias. `export *` keeps the shim in step with the `.ts` original. `tsc` skips this
 * file because `allowJs` is off, so the `.ts` source stays the type entry point.
 */
export * from './embedded.ts';