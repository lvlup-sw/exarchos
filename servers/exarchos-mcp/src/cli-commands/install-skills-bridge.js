/**
 * Bridge module for the `install-skills` CLI subcommand (T-16, #1201).
 *
 * Imports `installSkills()`, `loadAllRuntimes()`, and the codegen-emitted
 * `EMBEDDED_RUNTIMES` from the workspace-root `src/` tree, which lives
 * outside the MCP server's tsc `rootDir: "./src"`. Authored as plain
 * JavaScript (not TypeScript) so tsc — which has `allowJs: false` —
 * never resolves these specifiers and therefore never emits TS6059
 * ("file is not under rootDir"). Bun's `--compile` bundler ignores tsc
 * settings and follows the static imports normally, so the installer
 * code (and its `@inquirer/prompts` lazy import) end up inside the
 * single-file binary.
 *
 * Why a JS bridge instead of a runtime dynamic import in `cli.ts`:
 *   - A `string`-typed dynamic import would hide the specifier from
 *     bun's static analysis and break the compiled binary at user-runtime
 *     ("Cannot find module"). bun must see the import statically to
 *     bundle it.
 *   - Promoting the bridge to `.ts` would require enabling Project
 *     References across the root and server tsconfigs, which is a
 *     larger refactor. T-16 deliberately ships in a single isolated
 *     commit; the bridge can move to `.ts` later.
 *
 * ── Runtimes resolution policy (#1213, #1214) ─────────────────────────
 * Compiled binary is the PRIMARY install path. The `runtimes/` directory
 * does not ship inside `bun build --compile` output (YAML files aren't
 * part of the static module graph), so reading them from disk at
 * user-runtime fails with "Runtimes directory not found". Per #1109 §2
 * (MCP parity) and the axiom backend-quality "no runtime FS dependency
 * on the primary path" principle, we inject the runtime map array via
 * a build-time codegen step (`scripts/codegen-runtimes.ts`) that emits
 * `src/runtimes/embedded.ts`. Bun statically follows that import and
 * bakes the validated, frozen `EMBEDDED_RUNTIMES` array into the binary.
 *
 * Resolution order:
 *   - Default (production, including the compiled binary): use
 *     `EMBEDDED_RUNTIMES` directly. Zero filesystem dependency.
 *   - Override (`EXARCHOS_RUNTIMES_FROM_DISK=1`): load from
 *     `runtimes/*.yaml` relative to this bridge's location. Used only
 *     for dev hot-reload — when an author edits a YAML file and wants
 *     to skip the codegen step. CI's `runtimes:guard` enforces drift.
 *
 * Implements: DR-7 (install-skills CLI surface), T-16 (#1201),
 *             #1213 review-item #4 reversal, #1214.
 */

import {
  installSkills,
  findSkillsSourceDir,
  findCommandAliasesSourceDir,
} from '../../../../src/install-skills.js';
import { loadAllRuntimes } from '../../../../src/runtimes/load.js';
import { EMBEDDED_RUNTIMES } from '../../../../src/runtimes/embedded.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Walk from this bridge up to the workspace root. Bridge lives at
 * `servers/exarchos-mcp/src/cli-commands/` so the workspace root is
 * four directories above. The runtimes YAML directory sits directly
 * under the workspace root.
 *
 * Only used when `EXARCHOS_RUNTIMES_FROM_DISK=1` selects the FS path
 * (dev hot-reload). The compiled binary never reaches this function.
 *
 * @returns {string}
 */
function resolveRuntimesDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'runtimes');
}

/**
 * Decide whether to read runtimes from disk. Pulled into a named
 * helper so the bridge tests can spy on the env var without
 * duplicating the string literal across call sites.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function shouldLoadFromDisk(env = process.env) {
  return env.EXARCHOS_RUNTIMES_FROM_DISK === '1';
}

/**
 * @typedef {Object} RunInstallSkillsDeps
 * @property {NodeJS.ProcessEnv} [env]
 *   Process env override (test injection).
 * @property {(dir: string) => import('../../../../src/runtimes/types.js').RuntimeMap[]} [loadFromDisk]
 *   FS loader override (test injection). Defaults to `loadAllRuntimes`.
 * @property {readonly import('../../../../src/runtimes/types.js').RuntimeMap[]} [embedded]
 *   Embedded array override (test injection). Defaults to
 *   `EMBEDDED_RUNTIMES` from the codegen-emitted module.
 * @property {(opts: import('../../../../src/install-skills.js').InstallSkillsOpts) => Promise<void>} [installer]
 *   Installer override (test injection). Defaults to `installSkills`.
 */

/**
 * @param {{ agent?: string }} opts
 * @param {RunInstallSkillsDeps} [deps]
 * @returns {Promise<void>}
 */
export async function runInstallSkills(opts, deps = {}) {
  const env = deps.env ?? process.env;
  const loadFromDisk = deps.loadFromDisk ?? loadAllRuntimes;
  const embedded = deps.embedded ?? EMBEDDED_RUNTIMES;
  const installer = deps.installer ?? installSkills;

  const runtimes = shouldLoadFromDisk(env)
    ? loadFromDisk(resolveRuntimesDir())
    : embedded;

  // #1355 fix: opt the binary entry point in to the local-copy fast
  // path by resolving `skillsSource` here. Auto-detection lives in
  // `findSkillsSourceDir()` and walks the standard candidate list
  // (cwd/skills, binary-relative dist/bin/../../skills, src/-relative
  // dev path). When all three miss, the value is `undefined` and
  // `installSkills` falls back to the upstream `npx skills add`
  // shell-out — same behavior as before #1355.
  const skillsSource = findSkillsSourceDir();

  // T3 (#1471/#1472): opt the binary into the canonical command-alias
  // install by resolving the `command-aliases/` source tree the same way
  // (cwd, binary-relative, src-relative). When it misses (undefined) the
  // installer skips the alias copy. Only runtimes that declare
  // `commandsInstallPath` (opencode today) actually receive aliases.
  const aliasesSource = findCommandAliasesSourceDir();

  await installer({ agent: opts.agent, runtimes, skillsSource, aliasesSource });
}
