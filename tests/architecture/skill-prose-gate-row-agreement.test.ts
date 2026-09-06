/**
 * A skill's "checked by `check-event-emissions`" sentence names exactly the
 * gate's expectation row for its phase.
 *
 * @oracle-sources: ../../src/verbs/gates/check-event-emissions.ts, ../../content/synthesis/skills/synthesize/SKILL.md
 *
 * The prose is what the model reads; the row is what the gate checks. Nothing
 * generates one from the other — the skills renderer lives in `src/install`,
 * which may not import `src/verbs`, so a generator needs an intermediate this
 * change does not add. Until it exists the two are joined HERE: the sentence is
 * written in one machine-readable shape, on a line of its own, and this test
 * reads it back and compares the set. The first event-authority flip
 * hand-synchronised sentence and row in one commit; this is what notices the
 * second flip forgetting to.
 *
 * Only the content source is read. `render:guard` pins `rendered/` to
 * `content/`, so the source is the one place the sentence is authored.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PHASE_EXPECTED_EVENTS } from '../../src/verbs/gates/check-event-emissions.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface ProseSite {
  /** Content-source path of the skill, repo-relative. */
  readonly skill: string;
  /** The `PHASE_EXPECTED_EVENTS` key the sentence speaks for. */
  readonly phase: string;
}

/**
 * Every skill sentence that claims to name what the gate checks. One row
 * today. The delegate skill's "checked by" table has the same claim in a
 * different shape and does not agree with its derived row (it omits
 * `team.disbanded` and `task.progressed`); it is recorded as residue rather
 * than pinned here to a shape it does not yet have.
 */
const SITES: readonly ProseSite[] = [
  { skill: 'content/synthesis/skills/synthesize/SKILL.md', phase: 'synthesize' },
];

/** The one shape the sentence may take — the whole line, so the list ends where the line does. */
const CHECKED_LINE = /^Checked by `check-event-emissions` in this phase: (.*)$/;

const BACKTICKED_EVENT = /`([a-z][a-z0-9_.]*)`/g;

/** What the skill's checked line names, or why there is no answer. */
function checkedTypesIn(
  markdown: string,
): { readonly types: readonly string[] } | { readonly problem: string } {
  const lines = markdown
    .split('\n')
    .map((line) => CHECKED_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  if (lines.length !== 1) {
    return {
      problem:
        'expected exactly one "Checked by `check-event-emissions` in this phase:" line, ' +
        `found ${lines.length}`,
    };
  }
  const types = [...(lines[0]?.[1] ?? '').matchAll(BACKTICKED_EVENT)].map((match) => match[1] ?? '');
  if (types.length === 0) return { problem: 'the checked line names no backticked event type' };
  return { types };
}

/**
 * Pure comparator, so the live sites and a seeded disagreement go through the
 * same judge. Both directions are named: prose that over-claims and prose that
 * under-claims are different defects.
 */
function disagreements(markdown: string, expected: readonly string[]): readonly string[] {
  const read = checkedTypesIn(markdown);
  if ('problem' in read) return [read.problem];
  const named = new Set(read.types);
  const row = new Set(expected);
  return [
    ...[...named]
      .filter((type) => !row.has(type))
      .map((type) => `prose names ${type}, which the gate row does not expect`),
    ...[...row]
      .filter((type) => !named.has(type))
      .map((type) => `gate row expects ${type}, which the prose does not name`),
  ].sort();
}

describe('SkillProse — the checked-by sentence names the gate row', () => {
  it('SkillProse_EverySite_HasAnExpectationRowAndAContentFile', () => {
    expect(SITES.length).toBeGreaterThan(0);
    for (const site of SITES) {
      expect(PHASE_EXPECTED_EVENTS[site.phase], `${site.phase} has no expectation row`).toBeDefined();
      expect(() => readFileSync(join(REPO_ROOT, site.skill), 'utf8'), site.skill).not.toThrow();
    }
  });

  it('SkillProse_CheckedLine_NamesExactlyTheGateRow', () => {
    for (const site of SITES) {
      const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
      const expected = PHASE_EXPECTED_EVENTS[site.phase] ?? [];
      expect(expected.length, `${site.phase} expects nothing`).toBeGreaterThan(0);
      expect(disagreements(markdown, expected), site.skill).toEqual([]);
    }
  });

  it('SkillProse_SeededDisagreement_IsNamedInBothDirectionsAndOnAMissingLine', () => {
    const [site] = SITES;
    expect(site).toBeDefined();
    if (site === undefined) return;
    const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
    const expected = PHASE_EXPECTED_EVENTS[site.phase] ?? [];

    // Prose names a type the row does not expect — the shape the flip removed.
    const overClaiming = markdown.replace(
      /^(Checked by `check-event-emissions` in this phase: .*)\.$/m,
      '$1, `stack.submitted`.',
    );
    expect(overClaiming).not.toBe(markdown);
    expect(disagreements(overClaiming, expected)).toEqual([
      'prose names stack.submitted, which the gate row does not expect',
    ]);

    // The row expects a type the prose does not name.
    expect(disagreements(markdown, [...expected, 'seeded.expected'])).toEqual([
      'gate row expects seeded.expected, which the prose does not name',
    ]);

    // No checked line at all is a named problem, never a pass over an empty set.
    const silent = markdown
      .split('\n')
      .filter((line) => !CHECKED_LINE.test(line))
      .join('\n');
    const findings = disagreements(silent, expected);
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('found 0');
  });
});
