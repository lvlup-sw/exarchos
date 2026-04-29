/**
 * Bridge module for the `install-skills` CLI subcommand.
 *
 * This file imports `installSkills()` and the embedded runtime maps from
 * the workspace-root `src/` tree, which lives outside the MCP server's
 * tsc `rootDir: "./src"`. Authored as plain JavaScript (not TypeScript)
 * so tsc — which has `allowJs: false` — never resolves these specifiers
 * and never emits TS6059 ("file is not under rootDir"). Bun's
 * `--compile` bundler ignores tsc settings and follows the static
 * imports normally, so the embedded runtime maps + the installer end up
 * inside the single-file binary.
 *
 * If/when the MCP server adopts TypeScript Project References (so the
 * root and server tsconfigs can share a project graph cleanly), this
 * file can be promoted back to `.ts`.
 *
 * Implements: DR-7 (install-skills CLI), task 1.5 of the v2.9.0 closeout
 * (#1201).
 */

import { installSkills } from '../../../../src/install-skills.js';
import { loadEmbeddedRuntimes } from '../../../../src/runtimes/embedded.js';

/**
 * @param {{ agent?: string }} opts
 * @returns {Promise<void>}
 */
export async function runInstallSkills(opts) {
  const runtimes = Object.values(loadEmbeddedRuntimes());
  await installSkills({ agent: opts.agent, runtimes });
}
