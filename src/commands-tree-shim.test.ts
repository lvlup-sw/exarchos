/**
 * DR-3 (harness conform-and-shrink, Task 007) — commands tree thin-shim guard.
 *
 * Every **skill-backed** `commands/<verb>.md` (a key of `COMMAND_TO_SKILL`) must
 * be a *thin shim*: its body carries no duplicated procedure — just a short
 * directive that delegates to the backing skill(s) via `@skills/<dir>/SKILL.md`.
 * The fat procedure bodies were migrated INTO the corresponding
 * `skills-src/<verb>/SKILL.md` sources so the skill is the single source of
 * truth. No command file is deleted this cycle (older-Claude compatibility).
 *
 * **Command-only** surfaces (`autocompact`, `tag` — declared in `COMMAND_ONLY`,
 * absent from `COMMAND_TO_SKILL`) are EXEMPT: they carry their own inline prompt
 * and are never subject to the no-duplication guard, which is scoped to
 * skill-backed commands.
 *
 * These are content-only assertions over the markdown command templates — the
 * command files are consumed by the harness as prompts, not parsed by our TS.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_TO_SKILL,
  COMMAND_ONLY,
  canonicalCommandSet,
} from './config/canonical-skills.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const commandsDir = join(repoRoot, 'commands');
const skillsSrcDir = join(repoRoot, 'skills-src');

/** Matches a skill *entry-point* reference, e.g. `@skills/discover/SKILL.md`. */
const SKILL_REF = /@skills\/([^/]+)\/SKILL\.md/g;

/**
 * A thin shim is allowed at most this many non-blank body lines (after the YAML
 * frontmatter). Real shims are one directive line; every pre-collapse fat body
 * was 30-170 lines, so the ceiling has a wide margin while still going red the
 * moment a duplicated procedure body is reintroduced.
 */
const MAX_SHIM_BODY_LINES = 8;

/** Read a command file and return the body after its YAML frontmatter block. */
function commandBody(command: string): string {
  const raw = readFileSync(join(commandsDir, `${command}.md`), 'utf-8');
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return fm ? raw.slice(fm[0].length) : raw;
}

/** Non-blank, trimmed content lines of a body. */
function nonBlankLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Distinct skill dirs a body references via `@skills/<dir>/SKILL.md`, sorted. */
function referencedSkills(body: string): string[] {
  const dirs = new Set<string>();
  for (const m of body.matchAll(SKILL_REF)) dirs.add(m[1]);
  return [...dirs].sort();
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('commands tree — thin-shim collapse (DR-3, Task 007)', () => {
  const skillBacked = Object.keys(COMMAND_TO_SKILL).sort();

  it('commandsTree_SkillBackedCommands_NoBodyDuplication', () => {
    for (const command of skillBacked) {
      const body = commandBody(command);
      const lines = nonBlankLines(body);

      // 1. Thin: no duplicated procedure body — under the line ceiling and
      //    carrying no fenced code block (the clearest tell of a migrated
      //    procedure). A fat body fails both.
      expect(
        lines.length,
        `commands/${command}.md body has ${lines.length} non-blank lines ` +
          `(> ${MAX_SHIM_BODY_LINES}); it should be a thin shim — migrate its ` +
          `procedure into skills-src/${command}/SKILL.md.`,
      ).toBeLessThanOrEqual(MAX_SHIM_BODY_LINES);

      expect(
        body.includes('```'),
        `commands/${command}.md carries a fenced code block — thin shims delegate ` +
          `to the skill and must not embed a duplicated procedure.`,
      ).toBe(false);

      // 2. Delegates: references EXACTLY the skills its map entry declares, so
      //    the shim still points a resolver at the backing skill(s).
      expect(
        referencedSkills(body),
        `commands/${command}.md must reference exactly its mapped skill(s) via ` +
          `@skills/<dir>/SKILL.md — nothing more, nothing less.`,
      ).toEqual(sorted(COMMAND_TO_SKILL[command]));
    }
  });

  it('commandsTree_CommandOnlySurfaces_Exempt', () => {
    // The command-only set is non-empty and disjoint from the skill-backed map,
    // so the no-duplication guard above never iterates over these surfaces.
    expect(COMMAND_ONLY.size).toBeGreaterThan(0);

    let sawFatExemptBody = false;
    for (const command of COMMAND_ONLY) {
      // Exempt surfaces are real files that carry their own inline prompt.
      expect(
        existsSync(join(commandsDir, `${command}.md`)),
        `COMMAND_ONLY entry "${command}" has no commands/${command}.md file`,
      ).toBe(true);

      // Scoping invariant: a command-only surface is NOT skill-backed, so it is
      // structurally excluded from the thin-shim guard.
      expect(
        command in COMMAND_TO_SKILL,
        `command-only "${command}" must not appear in COMMAND_TO_SKILL`,
      ).toBe(false);

      // Exempt means "allowed to be fat": at least one command-only surface
      // legitimately exceeds the shim ceiling, proving the guard is genuinely
      // scoped rather than trivially satisfied.
      const lines = nonBlankLines(commandBody(command));
      if (lines.length > MAX_SHIM_BODY_LINES) sawFatExemptBody = true;
    }

    expect(
      sawFatExemptBody,
      'expected at least one command-only surface to carry an inline prompt ' +
        'longer than the shim ceiling (proving exemption is load-bearing)',
    ).toBe(true);
  });

  // Trigger-tests: resolve every canonical verb to its backing surface.
  describe('resolves each canonical verb', () => {
    for (const verb of canonicalCommandSet()) {
      it(`resolves /${verb}`, () => {
        const isSkillBacked = verb in COMMAND_TO_SKILL;
        const isCommandOnly = COMMAND_ONLY.has(verb);

        // Every verb resolves to exactly one surface class.
        expect(
          isSkillBacked !== isCommandOnly,
          `verb "${verb}" must be exactly one of skill-backed / command-only`,
        ).toBe(true);

        expect(existsSync(join(commandsDir, `${verb}.md`))).toBe(true);

        if (isSkillBacked) {
          // The shim resolves to on-disk skill sources — the verb is reachable.
          const skills = COMMAND_TO_SKILL[verb];
          expect(referencedSkills(commandBody(verb))).toEqual(sorted(skills));
          for (const dir of skills) {
            expect(
              existsSync(join(skillsSrcDir, dir, 'SKILL.md')),
              `/${verb} resolves to missing skills-src/${dir}/SKILL.md`,
            ).toBe(true);
          }
        } else {
          // Command-only: resolves to its own inline body, not a skill.
          expect(referencedSkills(commandBody(verb))).toEqual([]);
        }
      });
    }
  });
});
