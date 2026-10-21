/**
 * The "checked by `check-event-emissions`" passage of a skill names exactly the
 * expectation row of the gate for its phase. The outcome table of the delegate skill names each
 * settlement outcome, which outcomes verify, and the next call of each, as the outcome rules state.
 * Each passage that binds the template variables of a completion runbook binds each variable of its static-analysis step.
 * Each passage of `content/` that gives a call of the kill probe has a site, and binds the task tree as the probe step does.
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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TASK_COMPLETION, TASK_FIX } from '../../src/runbooks/definitions.js';
import type { RunbookDefinition } from '../../src/runbooks/types.js';
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
   * `runbook-binding`: the one line that tells the reader to bind the template variables of `check_static_analysis`,
   * compared with the static-analysis step of `runbook`.
   * `probe-call`: the one passage that tells the reader to run `check_test_adequacy`, compared with the tree binding of
   * the probe step of `runbook`.
   */
  readonly shape: 'line' | 'table' | 'outcome-table' | 'runbook-binding' | 'probe-call';
  /** The completion runbook whose gate step a `runbook-binding` or a `probe-call` passage binds. */
  readonly runbook?: RunbookDefinition;
}

/** Every skill passage that claims to name what the gate checks, or how to bind a gate of a completion runbook. */
const SITES: readonly ProseSite[] = [
  { skill: 'content/synthesis/skills/synthesize/SKILL.md', phase: 'synthesize', shape: 'line' },
  { skill: 'content/delivery/skills/delegate/SKILL.md', phase: 'delegate', shape: 'table' },
  { skill: 'content/delivery/skills/delegate/SKILL.md', phase: 'delegate', shape: 'outcome-table' },
  { skill: 'content/delivery/skills/delegate/SKILL.md', phase: 'delegate', shape: 'runbook-binding', runbook: TASK_COMPLETION },
  {
    skill: 'content/delivery/skills/delegate/references/fix-mode.md',
    phase: 'delegate',
    shape: 'runbook-binding',
    runbook: TASK_FIX,
  },
  { skill: 'content/review/skills/review/SKILL.md', phase: 'review', shape: 'probe-call', runbook: TASK_COMPLETION },
  {
    skill: 'content/review/skills/review/references/spec-compliance-checklist.md',
    phase: 'review',
    shape: 'probe-call',
    runbook: TASK_COMPLETION,
  },
  { skill: 'content/design/skills/plan/SKILL.md', phase: 'delegate', shape: 'probe-call', runbook: TASK_COMPLETION },
];

/** The root of the content source that the census of probe-call passages reads. */
const CONTENT_ROOT = 'content';

/**
 * How the probe-call sites disagree with the content files. A file with a call of the kill probe needs a site.
 * A site needs a file with a call. The census reads each file with the passage reader of the judge.
 */
function probeCallCensus(files: ReadonlyMap<string, string>, listed: readonly string[]): readonly string[] {
  const calling = [...files]
    .filter(([, markdown]) => probeCallPassages(markdown).length > 0)
    .map(([file]) => file);
  return [
    ...calling
      .filter((file) => !listed.includes(file))
      .map((file) => `${file} calls check_test_adequacy, and no probe-call site lists it`),
    ...listed
      .filter((file) => !calling.includes(file))
      .map((file) => `${file} is a probe-call site and holds no call of check_test_adequacy`),
  ];
}

/** The repo-relative paths of the Markdown files under a repo-relative directory, sorted. */
function markdownFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...markdownFilesUnder(relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(relative);
  }
  return found.sort();
}

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

/** A step param value that is a template variable, for example `<worktreePath>`. */
const TEMPLATE_VARIABLE = /^<[A-Za-z]+>$/;

/** The template variables of the static-analysis step of a runbook, in step order. */
function staticAnalysisStepVariables(runbook: RunbookDefinition): readonly string[] {
  const step = runbook.steps.find((candidate) => candidate.action === 'check_static_analysis');
  return Object.values(step?.params ?? {}).filter(
    (value): value is string => typeof value === 'string' && TEMPLATE_VARIABLE.test(value),
  );
}

/**
 * How the binding passage disagrees with the static-analysis step of its runbook. The passage is the one line that names
 * `check_static_analysis` and tells the reader to bind. It must name each template variable of the step in backticks.
 */
function runbookBindingDisagreements(markdown: string, runbook: RunbookDefinition | undefined): readonly string[] {
  if (runbook === undefined) return ['the site names no runbook'];
  const variables = staticAnalysisStepVariables(runbook);
  if (variables.length === 0) return [`the check_static_analysis step of ${runbook.id} binds no template variable`];
  const passages = markdown.split('\n').filter((line) => line.includes('`check_static_analysis`') && /\bBind\b/.test(line));
  if (passages.length !== 1) {
    return [`expected exactly one line that binds the variables of \`check_static_analysis\`, found ${passages.length}`];
  }
  const passage = passages[0] ?? '';
  return variables
    .filter((variable) => !passage.includes(`\`${variable}\``))
    .map((variable) => `the passage does not bind \`${variable}\`, which the check_static_analysis step of ${runbook.id} binds`);
}

/** The two params that `resolveRepoRoot` reads to run a gate in the task worktree. */
const TREE_BINDING_KEYS: readonly ['repoRoot', 'worktreePath'] = ['repoRoot', 'worktreePath'];

/** A prose line that tells the reader to run the kill probe. */
const PROBE_CALL_LINE = /^Run `check_test_adequacy`/;

/** A line that opens or closes a fenced block. */
const FENCE = /^\s*```/;

/**
 * The passages that call the kill probe. A passage is a fenced block that holds a `check_test_adequacy` call, or a
 * prose line outside a block that tells the reader to run `check_test_adequacy`.
 */
function probeCallPassages(markdown: string): readonly string[] {
  const passages: string[] = [];
  let block: string[] | undefined;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      if (block === undefined) {
        block = [];
        continue;
      }
      const text = block.join('\n');
      if (text.includes('action: "check_test_adequacy"')) passages.push(text);
      block = undefined;
      continue;
    }
    if (block !== undefined) block.push(line);
    else if (PROBE_CALL_LINE.test(line)) passages.push(line);
  }
  return passages;
}

/**
 * How the probe-call passage disagrees with the probe step of its runbook. The passage must pass each tree-binding
 * param with the value that the step binds. Then the probe reverts the task tree and not the directory of the server.
 */
function probeCallDisagreements(markdown: string, runbook: RunbookDefinition | undefined): readonly string[] {
  if (runbook === undefined) return ['the site names no runbook'];
  const step = runbook.steps.find((candidate) => candidate.action === 'check_test_adequacy');
  const bindings = TREE_BINDING_KEYS.map((key) => ({ key, value: step?.params?.[key] }));
  const missing = bindings.filter(({ value }) => typeof value !== 'string');
  if (missing.length > 0) {
    return missing.map(({ key }) => `the check_test_adequacy step of ${runbook.id} binds no ${key}`);
  }
  const passages = probeCallPassages(markdown);
  if (passages.length !== 1) {
    return [`expected exactly one passage that calls \`check_test_adequacy\`, found ${passages.length}`];
  }
  const passage = passages[0] ?? '';
  return bindings
    .map(({ key, value }) => `${key}: "${String(value)}"`)
    .filter((binding) => !passage.includes(binding))
    .map((binding) => `the passage does not pass \`${binding}\`, which the check_test_adequacy step of ${runbook.id} binds`);
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
  runbook?: RunbookDefinition,
): readonly string[] {
  if (shape === 'outcome-table') return outcomeTableDisagreements(markdown);
  if (shape === 'runbook-binding') return runbookBindingDisagreements(markdown, runbook);
  if (shape === 'probe-call') return probeCallDisagreements(markdown, runbook);
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
      expect(disagreements(markdown, site.phase, site.shape, site.runbook), site.skill).toEqual([]);
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

  /**
   * Each binding passage gets two seeded defects. One drops the worktree variable, and one drops the passage.
   * The judge names each one, so a passage that stops binding the worktree turns this test red.
   */
  it('SkillProse_SeededBindingDisagreement_NamesTheUnboundVariable', () => {
    const sites = SITES.filter((s) => s.shape === 'runbook-binding');
    expect(sites.map((s) => s.skill)).toEqual([
      'content/delivery/skills/delegate/SKILL.md',
      'content/delivery/skills/delegate/references/fix-mode.md',
    ]);
    for (const site of sites) {
      expect(site.runbook, site.skill).toBeDefined();
      if (site.runbook === undefined) continue;
      expect(staticAnalysisStepVariables(site.runbook), site.skill).toEqual(['<worktreePath>', '<taskId>']);
      const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
      expect(disagreements(markdown, site.phase, site.shape, site.runbook), site.skill).toEqual([]);

      const unbound = markdown.replace(' and `<worktreePath>` to the', ' to the');
      expect(unbound, site.skill).not.toBe(markdown);
      expect(disagreements(unbound, site.phase, site.shape, site.runbook), site.skill).toEqual([
        `the passage does not bind \`<worktreePath>\`, which the check_static_analysis step of ${site.runbook.id} binds`,
      ]);

      const silent = markdown
        .split('\n')
        .filter((line) => !(line.includes('`check_static_analysis`') && /\bBind\b/.test(line)))
        .join('\n');
      expect(disagreements(silent, site.phase, site.shape, site.runbook), site.skill).toEqual([
        'expected exactly one line that binds the variables of `check_static_analysis`, found 0',
      ]);
    }
  });

  /**
   * Each probe-call passage gets three seeded defects. One runs the probe in the directory of the server, one renames
   * the worktree field, and one drops the passage. The judge names each one, so a passage that stops binding the task
   * tree turns this test red.
   */
  it('SkillProse_SeededProbeCallDisagreement_NamesTheUnboundField', () => {
    const sites = SITES.filter((s) => s.shape === 'probe-call');
    expect(sites.map((s) => s.skill)).toEqual([
      'content/review/skills/review/SKILL.md',
      'content/review/skills/review/references/spec-compliance-checklist.md',
      'content/design/skills/plan/SKILL.md',
    ]);
    for (const site of sites) {
      expect(site.runbook, site.skill).toBeDefined();
      if (site.runbook === undefined) continue;
      const markdown = readFileSync(join(REPO_ROOT, site.skill), 'utf8');
      expect(disagreements(markdown, site.phase, site.shape, site.runbook), site.skill).toEqual([]);

      const serverDirectory = markdown.replaceAll('repoRoot: "auto"', 'repoRoot: "."');
      expect(serverDirectory, site.skill).not.toBe(markdown);
      expect(disagreements(serverDirectory, site.phase, site.shape, site.runbook), site.skill).toEqual([
        `the passage does not pass \`repoRoot: "auto"\`, which the check_test_adequacy step of ${site.runbook.id} binds`,
      ]);

      const renamed = markdown.replaceAll('worktreePath: "<worktreePath>"', 'path: "<worktreePath>"');
      expect(renamed, site.skill).not.toBe(markdown);
      expect(disagreements(renamed, site.phase, site.shape, site.runbook), site.skill).toEqual([
        `the passage does not pass \`worktreePath: "<worktreePath>"\`, which the check_test_adequacy step of ${site.runbook.id} binds`,
      ]);

      const silent = markdown
        .replace('action: "check_test_adequacy"', 'action: "check_static_analysis"')
        .replace(/^Run `check_test_adequacy`/m, 'Run the probe');
      expect(silent, site.skill).not.toBe(markdown);
      expect(disagreements(silent, site.phase, site.shape, site.runbook), site.skill).toEqual([
        'expected exactly one passage that calls `check_test_adequacy`, found 0',
      ]);
    }
  });

  /**
   * The census reads each Markdown file of `content/` with the passage reader of the judge.
   * Each file that holds a call of the kill probe must have a probe-call site, so no such passage escapes the judge.
   * A seeded file with an unlisted call and a site list without the plan skill are each named.
   */
  it('SkillProse_EveryProbeCallPassageOfTheContent_HasAProbeCallSite', () => {
    const files = new Map(
      markdownFilesUnder(CONTENT_ROOT).map((file): [string, string] => [file, readFileSync(join(REPO_ROOT, file), 'utf8')]),
    );
    expect(files.size).toBeGreaterThan(0);
    const listed = SITES.filter((site) => site.shape === 'probe-call').map((site) => site.skill);
    expect(probeCallCensus(files, listed)).toEqual([]);

    const seeded = new Map(files).set(
      'content/seeded/SKILL.md',
      '```typescript\nexarchos_orchestrate({\n  action: "check_test_adequacy",\n})\n```\n',
    );
    expect(probeCallCensus(seeded, listed)).toEqual([
      'content/seeded/SKILL.md calls check_test_adequacy, and no probe-call site lists it',
    ]);

    const withoutPlan = listed.filter((file) => file !== 'content/design/skills/plan/SKILL.md');
    expect(probeCallCensus(files, withoutPlan)).toEqual([
      'content/design/skills/plan/SKILL.md calls check_test_adequacy, and no probe-call site lists it',
    ]);
    expect(probeCallCensus(new Map(), listed)).toEqual(
      listed.map((file) => `${file} is a probe-call site and holds no call of check_test_adequacy`),
    );
  });
});
