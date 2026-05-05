/**
 * Bridge module for the `install-skills` CLI subcommand (T-16, #1201).
 *
 * Imports `installSkills()` and `loadAllRuntimes()` from the workspace-root
 * `src/` tree, which lives outside the MCP server's tsc `rootDir: "./src"`.
 * Authored as plain JavaScript (not TypeScript) so tsc — which has
 * `allowJs: false` — never resolves these specifiers and therefore never
 * emits TS6059 ("file is not under rootDir"). Bun's `--compile` bundler
 * ignores tsc settings and follows the static imports normally, so the
 * installer code (and its `@inquirer/prompts` lazy import) end up inside
 * the single-file binary.
 *
 * Why a JS bridge instead of a runtime dynamic import in `cli.ts`:
 *   - A `string`-typed dynamic import would hide the specifier from bun's
 *     static analysis and break the compiled binary at user-runtime
 *     ("Cannot find module"). bun must see the import statically to
 *     bundle it.
 *   - Promoting the bridge to `.ts` would require enabling Project
 *     References across the root and server tsconfigs, which is a
 *     larger refactor. T-16 deliberately ships in a single isolated
 *     commit; the bridge can move to `.ts` later.
 *
 * Runtimes-directory resolution: `loadAllRuntimes` reads YAML from a
 * directory path. For a local-checkout invocation we resolve the path
 * relative to this bridge's location (walk up to the workspace root).
 * For the compiled binary, a future commit can swap to an embedded
 * codegen module — `installSkills()` already accepts the `runtimes`
 * array via injection, so the swap is local to this file.
 *
 * Implements: DR-7 (install-skills CLI surface), T-16 (#1201).
 */

import { installSkills } from '../../../../src/install-skills.js';
import { loadAllRuntimes } from '../../../../src/runtimes/load.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Walk from this bridge up to the workspace root. Bridge lives at
 * `servers/exarchos-mcp/src/cli-commands/` so the workspace root is four
 * directories above. The runtimes YAML directory sits directly under
 * the workspace root.
 *
 * @returns {string}
 */
function resolveRuntimesDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'runtimes');
}

/**
 * @param {{ agent?: string }} opts
 * @returns {Promise<void>}
 */
export async function runInstallSkills(opts) {
  const runtimes = loadAllRuntimes(resolveRuntimesDir());
  await installSkills({ agent: opts.agent, runtimes });
}
