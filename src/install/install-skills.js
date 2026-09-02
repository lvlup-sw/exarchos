/**
 * `.js` re-export shim for `install-skills.ts`.
 *
 * The install-skills bridge (`src/lifecycle/install-skills-bridge.js`)
 * imports this module as `'../install/install-skills.js'` — a NodeNext
 * `.js` specifier — but only the `.ts` original ships. This shim lets
 * `vite-node` and `bun build --compile` follow the import without an
 * extension fallback or alias, by re-exporting the full surface of the
 * `.ts` original so every consumer (the bridge, the CLI tests, the
 * migration tests, the legacy-hash generator) finds the named symbols
 * it imports at the `.js` specifier path. tsc with `allowJs: false`
 * skips this file; the `.ts` source remains the type-only entry point
 * for `tsc`.
 *
 * `export *` is used (not a hand-written list) so the shim cannot drift
 * from the `.ts` original: every new export in `install-skills.ts` is
 * automatically available here. The only thing the `.ts` original MUST
 * NOT add is a conflicting re-export of the same name from a transitive
 * dependency.
 */
export * from './install-skills.ts';