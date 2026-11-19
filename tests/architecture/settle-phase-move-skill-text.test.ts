/**
 * The skill text tells the coordinator to read `phaseMove` of the settle receipt, and to call `transition` only on the fallback.
 * Settlement moves the phase in its commit when exactly one plain edge admits. The skill then calls no `transition`.
 * The skill calls `transition` when `phaseMove` is absent, `stayed` or `not-decided`, and on a `PHASE_LEVEL_FAILED` warning.
 * Each skill text of an implementation-complete edge tells the agent to write `implementation.complete` before the call.
 *
 * Each assertion binds the skill text to a literal pattern. The test reads only the content source.
 * `render:guard` pins `rendered/` to `content/`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const DELEGATE_SKILL = 'content/delivery/skills/delegate/SKILL.md';
const WORKED_EXAMPLE = 'content/delivery/skills/delegate/references/worked-example.md';
const PHASE_TRANSITIONS = 'content/continuity/skills/checkpoint/references/phase-transitions.md';

/** The track texts of the three implementation-complete edges, each with the edge that it names and its target. */
const IMPLEMENTATION_COMPLETE_TRACKS: readonly { readonly file: string; readonly edge: string; readonly target: string }[] = [
  { file: 'content/remediation/skills/debug/references/hotfix-track.md', edge: '`hotfix-implement → hotfix-validate`', target: 'hotfix-validate' },
  { file: 'content/remediation/skills/debug/references/thorough-track.md', edge: '`debug-implement → debug-validate`', target: 'debug-validate' },
  { file: 'content/remediation/skills/refactor/references/polish-track.md', edge: '`polish-implement → polish-validate`', target: 'polish-validate' },
];

/** The rows of the checkpoint table whose guard is `implementation-complete`. */
const IMPLEMENTATION_COMPLETE_ROWS: readonly string[] = [
  '| `debug-implement` | `debug-validate` | `implementation-complete` |',
  '| `hotfix-implement` | `hotfix-validate` | `implementation-complete` |',
  '| `polish-implement` | `polish-validate` | `implementation-complete` |',
];

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** The sentences of a text. A sentence ends at a period that a space or a line end follows. */
function sentencesOf(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=\.)\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The text of the section that starts at a level-two heading, up to the next level-two heading. */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`no section "## ${heading}"`);
  const next = text.indexOf('\n## ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

/** The one line of a text that holds a phrase. A missing or a repeated phrase throws. */
function lineWith(text: string, phrase: string): string {
  const lines = text.split('\n').filter((line) => line.includes(phrase));
  if (lines.length !== 1) throw new Error(`expected one line with ${JSON.stringify(phrase)}, found ${lines.length}`);
  return lines[0] ?? '';
}

describe('the delegate skill reads phaseMove from the settle receipt', () => {
  /** The skill reads `phaseMove` before any `transition` call, and the Transition section reads it before its call. */
  it('SkillText_TheDelegateSkill_ReadsPhaseMoveBeforeAnyTransition', () => {
    const skill = read(DELEGATE_SKILL);
    expect(skill).toMatch(/Read `phaseMove` of the receipt before any `transition` call\./);
    const transition = sectionOf(skill, 'Transition');
    const readAt = transition.indexOf('Read `phaseMove` of the settle receipt');
    const callAt = transition.indexOf('action: "transition"');
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThan(readAt);
    const example = read(WORKED_EXAMPLE);
    const exampleReadAt = example.indexOf('Read `phaseMove` of the receipt first.');
    expect(exampleReadAt).toBeGreaterThanOrEqual(0);
    expect(example.indexOf('action: "transition"')).toBeGreaterThan(exampleReadAt);
  });

  /** The fallback sentence names the absent, `stayed` and `not-decided` cases, and a `moved` receipt takes no call. */
  it('SkillText_TheDelegateSkill_CallsTransitionWhenPhaseMoveIsAbsent', () => {
    const sentences = sentencesOf(read(DELEGATE_SKILL));
    const fallback = sentences.filter(
      (sentence) =>
        sentence.startsWith('Call `transition` when `phaseMove` is') &&
        /\babsent\b/.test(sentence) &&
        sentence.includes('`stayed`') &&
        sentence.includes('`not-decided`'),
    );
    expect(fallback).toHaveLength(1);
    expect(sentences).toContain('Do not call `transition` when `phaseMove` is `moved`.');
  });

  /** A sentence names a `moved` receipt with a `PHASE_LEVEL_FAILED` warning and a `transition` call. */
  it('SkillText_TheDelegateSkill_CallsTransitionOnALevelWarning', () => {
    const sentences = sentencesOf(read(DELEGATE_SKILL));
    const level = sentences.filter(
      (sentence) =>
        sentence.includes('`moved`') && sentence.includes('`PHASE_LEVEL_FAILED`') && sentence.includes('call `transition`'),
    );
    expect(level).toHaveLength(1);
  });

  /** On `stayed`, the skill fixes the false facts of `phaseMove.edges` first, and checks the tasks before the call. */
  it('SkillText_TheDelegateSkill_OnStayedFixesTheFalseFactsFirst', () => {
    const skill = read(DELEGATE_SKILL);
    const stayed = sentencesOf(skill).filter(
      (sentence) => sentence.startsWith('On `stayed`') && sentence.includes('`phaseMove.edges`') && sentence.includes('false facts'),
    );
    expect(stayed).toHaveLength(1);
    const paragraph = lineWith(skill, stayed[0] ?? '');
    const factsAt = paragraph.indexOf('false facts');
    const tasksAt = paragraph.indexOf('check that each task is complete');
    const callAt = paragraph.indexOf('call `transition`');
    expect(tasksAt).toBeGreaterThan(factsAt);
    expect(callAt).toBeGreaterThan(tasksAt);
    const transition = sectionOf(skill, 'Transition');
    const stayedStepAt = transition.indexOf('On `stayed`, fix each false fact of `phaseMove.edges`');
    const checkStepAt = transition.indexOf('Verify all `tasks[].status === "complete"`');
    const callStepAt = transition.indexOf('action: "transition"');
    expect(stayedStepAt).toBeGreaterThanOrEqual(0);
    expect(checkStepAt).toBeGreaterThan(stayedStepAt);
    expect(callStepAt).toBeGreaterThan(checkStepAt);
  });

  /** The coordinator lands each worktree and runs the integration suite after the move, before the review. */
  it('SkillText_TheDelegateSkill_LandsAfterTheMoveAndBeforeTheReview', () => {
    const skill = read(DELEGATE_SKILL);
    const example = read(WORKED_EXAMPLE);
    const rule = /Land each worktree and run the integration suite after the move, before the review/;
    expect(skill).toMatch(rule);
    expect(example).toMatch(rule);
    expect(skill).not.toMatch(/auto-transitions through `feature\/merge-pending`/);
    expect(example).not.toMatch(/the merge-pending detour/);
    const step4 = sectionOf(skill, 'Step 4: Land and Transition');
    const landAt = step4.indexOf('**Land each worktree.**');
    const suiteAt = step4.indexOf('action: "check_integration_suite"');
    expect(landAt).toBeGreaterThanOrEqual(0);
    expect(suiteAt).toBeGreaterThan(landAt);
  });
});

describe('each skill text of an implementation-complete edge names the field', () => {
  /** Each track writes `implementation.complete: true` with `update` before it calls `transition`, and the table names the field. */
  it('SkillText_EachImplementationCompleteEdge_NamesTheField', () => {
    for (const track of IMPLEMENTATION_COMPLETE_TRACKS) {
      const paragraph = lineWith(read(track.file), `${track.edge} guard requirements`);
      const writeAt = paragraph.indexOf('write `implementation.complete: true` with `update`');
      const callAt = paragraph.indexOf(`call \`transition\` with \`target: "${track.target}"\``);
      expect(writeAt, track.file).toBeGreaterThanOrEqual(0);
      expect(callAt, track.file).toBeGreaterThan(writeAt);
    }
    const table = read(PHASE_TRANSITIONS);
    for (const row of IMPLEMENTATION_COMPLETE_ROWS) {
      expect(lineWith(table, row)).toBe(`${row} Set \`implementation.complete = true\` |`);
    }
    expect(table).not.toMatch(/`implementation-complete` \| Always passes \|/);
  });
});
