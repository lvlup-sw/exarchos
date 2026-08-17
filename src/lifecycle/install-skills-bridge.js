/**
 * Bridge module for the `install-skills` install path.
 *
 * Statically imports `installSkills()`, `loadAllRuntimes()` and the
 * codegen-emitted `EMBEDDED_RUNTIMES`. Authored as plain JavaScript, not
 * TypeScript, and that is load-bearing in both directions: tsc runs with
 * `allowJs: false` so it never resolves these specifiers, while bun's
 * `--compile` bundler ignores tsc settings and follows them normally — which is
 * what puts the installer, and its lazy `@inquirer/prompts` import, inside the
 * single-file binary.
 *
 * Why a bridge rather than a dynamic import at the call site: a `string`-typed
 * dynamic import hides the specifier from bun's static analysis, and the
 * compiled binary then fails at user-runtime with "Cannot find module". bun has
 * to see the import statically to bundle it.
 *
 * ── Runtimes resolution policy ──────────────────────────────────────────────
 * The compiled binary is the primary install path, and `content/harness/runtimes/`
 * does not ship inside it — YAML files are not part of the static module graph,
 * so reading them from disk at user-runtime fails with "Runtimes directory not
 * found". A build-time codegen step emits `install/runtimes/embedded.ts`
 * instead; bun follows that import and bakes the validated, frozen array into
 * the binary, so the primary path has no filesystem dependency at all.
 *
 * Resolution order:
 *   - Default, including the compiled binary: `EMBEDDED_RUNTIMES` directly.
 *   - `EXARCHOS_RUNTIMES_FROM_DISK=1`: load the YAML from disk. Dev hot-reload
 *     only, for editing a runtime without re-running codegen. The
 *     `runtimes:guard` gate enforces that the two agree.
 */

import {
  installSkills,
  findSkillsSourceDir,
  findCommandAliasesSourceDir,
} from '../install/install-skills.js';
import { loadAllRuntimes } from '../install/runtimes/load.js';
import { EMBEDDED_RUNTIMES } from '../install/runtimes/embedded.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The authored runtime YAML directory. This bridge sits at `src/lifecycle/`, so
 * the repository root is two directories up.
 *
 * Only reached when `EXARCHOS_RUNTIMES_FROM_DISK=1` selects the filesystem
 * path. The compiled binary never calls it.
 *
 * @returns {string}
 */
function resolveRuntimesDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'content', 'harness', 'runtimes');
}

/**
 * Decide whether to read runtimes from disk. A named helper so the tests assert
 * on the same predicate production uses, rather than repeating the env var name
 * at two call sites.
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
 * @property {(dir: string) => import('../install/runtimes/types.js').RuntimeMap[]} [loadFromDisk]
 *   FS loader override (test injection). Defaults to `loadAllRuntimes`.
 * @property {readonly import('../install/runtimes/types.js').RuntimeMap[]} [embedded]
 *   Embedded array override (test injection). Defaults to `EMBEDDED_RUNTIMES`.
 * @property {(opts: import('../install/install-skills.js').InstallSkillsOpts) => Promise<void>} [installer]
 *   Installer override (test injection). Defaults to `installSkills`.
 * @property {Partial<import('../install/install-skills.js').InstallSkillsOpts>} [installSkillsOpts]
 *   Extra `installSkills` opts merged into the default-installer call. The
 *   onboard `installStep` threads its injectable I/O hooks — spawn, copyDir,
 *   homeDir, registerMcp, source overrides — through here so it never imports
 *   `installSkills` directly. Ignored when a custom `installer` is supplied.
 *   Source-tree fields here take precedence over the bridge's own resolution.
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
  const extraOpts = deps.installSkillsOpts ?? {};
  // The default installer merges any extra opts the caller threads through
  // (onboard's injectable I/O hooks). A custom `installer` takes them itself.
  const installer = deps.installer ?? ((o) => installSkills({ ...o, ...extraOpts }));

  const runtimes = shouldLoadFromDisk(env) ? loadFromDisk(resolveRuntimesDir()) : embedded;

  // Opt the binary entry point into the local-copy fast path by resolving
  // `skillsSource` here. Auto-detection walks the standard candidate list
  // (cwd/skills, binary-relative, src-relative dev path); when all of them miss
  // the value is `undefined` and `installSkills` falls back to the upstream
  // `npx skills add` shell-out. An injected source override wins over this.
  const skillsSource =
    'skillsSource' in extraOpts ? extraOpts.skillsSource : findSkillsSourceDir();

  // The canonical command-alias tree, resolved the same way. When it misses,
  // the installer skips the alias copy; only runtimes declaring
  // `commandsInstallPath` receive aliases at all.
  const aliasesSource =
    'aliasesSource' in extraOpts ? extraOpts.aliasesSource : findCommandAliasesSourceDir();

  await installer({ agent: opts.agent, runtimes, skillsSource, aliasesSource });
}
