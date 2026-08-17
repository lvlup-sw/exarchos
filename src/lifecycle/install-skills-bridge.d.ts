/**
 * Type declarations for the install-skills bridge module.
 *
 * The bridge at `install-skills-bridge.js` is authored as JavaScript so
 * tsc (allowJs: false) skips it during the production build while bun's
 * `--compile` bundler still follows its static imports and bakes them
 * into the single-file binary. Without this declaration file tsc cannot
 * give `install.ts` a typed surface for its `await import(...)` of the
 * bridge (the transitive module is excluded from compilation by tsc's
 * `allowJs: false`, so its exports are not in tsc's symbol table).
 *
 * This file is the type-only facade. The runtime source of truth lives
 * at `install-skills-bridge.js`; the two MUST stay in sync. The deps
 * shape is declared with the loosest accurate signatures (`unknown`
 * arrays, `Record` opts) so the bridge tests can pass typed mocks via
 * `as unknown as <type>` casts without coupling this file to the
 * `runtimes/load` or `install/install-skills` module shapes.
 *
 * Implements: DR-7 (install-skills CLI surface), T-16 (#1201),
 *             #1213 review-item #4 reversal, #1214.
 */

/**
 * Optional injection points for tests. Production code calls
 * `runInstallSkills(opts)` without the second argument.
 */
export interface RunInstallSkillsDeps {
  env?: NodeJS.ProcessEnv;
  loadFromDisk?: (dir: string) => readonly unknown[];
  embedded?: readonly unknown[];
  installer?: (opts: unknown) => Promise<void>;
  /**
   * Extra `installSkills` opts merged into the default-installer call. The
   * onboard `installStep` threads injectable I/O hooks here (spawn / copyDir /
   * homeDir / registerMcp / source overrides) so it never imports `installSkills`
   * directly. Typed loosely (`Record`) so this declaration stays free of
   * coupling to `runtimes/load` or `install/install-skills`; the bridge tests
   * pass typed mocks via `as unknown as <type>` casts. Ignored when a custom
   * `installer` is supplied.
   */
  installSkillsOpts?: Record<string, unknown>;
}

/**
 * `EXARCHOS_RUNTIMES_FROM_DISK=1` toggle predicate. Exported so the
 * bridge tests can assert on the same predicate the production path
 * uses without re-checking the literal env var name in two places.
 */
export function shouldLoadFromDisk(env?: NodeJS.ProcessEnv): boolean;

/**
 * Run the `install-skills` CLI subcommand. Resolves the runtime map
 * array from `EMBEDDED_RUNTIMES` by default; reads `content/harness/runtimes/*.yaml`
 * from disk when `EXARCHOS_RUNTIMES_FROM_DISK=1`.
 */
export function runInstallSkills(
  opts: { agent?: string },
  deps?: RunInstallSkillsDeps,
): Promise<void>;