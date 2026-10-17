/**
 * The "checked by `check-event-emissions`" passage of a skill names exactly the
 * expectation row of the gate for its phase. The outcome table of the delegate skill names each
 * settlement outcome, which outcomes verify, and the next call of each, as the outcome rules state.
 *
 * @oracle-sources: ../../src/verbs/gates/check-event-emissions.ts, ../../content/synthesis/skills/synthesize/SKILL.md, ../../src/verbs/settle/adjudicate.ts
 *
 * The model reads the prose, and the code checks the row. No generator joins them: the skills
 * renderer is in `src/install`, which must not import `src/verbs`. Each passage has a
 * machine-readable shape, a line or a table. This test reads the passage and compares it with the
 * code table. It fails when the prose and the code disagree.
 *
 * The test reads only the content source. `render:guard` pins `rendered/` to `content/`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PHASE_EXPECTED_EVENTS } from '../../src/verbs/gates/check-event-emissions.js';
import { SETTLEMENT_OUTCOME_RULES, SETTLEMENT_OUTCOMES } from '../../src/verbs/settle/adjudicate.js';
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
   * `outcome-table`: the delegate skill's outcome table, one row per settlement outcome, compared with the outcome rules.
   */
  readonly shape: 'line' | 'table' | 'outcome-table';
}

/** Every skill passage that claims to name what the gate checks. */
const SITES: readonly ProseSite[] = [
  { skill: 'content/synthesis/skills/synthesize/SKILL.md', phase: 'synthesize', shape: 'line' },
  { skill: 'content/delivery/skills/delegate/SKILL.md', phase: 'delegate', shape: 'table' },
  { skill: 'content/delivery/skills/delegate/SKILL.md', phase: 'delegate', shape: 'outcome-table' },
];

/**
 * The only shape of the sentence. The pattern matches the whole line, so the list ends where
 * the line ends.
 */
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
  shape: 'line' | 'table',
): { readonly types: readonly NamedType[] } | { readonly problem: string } {
  return shape === 'line' ? checkedTypesInLine(markdown) : checkedTypesInTable(markdown);
}

/** The heading row of the outcome table. The rows under it name one outcome each. */
const OUTCOME_TABLE_HEADING = '| Outcome | What settlement verified | Next call |';

/** One row of the outcome table: the outcome, what settlement verified, and the next call. */
const OUTCOME_ROW = /^\| `([a-z][a-z-]*)` \| ([^|]+) \| ([^|]+) \|$/;

/** The next call of an outcome rule as a cell of the table: the rule text, with a capital first letter. */
function nextCallCell(next: string): string {
  return `${next.charAt(0).toUpperCase()}${next.slice(1)}`;
}

/**
 * How the outcome table disagrees with the outcome rules. The table names each outcome once.
 * The verified cell is `Nothing` exactly for an outcome that verifies nothing. The next-call cell is the next call of the rule.
 */
function outcomeTableDisagreements(markdown: string): readonly string[] {
  const lines = markdown.split('\n');
  const heading = lines.indexOf(OUTCOME_TABLE_HEADING);
  if (heading < 0) return ['no outcome table'];
  const rows: RegExpExecArray[] = [];
  for (const line of lines.slice(heading + 2)) {
    const row = OUTCOME_ROW.exec(line);
    if (row === null) break;
    rows.push(row);
  }
  const named = rows.map((row) => row[1] ?? '');
  const problems: string[] = [
    ...SETTLEMENT_OUTCOMES.filter((outcome) => !named.includes(outcome)).map(
      (outcome) => `the outcome table does not name ${outcome}`,
    ),
    ...named
      .filter((outcome) => !SETTLEMENT_OUTCOMES.some((known) => known === outcome))
      .map((outcome) => `the outcome table names ${outcome}, which is not an outcome`),
    ...named
      .filter((outcome, i) => named.indexOf(outcome) !== i)
      .map((outcome) => `the outcome table names ${outcome} more than once`),
  ];
  for (const [, outcome = '', verified = '', next = ''] of rows) {
    const rule = SETTLEMENT_OUTCOMES.find((known) => known === outcome);
    if (rule === undefined) continue;
    const { verifies, next: ruleNext } = SETTLEMENT_OUTCOME_RULES[rule];
    if ((verified === 'Nothing') === verifies) {
      problems.push(`the outcome table says ${outcome} verified "${verified}", and the rule says verifies=${String(verifies)}`);
    }
    if (next !== nextCallCell(ruleNext)) {
      problems.push(`the outcome table gives ${outcome} the next call "${next}", and the rule gives "${nextCallCell(ruleNext)}"`);
    }
  }
  return problems.sort();
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
  if (shape === 'outcome-table') return outcomeTableDisagreements(markdown);
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

  /**
   * The first site has the `line` shape. The test seeds three defects: an extra type in the
   * prose, a missing type in the prose, and no checked line. A missing line must give a named
   * problem, not a pass on an empty set.
   */
  it('SkillProse_SeededDisagreement_IsNamedInBothDirectionsAndOnAMissingLine', () => {
    const [site] = SITES;
    expect(site).toBeDefined();
    if (site === undefined) return;
    const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');

    const overClaiming = markdown.replace(
      /^(Checked by `check-event-emissions` in this phase: .*)\.$/m,
      '$1, `stack.submitted`.',
    );
    expect(overClaiming).not.toBe(markdown);
    expect(disagreements(overClaiming, site.phase, site.shape)).toEqual([
      'prose names stack.submitted, which the gate row does not expect',
    ]);

    const underClaiming = markdown.replace(
      /^(Checked by `check-event-emissions` in this phase: .*), `shepherd\.iteration`\.$/m,
      '$1.',
    );
    expect(underClaiming).not.toBe(markdown);
    expect(disagreements(underClaiming, site.phase, site.shape)).toEqual([
      'gate row expects shepherd.iteration, which the prose does not name',
    ]);

    const silent = markdown
      .split('\n')
      .filter((line) => !CHECKED_LINE.test(line))
      .join('\n');
    const findings = disagreements(silent, site.phase, site.shape);
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('found 0');
  });

  /**
   * The test seeds three defects in the table: a wrong emitter, a dropped row, and no checked
   * passage. A missing passage must give a named problem, not a pass on an empty set.
   */
  it('SkillProse_SeededTableDisagreement_NamesTheRowAndTheEmitter', () => {
    const site = SITES.find((s) => s.shape === 'table');
    expect(site).toBeDefined();
    if (site === undefined) return;
    const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
    expect(disagreements(markdown, site.phase, site.shape)).toEqual([]);
    const wrongEmitter = markdown.replace(/^(\| `task\.progressed` \| .+ \|) Subagent \|$/m, '$1 Orchestrator |');
    expect(wrongEmitter).not.toBe(markdown);
    expect(disagreements(wrongEmitter, site.phase, site.shape)).toEqual([
      'prose says task.progressed is emitted by the orchestrator, the contract says otherwise',
    ]);
    const dropped = markdown.replace(/^\| `team\.disbanded` \| .+ \|\n/m, '');
    expect(dropped).not.toBe(markdown);
    expect(disagreements(dropped, site.phase, site.shape)).toEqual([
      'gate row expects team.disbanded, which the prose does not name',
    ]);
    const silent = markdown.replace('(checked by `check-event-emissions`)', '');
    expect(disagreements(silent, site.phase, site.shape)).toEqual([
      'no passage says it is checked by `check-event-emissions`',
    ]);
  });

  /**
   * The test seeds four defects in the outcome table. They are a changed next call, a wrong
   * verified cell, a dropped row, and no table. Each one is named.
   */
  it('SkillProse_SeededOutcomeTableDisagreement_NamesTheOutcome', () => {
    const site = SITES.find((s) => s.shape === 'outcome-table');
    expect(site).toBeDefined();
    if (site === undefined) return;
    const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
    expect(disagreements(markdown, site.phase, site.shape)).toEqual([]);

    const wrongCall = markdown.replace(
      /^(\| `rejected` \| Nothing \|) Settle the correction under a new batchId \|$/m,
      '$1 Prepare, then settle under the new capsule |',
    );
    expect(wrongCall).not.toBe(markdown);
    expect(disagreements(wrongCall, site.phase, site.shape)).toEqual([
      'the outcome table gives rejected the next call "Prepare, then settle under the new capsule", and the rule gives "Settle the correction under a new batchId"',
    ]);

    const wrongVerified = markdown.replace(/^(\| `settled` \|) Each required task is complete (\|)/m, '$1 Nothing $2');
    expect(wrongVerified).not.toBe(markdown);
    expect(disagreements(wrongVerified, site.phase, site.shape)).toEqual([
      'the outcome table says settled verified "Nothing", and the rule says verifies=true',
    ]);

    const dropped = markdown.replace(/^\| `deviation-pending` \| .+ \|\n/m, '');
    expect(dropped).not.toBe(markdown);
    expect(disagreements(dropped, site.phase, site.shape)).toEqual(['the outcome table does not name deviation-pending']);

    const silent = markdown.replace(OUTCOME_TABLE_HEADING, '| Outcome | Next call |');
    expect(disagreements(silent, site.phase, site.shape)).toEqual(['no outcome table']);
  });
});
