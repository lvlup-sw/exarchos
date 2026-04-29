/**
 * Type declarations for the JavaScript bridge module
 * `install-skills-bridge.js`. The bridge is authored in JS so it can do
 * cross-package static imports without tripping tsc's `rootDir: "./src"`
 * constraint (see the bridge file's header for the full rationale).
 *
 * Implements: DR-7 (install-skills CLI), task 1.5 of the v2.9.0 closeout
 * (#1201).
 */

export function runInstallSkills(opts: { agent?: string }): Promise<void>;
