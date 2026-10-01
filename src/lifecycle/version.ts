/**
 * The `exarchos version --check-plugin-root <path>` subcommand. It calls
 * `checkPluginRootCompatibility` for a plugin root and returns an exit code:
 *   - 0: the binary satisfies `metadata.compat.minBinaryVersion`, or the plugin has
 *     no usable compat metadata. The second case writes an advisory to stderr.
 *   - 1: the declared `minBinaryVersion` is newer than the running binary.
 *
 * The library owns the policy of what counts as drift. Other callers must reuse it.
 */
import { checkPluginRootCompatibility } from '../runtime/lib/plugin-compat.js';

export interface VersionCheckOptions {
  /** Absolute path to the plugin root (directory containing .claude-plugin/plugin.json). */
  readonly pluginRoot: string;
  /** The semver of the running binary. */
  readonly binaryVersion: string;
}

/**
 * Entry point for `exarchos version --check-plugin-root <path>`. It returns the exit
 * code and does not call `process.exit()`, so tests can assert the code. A compatible
 * result writes one line to stdout. An advisory or a drift writes to stderr, so a CI
 * log shows it when stdout goes to a file.
 */
export async function handleVersionCheck(
  opts: VersionCheckOptions,
): Promise<number> {
  const result = checkPluginRootCompatibility(opts.pluginRoot, opts.binaryVersion);

  if (result.minRequired === null) {
    process.stderr.write(`exarchos version: ${result.message}\n`);
    return 0;
  }

  if (!result.compatible) {
    process.stderr.write(`exarchos version: ${result.message}\n`);
    return 1;
  }

  process.stdout.write(`${result.message}\n`);
  return 0;
}
