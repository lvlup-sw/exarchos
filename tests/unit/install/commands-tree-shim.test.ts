/**
 * Guards that each skill-backed command file in `rendered/commands` is a thin shim.
 * A skill-backed command is a key of `COMMAND_TO_SKILL`. Its body holds a short directive
 * that points at the backing skills through `@skills/<dir>/SKILL.md`, and no procedure.
 * The skill source is the only copy of the procedure.
 *
 * Each member of `COMMAND_ONLY` holds its own inline prompt, and the guard does not apply to it.
 * The assertions read the Markdown command files as text.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSkillDir } from '../../../tools/test-helpers/content-tree.js';
import {
  COMMAND_TO_SKILL,
  COMMAND_ONLY,
  canonicalCommandSet,
} from '../../../src/install/config/canonical-skills.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const commandsDir = join(repoRoot, 'rendered', 'commands');
const skillsSrcDir = join(repoRoot, 'content');

/** Matches a skill entry-point reference such as `@skills/discover/SKILL.md`. */
const SKILL_REF = /@skills\/([^/]+)\/SKILL\.md/g;

/**
 * Maximum number of non-blank body lines, after the YAML frontmatter, in a thin shim.
 * A shim holds one directive line, so the limit has a margin and still fails a procedure body.
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

  /**
   * A thin body stays within the line limit and holds no fenced code block.
   * It references exactly the skills that its `COMMAND_TO_SKILL` entry declares.
   */
  it('commandsTree_SkillBackedCommands_NoBodyDuplication', () => {
    for (const command of skillBacked) {
      const body = commandBody(command);
      const lines = nonBlankLines(body);

      expect(
        lines.length,
        `commands/${command}.md body has ${lines.length} non-blank lines ` +
          `(> ${MAX_SHIM_BODY_LINES}); it should be a thin shim — migrate its ` +
          `procedure into content/${command}/SKILL.md.`,
      ).toBeLessThanOrEqual(MAX_SHIM_BODY_LINES);

      expect(
        body.includes('```'),
        `commands/${command}.md carries a fenced code block — thin shims delegate ` +
          `to the skill and must not embed a duplicated procedure.`,
      ).toBe(false);

      expect(
        referencedSkills(body),
        `commands/${command}.md must reference exactly its mapped skill(s) via ` +
          `@skills/<dir>/SKILL.md — nothing more, nothing less.`,
      ).toEqual(sorted(COMMAND_TO_SKILL[command]));
    }
  });

  /**
   * `COMMAND_ONLY` is not empty and shares no member with `COMMAND_TO_SKILL`, so the
   * thin-shim guard never reads these files. Each member has a command file.
   * One member or more must exceed the line limit, which proves that the exemption has an effect.
   */
  it('commandsTree_CommandOnlySurfaces_Exempt', () => {
    expect(COMMAND_ONLY.size).toBeGreaterThan(0);

    let sawFatExemptBody = false;
    for (const command of COMMAND_ONLY) {
      expect(
        existsSync(join(commandsDir, `${command}.md`)),
        `COMMAND_ONLY entry "${command}" has no commands/${command}.md file`,
      ).toBe(true);

      expect(
        command in COMMAND_TO_SKILL,
        `command-only "${command}" must not appear in COMMAND_TO_SKILL`,
      ).toBe(false);

      const lines = nonBlankLines(commandBody(command));
      if (lines.length > MAX_SHIM_BODY_LINES) sawFatExemptBody = true;
    }

    expect(
      sawFatExemptBody,
      'expected at least one command-only surface to carry an inline prompt ' +
        'longer than the shim ceiling (proving exemption is load-bearing)',
    ).toBe(true);
  });

  /**
   * Each canonical verb is skill-backed or command-only, never both, and has a command file.
   * A skill-backed verb references skill sources that exist on disk.
   * A command-only verb references no skill.
   */
  describe('resolves each canonical verb', () => {
    for (const verb of canonicalCommandSet()) {
      it(`resolves /${verb}`, () => {
        const isSkillBacked = verb in COMMAND_TO_SKILL;
        const isCommandOnly = COMMAND_ONLY.has(verb);

        expect(
          isSkillBacked !== isCommandOnly,
          `verb "${verb}" must be exactly one of skill-backed / command-only`,
        ).toBe(true);

        expect(existsSync(join(commandsDir, `${verb}.md`))).toBe(true);

        if (isSkillBacked) {
          const skills = COMMAND_TO_SKILL[verb];
          expect(referencedSkills(commandBody(verb))).toEqual(sorted(skills));
          for (const dir of skills) {
            expect(
              findSkillDir(dir) !== undefined,
              `/${verb} resolves to missing content/${dir}/SKILL.md`,
            ).toBe(true);
          }
        } else {
          expect(referencedSkills(commandBody(verb))).toEqual([]);
        }
      });
    }
  });
});
