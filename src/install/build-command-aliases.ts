/**
 * Canonical-name command alias emitter (T2, v2.10.1 Bundle A, #1472).
 *
 * Some runtimes autoload **bare canonical-name** slash commands from a
 * commands directory (e.g. opencode reads `~/.config/opencode/commands/
 * <name>.md`). For those runtimes the skills build emits one thin "alias"
 * command file per `COMMAND_TO_SKILL` entry: a markdown file with YAML
 * frontmatter whose `description` is lifted from the canonical command
 * (`commands/<name>.md`) and whose body is a short directive that delegates
 * to the underlying skill(s), passing `$ARGUMENTS` through. This installs the
 * bare canonical names (`/ideate`, `/plan`, ...) off the Claude path,
 * closing the INV-4 parity gap noted in the design.
 *
 * The emission gate is the runtime's declared
 * `capabilities.canonicalCommandAliases` flag — never a hardcoded
 * runtime-name literal. Only opencode declares it this cycle; codex
 * (deprecated, namespaced prompts), copilot (no CLI autoload), and
 * cursor/generic (no command surface) declare nothing and receive zero
 * files. Adding a future runtime is a pure data change in its YAML.
 *
 * `COMMAND_ONLY` commands (`autocompact`, `tag`) are skill-less
 * and intentionally excluded here — they are tracked as a known gap in T5.
 *
 * The generated tree `command-aliases/<runtime>/<canonical>.md` is a build
 * artifact (like `skills/`): deterministic, never hand-edited, and
 * drift-guarded by T4.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeMap } from './runtimes/types.js';
import { COMMAND_TO_SKILL } from './config/canonical-skills.js';
import { loadAllRuntimes } from './runtimes/load.js';

/**
 * Summary of an alias-emission pass so callers (the build entry point,
 * tests) can report on what happened without re-scanning the output tree.
 */
export interface CommandAliasReport {
  /** Total alias `.md` files written across all capable runtimes. */
  filesWritten: number;
  /** Absolute paths of every file produced, for stale-cleanup tracking. */
  writtenPaths: string[];
  /** Names of runtimes that received aliases (had the capability). */
  runtimesEmitted: string[];
}

/**
 * Extract the `description` value from a command file's YAML frontmatter.
 *
 * Command frontmatter is a small, flat block delimited by `---` fences; we
 * read only the `description:` line rather than pulling in a YAML parser,
 * matching how the co-located drift guard parses these files. Throws if the
 * file has no `description` so a malformed command surfaces at build time
 * rather than emitting an alias with an empty description.
 */
function readCommandDescription(commandPath: string): string {
  const src = readFileSync(commandPath, 'utf8');
  const match = src.match(/^description:\s*(.+?)\s*$/m);
  if (!match || match[1] === undefined) {
    throw new Error(
      `buildCommandAliases: ${commandPath} has no \`description:\` frontmatter ` +
        `to lift into the canonical alias.`,
    );
  }
  return match[1].trim();
}

/**
 * Render a single alias command file body.
 *
 * The directive matches the voice of opencode's `CHAIN` placeholder
 * (`[Invoke the exarchos:<skill> skill with args: <args>]`): name every
 * mapped skill, in `COMMAND_TO_SKILL` order, and thread `$ARGUMENTS`
 * through so the runtime's argument substitution reaches the skill.
 */
function renderAliasBody(command: string, skills: readonly string[]): string {
  const skillList =
    skills.length === 1
      ? `the \`${skills[0]}\` skill`
      : skills.map((s) => `\`${s}\``).join(', then ') + ' skills';
  return (
    `# /${command}\n` +
    `\n` +
    `Canonical alias for the Exarchos \`/${command}\` workflow command.\n` +
    `\n` +
    `Invoke ${skillList} to handle: $ARGUMENTS\n`
  );
}

/**
 * Render the full alias file (frontmatter + body) for one canonical command.
 */
function renderAliasFile(
  command: string,
  skills: readonly string[],
  description: string,
): string {
  return (
    `---\n` +
    `description: ${description}\n` +
    `---\n` +
    `\n` +
    renderAliasBody(command, skills)
  );
}

/**
 * Emit canonical-name command alias files for every runtime in `runtimes`
 * that declares `capabilities.canonicalCommandAliases: true`.
 *
 * For each capable runtime, writes one `command-aliases/<runtime>/
 * <canonical>.md` file per `COMMAND_TO_SKILL` entry. Output ordering is
 * stable (the map's key order is insertion order, and content is a pure
 * function of the map + command frontmatter) so the tree can be
 * drift-guarded.
 *
 * Runtimes lacking the capability are skipped entirely — no directory is
 * created for them.
 *
 * @param opts.runtimes - Loaded runtime maps to consider.
 * @param opts.commandsDir - Directory of canonical `commands/<name>.md`
 *   files (source of the lifted `description`).
 * @param opts.outDir - Output root; each capable runtime gets a
 *   `<outDir>/<runtime>/` subdirectory.
 * @returns A populated {@link CommandAliasReport}.
 */
export function buildCommandAliases(opts: {
  runtimes: readonly RuntimeMap[];
  commandsDir: string;
  outDir: string;
}): CommandAliasReport {
  const { runtimes, commandsDir, outDir } = opts;
  const writtenPaths: string[] = [];
  const runtimesEmitted: string[] = [];

  // Iterate commands in map order for deterministic output.
  const commandEntries = Object.entries(COMMAND_TO_SKILL);

  for (const rt of runtimes) {
    if (rt.capabilities.canonicalCommandAliases !== true) continue;
    runtimesEmitted.push(rt.name);

    const runtimeOutDir = join(outDir, rt.name);
    mkdirSync(runtimeOutDir, { recursive: true });

    for (const [command, skills] of commandEntries) {
      const commandPath = join(commandsDir, `${command}.md`);
      if (!existsSync(commandPath)) {
        throw new Error(
          `buildCommandAliases: COMMAND_TO_SKILL references "${command}" but ` +
            `${commandPath} does not exist. The map and commands/ are out of sync.`,
        );
      }
      const description = readCommandDescription(commandPath);
      const contents = renderAliasFile(command, skills, description);
      const outFile = join(runtimeOutDir, `${command}.md`);
      writeFileSync(outFile, contents);
      writtenPaths.push(resolve(outFile));
    }
  }

  return {
    filesWritten: writtenPaths.length,
    writtenPaths,
    runtimesEmitted,
  };
}

/**
 * Recursively remove any file under `root` not present in `keep`, then
 * prune emptied directories bottom-up. Scoped to a per-runtime subtree
 * (`command-aliases/<runtime>/`) so unrelated files are never touched.
 *
 * Modeled on `cleanStaleFiles` in `build-skills.ts` but, unlike that older
 * twin, does not swallow filesystem errors: a failed read/stat/remove during
 * cleanup is a real fault (drift correctness depends on it) and is rethrown
 * with path context rather than silently skipped — per the repo's
 * no-silent-catches guideline.
 */
function cleanStaleAliasFiles(root: string, keep: Set<string>): void {
  if (!existsSync(root)) return;

  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      throw new Error(
        `cleanStaleAliasFiles: failed to read directory "${dir}": ${String(err)}`,
      );
    }

    let survivorCount = 0;
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch (err) {
        throw new Error(
          `cleanStaleAliasFiles: failed to stat "${full}": ${String(err)}`,
        );
      }
      if (st.isDirectory()) {
        const hadSurvivors = walk(full);
        if (hadSurvivors) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { recursive: true, force: true });
          } catch (err) {
            throw new Error(
              `cleanStaleAliasFiles: failed to remove directory "${full}": ${String(err)}`,
            );
          }
        }
      } else if (st.isFile()) {
        if (keep.has(resolve(full))) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { force: true });
          } catch (err) {
            throw new Error(
              `cleanStaleAliasFiles: failed to remove file "${full}": ${String(err)}`,
            );
          }
        }
      }
    }
    return survivorCount > 0;
  };

  walk(root);
}

/**
 * Full alias-emission pass: load runtimes from `runtimesDir`, emit the
 * canonical-name alias tree via {@link buildCommandAliases}, then drop any
 * pre-existing alias file (per emitting runtime) this run did not produce
 * so renamed/removed commands don't linger.
 *
 * This is the single deterministic entry point shared by `build:skills`'s
 * `main()` and the `skills:guard` drift check, so both regenerate the
 * `command-aliases/**` tree identically before reporting or diffing.
 *
 * @param opts.runtimesDir - Directory of `content/harness/runtimes/<name>.yaml` maps.
 * @param opts.commandsDir - Directory of canonical `commands/<name>.md`.
 * @param opts.outDir - Output root (`command-aliases/`).
 * @returns The {@link CommandAliasReport} from the emission pass.
 */
export function emitCommandAliases(opts: {
  runtimesDir: string;
  commandsDir: string;
  outDir: string;
}): CommandAliasReport {
  const { runtimesDir, commandsDir, outDir } = opts;
  const runtimes = loadAllRuntimes(runtimesDir);
  const report = buildCommandAliases({ runtimes, commandsDir, outDir });

  // Clean across ALL loaded runtimes, not just the emitting ones: a runtime
  // that previously declared `canonicalCommandAliases` and later dropped it
  // would otherwise leave its `command-aliases/<runtime>/` tree orphaned
  // forever. `keep` only contains paths under emitting runtimes' subtrees, so
  // a non-emitting runtime's stale dir is fully pruned with the same keep-set.
  const keep = new Set(report.writtenPaths);
  for (const rt of runtimes) {
    cleanStaleAliasFiles(join(outDir, rt.name), keep);
  }

  return report;
}
