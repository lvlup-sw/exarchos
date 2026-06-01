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
 * `COMMAND_ONLY` commands (`autocompact`, `rehydrate`, `tag`) are skill-less
 * and intentionally excluded here — they are tracked as a known gap in T5.
 *
 * The generated tree `command-aliases/<runtime>/<canonical>.md` is a build
 * artifact (like `skills/`): deterministic, never hand-edited, and
 * drift-guarded by T4.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeMap } from './runtimes/types.js';
import { COMMAND_TO_SKILL } from './config/canonical-skills.js';

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
  if (!match) {
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
