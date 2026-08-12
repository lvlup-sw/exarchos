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
 * To preserve the rootDir invariant we DO NOT use `import type` here
 * to reach outside `servers/exarchos-mcp/src/`. The `RuntimeMap` and
 * `InstallSkillsOpts` shapes used in the test-injection points are
 * declared locally with the loosest accurate signatures (`unknown`
 * arrays, `unknown` opts), which is sufficient for the call-site
 * `cli.ts` and lets the bridge tests pass typed mocks via
 * `as unknown as <type>` casts.
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
   * directly and trips the MCP server's tsc `rootDir`. Typed loosely (`Record`)
   * to preserve the rootDir invariant — the bridge tests pass typed mocks via
   * `as unknown as <type>` casts. Ignored when a custom `installer` is supplied.
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
 * array from `EMBEDDED_RUNTIMES` by default; reads `runtimes/*.yaml`
 * from disk when `EXARCHOS_RUNTIMES_FROM_DISK=1`.
 */
export function runInstallSkills(
  opts: { agent?: string },
  deps?: RunInstallSkillsDeps,
): Promise<void>;
