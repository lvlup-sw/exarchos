/**
 * `.js` re-export shim for `install-skills.ts`.
 *
 * The install-skills bridge (`src/lifecycle/install-skills-bridge.js`) imports
 * `'../install/install-skills.js'`, but only the `.ts` original ships.
 * This shim lets `vite-node` and `bun build --compile` resolve that specifier
 * without an extension fallback or an alias.
 * `export *` keeps the shim in step with each export of the `.ts` original.
 * The `.ts` original must not add a conflicting re-export of the same name.
 */
export * from './install-skills.ts';