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
import { PHASE_EVENT_CONTRACTS } from '../../src/workflow/topology/phase-events.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface ProseSite {
  /** Content-source path of the skill, repo-relative. */
  readonly skill: string;
  /** The `PHASE_EXPECTED_EVENTS` key the prose speaks for. */
  readonly phase: string;
  /**
   * `line`: one "Checked by …" sentence naming the types. `table`: the
   * delegate skill's event-contract table, one `| \`type\` | when | emitter |`
   * row per expected type, whose emitter column is compared too.
   */
  readonly shape: 'line' | 'table';
}

/** Every skill passage that claims to name what the gate checks. */
const SITES: readonly ProseSite[] = [
  { skill: 'content/synthesis/skills/synthesize/SKILL.md', phase: 'synthesize', shape: 'line' },
  { skill: 'content/delivery/skills/delegate/SKILL.md', phase: 'delegate', shape: 'table' },
];

/** The one shape the sentence may take — the whole line, so the list ends where the line does. */
const CHECKED_LINE = /^Checked by `check-event-emissions` in this phase: (.*)$/;

const BACKTICKED_EVENT = /`([a-z][a-z0-9_.]*)`/g;

/** A type the prose names, and (for the table shape) who it says emits it. */
interface NamedType {
  readonly type: string;
  readonly emitter?: 'orchestrator' | 'subagent';
}

/** What the skill's checked line names, or why there is no answer. */
function checkedTypesInLine(
  markdown: string,
): { readonly types: readonly NamedType[] } | { readonly problem: string } {
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
  const types = [...(lines[0]?.[1] ?? '').matchAll(BACKTICKED_EVENT)].map((match) => ({
    type: match[1] ?? '',
  }));
  if (types.length === 0) return { problem: 'the checked line names no backticked event type' };
  return { types };
}

/** One row of the delegate skill's contract table: the type, its when, its emitter. */
const TABLE_ROW = /^\| `([a-z][a-z0-9_.]*)` \| .+ \| (Orchestrator|Subagent) \|$/;

/** What the skill's contract table names, or why there is no answer. */
function checkedTypesInTable(
  markdown: string,
): { readonly types: readonly NamedType[] } | { readonly problem: string } {
  const heading = markdown.indexOf('(checked by `check-event-emissions`)');
  if (heading < 0) return { problem: 'no passage says it is checked by `check-event-emissions`' };
  const rows = markdown
    .slice(heading)
    .split('\n')
    .map((line) => TABLE_ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  if (rows.length === 0) return { problem: 'the checked passage has no `| \`type\` | … | emitter |` rows' };
  return {
    types: rows.map((match) => ({
      type: match[1] ?? '',
      emitter: match[2] === 'Subagent' ? ('subagent' as const) : ('orchestrator' as const),
    })),
  };
}

function checkedTypesIn(
  markdown: string,
  shape: ProseSite['shape'],
): { readonly types: readonly NamedType[] } | { readonly problem: string } {
  return shape === 'line' ? checkedTypesInLine(markdown) : checkedTypesInTable(markdown);
}

/**
 * Pure comparator, so the live sites and a seeded disagreement go through the
 * same judge. Both directions are named: prose that over-claims and prose that
 * under-claims are different defects.
 */
function disagreements(
  markdown: string,
  phase: string,
  shape: ProseSite['shape'],
): readonly string[] {
  const read = checkedTypesIn(markdown, shape);
  if ('problem' in read) return [read.problem];
  const rows = PHASE_EVENT_CONTRACTS[phase]?.expects ?? [];
  const named = new Map(read.types.map((named) => [named.type, named]));
  const row = new Map(rows.map((r) => [r.type as string, r]));
  return [
    ...[...named.keys()]
      .filter((type) => !row.has(type))
      .map((type) => `prose names ${type}, which the gate row does not expect`),
    ...[...row.keys()]
      .filter((type) => !named.has(type))
      .map((type) => `gate row expects ${type}, which the prose does not name`),
    ...[...named.values()]
      .filter((n) => n.emitter !== undefined && row.has(n.type))
      .filter((n) => n.emitter !== (row.get(n.type)?.emitter ?? 'orchestrator'))
      .map((n) => `prose says ${n.type} is emitted by the ${n.emitter}, the contract says otherwise`),
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
      expect(PHASE_EXPECTED_EVENTS[site.phase]?.length, `${site.phase} expects nothing`).toBeGreaterThan(0);
      expect(disagreements(markdown, site.phase, site.shape), site.skill).toEqual([]);
    }
  });

  it('SkillProse_SeededDisagreement_IsNamedInBothDirectionsAndOnAMissingLine', () => {
    const [site] = SITES;
    expect(site).toBeDefined();
    if (site === undefined) return;
    const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');

    // Prose names a type the row does not expect — the shape the flip removed.
    const overClaiming = markdown.replace(
      /^(Checked by `check-event-emissions` in this phase: .*)\.$/m,
      '$1, `stack.submitted`.',
    );
    expect(overClaiming).not.toBe(markdown);
    expect(disagreements(overClaiming, site.phase, site.shape)).toEqual([
      'prose names stack.submitted, which the gate row does not expect',
    ]);

    // The row expects a type the prose does not name.
    const underClaiming = markdown.replace(
      /^(Checked by `check-event-emissions` in this phase: .*), `shepherd\.iteration`\.$/m,
      '$1.',
    );
    expect(underClaiming).not.toBe(markdown);
    expect(disagreements(underClaiming, site.phase, site.shape)).toEqual([
      'gate row expects shepherd.iteration, which the prose does not name',
    ]);

    // No checked line at all is a named problem, never a pass over an empty set.
    const silent = markdown
      .split('\n')
      .filter((line) => !CHECKED_LINE.test(line))
      .join('\n');
    const findings = disagreements(silent, site.phase, site.shape);
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('found 0');
  });

  it('SkillProse_SeededTableDisagreement_NamesTheRowAndTheEmitter', () => {
    const site = SITES.find((s) => s.shape === 'table');
    expect(site).toBeDefined();
    if (site === undefined) return;
    const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
    expect(disagreements(markdown, site.phase, site.shape)).toEqual([]);
    // The table says the orchestrator emits a row the contract gives the subagent.
    const wrongEmitter = markdown.replace(/^(\| `task\.progressed` \| .+ \|) Subagent \|$/m, '$1 Orchestrator |');
    expect(wrongEmitter).not.toBe(markdown);
    expect(disagreements(wrongEmitter, site.phase, site.shape)).toEqual([
      'prose says task.progressed is emitted by the orchestrator, the contract says otherwise',
    ]);
    // A row the table drops is named, not silently absent.
    const dropped = markdown.replace(/^\| `team\.disbanded` \| .+ \|\n/m, '');
    expect(dropped).not.toBe(markdown);
    expect(disagreements(dropped, site.phase, site.shape)).toEqual([
      'gate row expects team.disbanded, which the prose does not name',
    ]);
    // No table at all is a named problem, never a pass over an empty set.
    const silent = markdown.replace('(checked by `check-event-emissions`)', '');
    expect(disagreements(silent, site.phase, site.shape)).toEqual([
      'no passage says it is checked by `check-event-emissions`',
    ]);
  });
});
