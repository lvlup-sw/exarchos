/**
 * The bridge for the `install-skills` path. It imports `installSkills()`, `loadAllRuntimes()` and
 * the generated `EMBEDDED_RUNTIMES` statically.
 *
 * The module is plain JavaScript on purpose. tsc runs with `allowJs: false`, so it does not resolve
 * these specifiers. The bun `--compile` bundler follows them, so the installer and its lazy
 * `@inquirer/prompts` import go into the single-file binary. A `string`-typed dynamic import at the
 * call site hides the specifier from bun, and the binary then fails with "Cannot find module".
 *
 * The binary does not contain `content/harness/runtimes/`, so a build-time codegen step writes
 * `install/runtimes/embedded.ts` and bun bundles that array. By default the bridge uses
 * `EMBEDDED_RUNTIMES`. `EXARCHOS_RUNTIMES_FROM_DISK=1` loads the YAML from disk for development,
 * and the `runtimes:guard` gate keeps the two in agreement.
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
 * Runs the installer with the selected runtimes and the detected source trees. An injected
 * `skillsSource` or `aliasesSource` wins over detection. If no skills source is found,
 * `installSkills` runs `npx skills add`. If no alias source is found, it skips the alias copy.
 *
 * @param {{ agent?: string }} opts
 * @param {RunInstallSkillsDeps} [deps]
 * @returns {Promise<void>}
 */
export async function runInstallSkills(opts, deps = {}) {
  const env = deps.env ?? process.env;
  const loadFromDisk = deps.loadFromDisk ?? loadAllRuntimes;
  const embedded = deps.embedded ?? EMBEDDED_RUNTIMES;
  const extraOpts = deps.installSkillsOpts ?? {};
  const installer = deps.installer ?? ((o) => installSkills({ ...o, ...extraOpts }));

  const runtimes = shouldLoadFromDisk(env) ? loadFromDisk(resolveRuntimesDir()) : embedded;

  const skillsSource =
    'skillsSource' in extraOpts ? extraOpts.skillsSource : findSkillsSourceDir();

  const aliasesSource =
    'aliasesSource' in extraOpts ? extraOpts.aliasesSource : findCommandAliasesSourceDir();

  await installer({ agent: opts.agent, runtimes, skillsSource, aliasesSource });
}
