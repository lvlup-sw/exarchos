/**
 * Emits canonical-name command aliases for the runtimes that autoload bare slash commands from a commands directory.
 * For each `COMMAND_TO_SKILL` entry, a capable runtime gets one markdown file.
 * Its `description` comes from the canonical `commands/<name>.md`, and its body delegates to the mapped skills with `$ARGUMENTS`.
 * Thus `/ideate`, `/plan`, and the other bare names also install on runtimes other than Claude.
 *
 * The gate is the `capabilities.canonicalCommandAliases` flag of each runtime, not a runtime name.
 * A new runtime needs only a change to its YAML. The skill-less `COMMAND_ONLY` commands get no alias.
 * The output tree `command-aliases/<runtime>/<canonical>.md` is a deterministic build artifact. Do not edit it by hand.
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

/** Summary of an alias-emission pass, so that callers can report without a new scan of the output tree. */
export interface CommandAliasReport {
  /** Total alias `.md` files written across all capable runtimes. */
  filesWritten: number;
  /** Absolute paths of every file produced, for stale-cleanup tracking. */
  writtenPaths: string[];
  /** Names of runtimes that received aliases (had the capability). */
  runtimesEmitted: string[];
}

/**
 * Read the `description:` line from the frontmatter of a command file. The frontmatter is flat, so no YAML parser is necessary.
 * A file with no `description` throws, so a malformed command fails the build and does not get an empty alias.
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
 * Render the body of one alias command file, in the style of the opencode `CHAIN` placeholder.
 * It names each mapped skill in `COMMAND_TO_SKILL` order and passes `$ARGUMENTS`, so the argument substitution of the runtime reaches the skill.
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

/** Render the full alias file, frontmatter and body, for one canonical command. */
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
 * Write one alias file per `COMMAND_TO_SKILL` entry for each runtime with `capabilities.canonicalCommandAliases: true`.
 * The output follows the key order of the map, so a drift guard can compare the tree. A runtime without the capability gets no directory.
 *
 * @param opts.runtimes - Loaded runtime maps to consider.
 * @param opts.commandsDir - Directory of the canonical `commands/<name>.md` files, the source of each `description`.
 * @param opts.outDir - Output root. Each capable runtime gets a `<outDir>/<runtime>/` subdirectory.
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
 * Remove each file under `root` that is not in `keep`, then remove the directories that become empty.
 * The caller scopes `root` to one `command-aliases/<runtime>/` subtree.
 * Unlike `cleanStaleFiles` in `build-skills/out-dir.ts`, a failed read, stat, or remove throws with the path, because drift correctness depends on the cleanup.
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
 * Full alias-emission pass. Load the runtimes, emit the alias tree with {@link buildCommandAliases}, then remove each alias file that this run did not write.
 * The cleanup covers every loaded runtime. Thus a runtime that drops the capability loses its old subtree.
 * The `build:skills` entry point and the `skills:guard` drift check both call this function, so both make the same tree.
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

  const keep = new Set(report.writtenPaths);
  for (const rt of runtimes) {
    cleanStaleAliasFiles(join(outDir, rt.name), keep);
  }

  return report;
}
