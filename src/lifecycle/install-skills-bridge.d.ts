/**
 * Type declarations for `install-skills-bridge.js`. They must stay in sync with that file.
 * The bridge is JavaScript, so tsc skips it (`allowJs: false`), and the bun `--compile` bundler still bakes its static imports into the binary.
 * The signatures are loose (`unknown` arrays, `Record` options), so this file has no coupling to `runtimes/load` or `install/install-skills`.
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
   * Extra `installSkills` options for the default installer. The onboard `installStep` passes its I/O hooks here, so it does not import `installSkills`.
   * The bridge ignores them when a custom `installer` is present.
   */
  installSkillsOpts?: Record<string, unknown>;
}

/**
 * Returns true when `EXARCHOS_RUNTIMES_FROM_DISK=1`. The bridge tests use the same predicate as the production path.
 */
export function shouldLoadFromDisk(env?: NodeJS.ProcessEnv): boolean;

/**
 * Runs the `install-skills` CLI subcommand. The runtime maps come from `EMBEDDED_RUNTIMES`.
 * When `EXARCHOS_RUNTIMES_FROM_DISK=1`, they come from `content/harness/runtimes/*.yaml` on disk.
 */
export function runInstallSkills(
  opts: { agent?: string },
  deps?: RunInstallSkillsDeps,
): Promise<void>;