/**
 * T1 (v2.10.1 Bundle A, #1472) — Canonical command → skill map drift guard.
 *
 * `COMMAND_TO_SKILL` (in `./canonical-skills.ts`) is the single source-of-truth
 * mapping from a canonical workflow command name to the underlying skill
 * directory name(s) it delegates to. This test derives the *expected* mapping
 * from the actual `commands/*.md` files at test time and asserts the map agrees,
 * so the human-readable "Skill Reference" prose in the command files cannot drift
 * away from the machine-readable map without failing CI.
 *
 * A command file may reference MORE THAN ONE skill (e.g. `delegate.md` ->
 * `delegation` + `git-worktrees`; `review.md` -> `spec-review` + `quality-review`).
 * Only `@skills/<dir>/SKILL.md` references count — `@skills/<dir>/references/*.md`
 * include paths are NOT skill entry points and must be ignored.
 *
 * Commands that delegate to no skill (`autocompact`, `rehydrate`, `tag`) are
 * declared in `COMMAND_ONLY` and must NOT appear in `COMMAND_TO_SKILL`.
 *
 * Scope: content-only validation of the markdown command templates against the
 * map. No runtime execution required.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMAND_TO_SKILL, COMMAND_ONLY, canonicalCommandSet } from './canonical-skills.js';

// `src/config/` → repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const commandsDir = join(repoRoot, 'commands');
const skillsSrcDir = join(repoRoot, 'skills-src');

/** Matches a skill *entry-point* reference, e.g. `@skills/spec-review/SKILL.md`. */
const SKILL_REF = /@skills\/([^/]+)\/SKILL\.md/g;

/** All command file base names (without `.md`). */
const commandNames = readdirSync(commandsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => basename(f, '.md'))
  .sort();

/** Parse the distinct skill dirs a single command file references. */
function referencedSkills(command: string): string[] {
  const body = readFileSync(join(commandsDir, `${command}.md`), 'utf-8');
  const dirs = new Set<string>();
  for (const match of body.matchAll(SKILL_REF)) {
    dirs.add(match[1]);
  }
  return [...dirs].sort();
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('canonical-skills map (T1, #1472)', () => {
  it('covers every command file as either a mapped command or command-only', () => {
    for (const command of commandNames) {
      const mapped = command in COMMAND_TO_SKILL;
      const commandOnly = COMMAND_ONLY.has(command);
      expect(
        mapped || commandOnly,
        `command "${command}" is neither in COMMAND_TO_SKILL nor COMMAND_ONLY`,
      ).toBe(true);
      // A command is one or the other, never both.
      expect(
        mapped && commandOnly,
        `command "${command}" appears in BOTH COMMAND_TO_SKILL and COMMAND_ONLY`,
      ).toBe(false);
    }
  });

  it('maps each command to exactly the skills its file references', () => {
    for (const command of commandNames) {
      const actual = referencedSkills(command);
      if (actual.length === 0) {
        // No skill entry-point reference → must be declared command-only.
        expect(
          COMMAND_ONLY.has(command),
          `command "${command}" references no skill but is not in COMMAND_ONLY`,
        ).toBe(true);
        expect(
          command in COMMAND_TO_SKILL,
          `command "${command}" references no skill but appears in COMMAND_TO_SKILL`,
        ).toBe(false);
      } else {
        expect(
          sorted(COMMAND_TO_SKILL[command] ?? []),
          `COMMAND_TO_SKILL["${command}"] drifted from its file's @skills/.../SKILL.md references`,
        ).toEqual(actual);
      }
    }
  });

  it('only contains keys that correspond to a real commands/<key>.md file', () => {
    for (const command of Object.keys(COMMAND_TO_SKILL)) {
      expect(
        existsSync(join(commandsDir, `${command}.md`)),
        `COMMAND_TO_SKILL key "${command}" has no commands/${command}.md file`,
      ).toBe(true);
    }
  });

  it('only declares command-only names that correspond to a real commands/<name>.md file', () => {
    for (const command of COMMAND_ONLY) {
      expect(
        existsSync(join(commandsDir, `${command}.md`)),
        `COMMAND_ONLY entry "${command}" has no commands/${command}.md file`,
      ).toBe(true);
    }
  });

  it('references only skill dirs that exist under skills-src/<dir>/SKILL.md', () => {
    for (const [command, dirs] of Object.entries(COMMAND_TO_SKILL)) {
      for (const dir of dirs) {
        expect(
          existsSync(join(skillsSrcDir, dir, 'SKILL.md')),
          `COMMAND_TO_SKILL["${command}"] points at missing skills-src/${dir}/SKILL.md`,
        ).toBe(true);
      }
    }
  });

  it('CanonicalCommandSet_MatchesCommandsDir', () => {
    // The accessor is the canonical "which /commands exist" surface. It must
    // equal exactly the set of command names derived from commands/*.md at
    // test time — no missing commands, no phantom entries.
    expect(canonicalCommandSet()).toEqual(commandNames);
  });
});
