/**
 * `.js` re-export shim for `load.ts`.
 *
 * The install-skills bridge (`src/lifecycle/install-skills-bridge.js`)
 * and the runtime-presence / build-skills test suites import this module
 * as `'../install/runtimes/load.js'` — a NodeNext `.js` specifier — but
 * only the `.ts` original ships. This shim lets `vite-node` and
 * `bun build --compile` follow the import without an extension fallback
 * or alias, by re-exporting the full surface of the `.ts` original.
 * tsc with `allowJs: false` skips this file; the `.ts` source remains
 * the type-only entry point for `tsc`.
 *
 * `export *` is used so the shim cannot drift from the `.ts` original.
 */
export * from './load.ts';