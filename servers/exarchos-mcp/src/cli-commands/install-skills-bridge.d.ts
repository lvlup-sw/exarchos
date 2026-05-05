/**
 * Type declarations for the JavaScript bridge module
 * `install-skills-bridge.js`.
 *
 * The bridge is authored in JS so it can do cross-package static
 * imports without tripping tsc's `rootDir: "./src"` constraint
 * (see the bridge file's header for the full rationale). This `.d.ts`
 * gives `cli.ts` a typed surface for the dynamic import in the
 * `install-skills` action handler.
 *
 * Implements: DR-7 (install-skills CLI surface), T-16 (#1201).
 */

export function runInstallSkills(opts: { agent?: string }): Promise<void>;
