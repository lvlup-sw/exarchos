/**
 * A skill text or a guard reply that tells a caller how to complete a task names a gated writer.
 * The gated writers are `task_complete` after the gates of the task, the task-completion runbook, and `settle`.
 * No skill text and no guard reply prescribes a write of `tasks[...].status` with the value `complete`.
 *
 * @oracle-sources: ../../content, ../../src/workflow/guards.ts, ../../src/workflow/hsm-definitions.ts, ../../src/registry/actions/workflow.ts
 *
 * The census reads three payload shapes: an index path, a list element in an `updates` payload, and a spread element.
 * A list element can be in a flow list or in a YAML block sequence, and the value can be quoted or not.
 * A finding outside the exception list fails, and an exception that excuses no finding fails.
 *
 * The census also reads the description of the workflow `update` action and the `update` purposes of the playbooks.
 * Prose that names the write in words, with no payload, is outside the census.
 * The test reads only the content source. `render:guard` pins `rendered/` to `content/`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { workflowActions } from '../../src/registry/actions/workflow.js';
import { workflowPlaybooks } from '../../src/workflow/playbooks.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The root of the skill, command and rule sources. */
const CONTENT_ROOT = 'content';

/** The modules that hold the guard replies. */
const GUARD_MODULES: readonly string[] = ['src/workflow/guards.ts', 'src/workflow/hsm-definitions.ts'];

/** The fields of a guard reply that tell a caller what to write. */
const REPLY_FIELDS: ReadonlySet<string> = new Set(['suggestedFix', 'expectedShape']);

/** The census reads at least this many Markdown files. The content tree held 127 when this was written. */
const MIN_CONTENT_FILES = 120;

/** The census reads at least this many guard reply fields. The guard modules held 48 when this was written. */
const MIN_GUARD_REPLIES = 40;

/** A shape of a payload that writes the value `complete` to the status of a task. */
type PayloadShape = 'index-path' | 'list-element' | 'spread-element';

/** One unit that the census reads: a fenced block, a line of Markdown, or the value of one guard reply field. */
interface PayloadUnit {
  /** The content path, or the guard module path with `#` and the name of the reply field. */
  readonly site: string;
  /** The 1-based line where the unit starts. */
  readonly line: number;
  /** The text of the unit. */
  readonly text: string;
  /** True for a guard reply. A Markdown unit is a payload when it holds an `updates` key. */
  readonly payload: boolean;
}

/** A payload shape that the census found in a unit. */
interface Finding {
  readonly site: string;
  readonly line: number;
  readonly shape: PayloadShape;
}

/** A declared exception to the census. */
interface CensusException {
  /** The site that the exception excuses, as a `Finding` names it. */
  readonly path: string;
  /** Why the text keeps the write. */
  readonly reason: string;
  /** The issue that owns the removal or the review of the exception. */
  readonly owner: string;
}

/**
 * The exceptions. This list is a deliberate subset of the findings, because each other text must name a gated writer.
 * Each row excuses one site, with a reason and an owner.
 * The agent-teams texts name `exarchos_workflow set`, and no workflow composite case serves `set`.
 * The guard shape is the state that the guard reads, and the guard reason names `task_complete`.
 */
const EXCEPTIONS: readonly CensusException[] = [
  {
    path: 'content/delivery/skills/delegate/references/agent-teams-saga.md',
    reason: 'agent-teams mode is off-plane until re-designed',
    owner: '#1918',
  },
  {
    path: 'src/workflow/guards.ts#expectedShape',
    reason:
      'a descriptive shape of the state that the guard reads. The transition reply carries it as requiredState, and the guard reason names task_complete',
    owner: '#1929',
  },
];

/** A Markdown fence line, with or without indentation. */
const FENCE = /^\s*(```|~~~)/;

/** An `updates` key, which marks a Markdown unit as a payload of `update` or `set`. */
const UPDATES_KEY = /\bupdates\b/;

/** The value `complete`, quoted or bare. A bare value ends at a character that cannot continue a word. */
const COMPLETE_VALUE = String.raw`(?:["'\`]complete["'\`]|complete(?![\w-]))`;

/** A status entry with the value `complete`, in JSON, YAML or TypeScript. */
const COMPLETE_STATUS = new RegExp(String.raw`\bstatus["'\`]?\s*:\s*${COMPLETE_VALUE}`);

/** A write through an index path: `tasks[0].status: "complete"`, or `tasks[0]: { …, status: "complete" }`. */
const INDEX_PATH = new RegExp(
  String.raw`\btasks\[[^\]\s]+\](?:\.status["'\`]?\s*[:=]\s*${COMPLETE_VALUE}|["'\`]?\s*:\s*\{[^}]*\bstatus["'\`]?\s*:\s*${COMPLETE_VALUE})`,
);

/** The opener of a task list in a payload: `tasks: [`, or `tasks: <list>.map(`. */
const TASK_LIST_OPENER = /\btasks["'`]?\s*:\s*(?:\[|[\w.]+\.map\()/g;

/** The key line of a YAML block sequence of tasks: `tasks:` with nothing after the colon. */
const TASK_BLOCK_KEY = /^(\s*)tasks["'`]?\s*:\s*$/;

/** A spread element with the value `complete`: `{...task, status: "complete"}`. */
const SPREAD_ELEMENT = new RegExp(String.raw`\{\s*\.\.\.[\w.]+\s*,[^}]*\bstatus["'\`]?\s*:\s*${COMPLETE_VALUE}`);

/** The text from an opening bracket to its closing bracket. An unclosed bracket gives the rest of the text. */
function balancedSpan(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '[' || ch === '(' || ch === '{') depth += 1;
    if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/**
 * The lines of each YAML block sequence under a `tasks:` key.
 * A block ends at the first line that is not blank and is not indented past the key.
 * A `- ` item at the indentation of the key stays in the block.
 */
function taskBlockSpans(text: string): readonly string[] {
  const lines = text.split('\n');
  const spans: string[] = [];
  lines.forEach((line, index) => {
    const key = TASK_BLOCK_KEY.exec(line);
    if (key === null) return;
    const indent = (key[1] ?? '').length;
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      const nextIndent = next.length - next.trimStart().length;
      const inBlock =
        next.trim().length === 0 || nextIndent > indent || (nextIndent === indent && next.trimStart().startsWith('- '));
      if (!inBlock) break;
      body.push(next);
    }
    spans.push(body.join('\n'));
  });
  return spans;
}

/** True when a task list of the unit, in flow form or in block form, holds an element with the value `complete`. */
function hasCompleteListElement(text: string): boolean {
  for (const match of text.matchAll(TASK_LIST_OPENER)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (COMPLETE_STATUS.test(balancedSpan(text, open))) return true;
  }
  return taskBlockSpans(text).some((span) => COMPLETE_STATUS.test(span));
}

/** The payload shapes of one unit. A list element counts only in a payload. */
function shapesOf(unit: PayloadUnit): readonly PayloadShape[] {
  const shapes: PayloadShape[] = [];
  if (INDEX_PATH.test(unit.text)) shapes.push('index-path');
  if (unit.payload && hasCompleteListElement(unit.text)) shapes.push('list-element');
  if (SPREAD_ELEMENT.test(unit.text)) shapes.push('spread-element');
  return shapes;
}

/** The units of a Markdown file: each fenced block, and each line outside a fence. */
function markdownUnits(site: string, markdown: string): readonly PayloadUnit[] {
  const units: PayloadUnit[] = [];
  const lines = markdown.split('\n');
  let fenceStart = -1;
  let fenceBody: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      if (fenceStart < 0) {
        fenceStart = i + 1;
        fenceBody = [];
      } else {
        const text = fenceBody.join('\n');
        units.push({ site, line: fenceStart, text, payload: UPDATES_KEY.test(text) });
        fenceStart = -1;
      }
    } else if (fenceStart >= 0) {
      fenceBody.push(line);
    } else {
      units.push({ site, line: i + 1, text: line, payload: UPDATES_KEY.test(line) });
    }
  }
  if (fenceStart >= 0) {
    const text = fenceBody.join('\n');
    units.push({ site, line: fenceStart, text, payload: UPDATES_KEY.test(text) });
  }
  return units;
}

/** The units of a guard module: the value of each `suggestedFix` and `expectedShape` property in an object literal. */
function guardReplyUnits(path: string, source: string): readonly PayloadUnit[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const units: PayloadUnit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && REPLY_FIELDS.has(node.name.text)) {
      units.push({
        site: `${path}#${node.name.text}`,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        text: node.initializer.getText(file),
        payload: true,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return units;
}

/** Each Markdown file under the content root, repo-relative and sorted. */
function contentMarkdownFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(relative(REPO_ROOT, full).split('\\').join('/'));
    }
  };
  walk(join(REPO_ROOT, CONTENT_ROOT));
  return found.sort();
}

/** The findings of a set of units. */
function findingsIn(units: readonly PayloadUnit[]): readonly Finding[] {
  return units.flatMap((unit) => shapesOf(unit).map((shape) => ({ site: unit.site, line: unit.line, shape })));
}

/** The findings that no exception excuses, as `site:line shape` strings. */
function unexcused(findings: readonly Finding[], exceptions: readonly CensusException[]): readonly string[] {
  const excused = new Set(exceptions.map((exception) => exception.path));
  return findings
    .filter((finding) => !excused.has(finding.site))
    .map((finding) => `${finding.site}:${finding.line} ${finding.shape}`);
}

/** The exceptions that excuse no finding. */
function staleExceptions(findings: readonly Finding[], exceptions: readonly CensusException[]): readonly string[] {
  const sites = new Set(findings.map((finding) => finding.site));
  return exceptions.filter((exception) => !sites.has(exception.path)).map((exception) => exception.path);
}

/** A task field that the `update` description lists among the fields that it mutates. */
const TASK_FIELD_IN_DESCRIPTION = /\btask (?:results?|status(?:es)?)\b/i;

/** How the description of the workflow `update` action disagrees with the completion rule. */
function updateDescriptionProblems(description: string): readonly string[] {
  const problems: string[] = [];
  if (description.length === 0) problems.push('the workflow tool declares no update action with a description');
  if (TASK_FIELD_IN_DESCRIPTION.test(description)) {
    problems.push('the update description lists a task field among the fields that it mutates');
  }
  if (!description.includes('task_complete')) {
    problems.push('the update description does not name task_complete for task completion');
  }
  return problems;
}

/** The `update` purposes of the playbooks that state a task field, as `workflowType:phase` strings. */
function playbookUpdateProblems(): readonly string[] {
  const problems: string[] = [];
  for (const [workflowType, playbooks] of workflowPlaybooks) {
    for (const playbook of playbooks) {
      const updates = playbook.tools.filter((tool) => tool.tool === 'exarchos_workflow' && tool.action === 'update');
      for (const update of updates) {
        if (TASK_FIELD_IN_DESCRIPTION.test(update.purpose)) problems.push(`${workflowType}:${playbook.phase}`);
      }
    }
  }
  return problems;
}

/** The units of the live tree, with the counts of what the census read. */
function liveCensus(): { readonly files: number; readonly replies: number; readonly units: readonly PayloadUnit[] } {
  const files = contentMarkdownFiles();
  const markdown = files.flatMap((file) => markdownUnits(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
  const replies = GUARD_MODULES.flatMap((path) => guardReplyUnits(path, readFileSync(join(REPO_ROOT, path), 'utf8')));
  return { files: files.length, replies: replies.length, units: [...markdown, ...replies] };
}

describe('TaskCompletionTextCensus — completion texts name a gated writer', () => {
  /** The census reads the whole content tree and every guard reply, so a census that reads nothing fails. */
  it('TaskCompletionTextCensus_LiveTree_ReadsTheFloor', () => {
    const census = liveCensus();
    expect(census.files).toBeGreaterThanOrEqual(MIN_CONTENT_FILES);
    expect(census.replies).toBeGreaterThanOrEqual(MIN_GUARD_REPLIES);
    expect(census.units.filter((unit) => unit.site.startsWith(`${CONTENT_ROOT}/`)).length).toBeGreaterThan(census.files);
  });

  it('TaskCompletionTextCensus_LiveTree_HasNoUnexcusedStatusWrite', () => {
    expect(unexcused(findingsIn(liveCensus().units), EXCEPTIONS)).toEqual([]);
  });

  /** Each exception excuses a live finding and names a reason and an owner, so a stale row cannot hide a new write. */
  it('TaskCompletionTextCensus_EachException_ExcusesALiveFindingAndNamesAnOwner', () => {
    expect(staleExceptions(findingsIn(liveCensus().units), EXCEPTIONS)).toEqual([]);
    for (const exception of EXCEPTIONS) {
      expect(exception.reason.length, exception.path).toBeGreaterThan(0);
      expect(exception.owner, exception.path).toMatch(/^#\d+$/);
    }
  });

  it('TaskCompletionTextCensus_UpdateDescription_NamesTheGatedWriter', () => {
    const update = workflowActions.find((action) => action.name === 'update');
    expect(updateDescriptionProblems(update?.description ?? '')).toEqual([]);
  });

  /**
   * No playbook gives `exarchos_workflow update` the purpose of a task status write.
   * Each playbook whose tools hold `task_complete` says that `task_complete` records a completion, in its `update` purpose.
   */
  it('TaskCompletionTextCensus_PlaybookUpdatePurposes_LeaveTheCompletionToTaskComplete', () => {
    expect(playbookUpdateProblems()).toEqual([]);
    const completing = [...workflowPlaybooks.values()]
      .flat()
      .filter((playbook) => playbook.tools.some((tool) => tool.action === 'task_complete'));
    expect(completing.length).toBeGreaterThanOrEqual(2);
    for (const playbook of completing) {
      const update = playbook.tools.find((tool) => tool.tool === 'exarchos_workflow' && tool.action === 'update');
      expect(update?.purpose ?? '', playbook.phase).toContain('task_complete');
    }
  });

  /** Each payload shape has one seeded violation and one clean twin. */
  it('TaskCompletionTextCensus_SeededIndexPath_IsFoundAndItsTwinIsClean', () => {
    const seeded = markdownUnits('seed.md', '- Mark: `updates: { "tasks[0].status": "complete" }`');
    expect(findingsIn(seeded)).toEqual([{ site: 'seed.md', line: 1, shape: 'index-path' }]);
    const seededBare = markdownUnits('seed.md', '- Mark: `updates: { tasks[0].status: complete }`');
    expect(findingsIn(seededBare).map((finding) => finding.shape)).toEqual(['index-path']);
    const seededSlot = markdownUnits('seed.md', '```\nupdates: { "tasks[2]": { id: "T-003", status: "complete" } }\n```');
    expect(findingsIn(seededSlot).map((finding) => finding.shape)).toEqual(['index-path']);

    const twin = markdownUnits('twin.md', '- Start: `updates: { "tasks[0].status": "in_progress" }`');
    expect(findingsIn(twin)).toEqual([]);
    const twinSlot = markdownUnits('twin.md', '```\nupdates: { "tasks[2]": { id: "T-003", status: "pending" } }\n```');
    expect(findingsIn(twinSlot)).toEqual([]);
  });

  it('TaskCompletionTextCensus_SeededListElement_IsFoundOnlyInAnUpdatesPayload', () => {
    const element = '"tasks": [\n  { "id": "1", "status": "complete" }\n]';
    const seeded = markdownUnits('seed.md', `Text.\n\`\`\`json\n{ "action": "update", "updates": { ${element} } }\n\`\`\``);
    expect(findingsIn(seeded)).toEqual([{ site: 'seed.md', line: 2, shape: 'list-element' }]);

    const twin = markdownUnits('twin.md', `Text.\n\`\`\`json\n{ ${element} }\n\`\`\``);
    expect(findingsIn(twin)).toEqual([]);
  });

  /** A list element in a YAML block sequence of a `set` payload, with a bare value, is found. Its twins are clean. */
  it('TaskCompletionTextCensus_SeededBlockSequenceElement_IsFoundAndItsTwinsAreClean', () => {
    const block = (status: string): string =>
      ['```yaml', 'exarchos_workflow set:', '  updates:', '    tasks:', '      - id: T-001', `        status: ${status}`, '```'].join(
        '\n',
      );
    expect(findingsIn(markdownUnits('seed.md', block('complete')))).toEqual([
      { site: 'seed.md', line: 1, shape: 'list-element' },
    ]);
    expect(findingsIn(markdownUnits('seed.md', block('"complete"'))).map((finding) => finding.shape)).toEqual([
      'list-element',
    ]);

    expect(findingsIn(markdownUnits('twin.md', block('in_progress')))).toEqual([]);
    expect(findingsIn(markdownUnits('twin.md', block('completed')))).toEqual([]);
    const outsidePayload = ['```yaml', 'tasks:', '- id: T-001', '  status: complete', '```'].join('\n');
    expect(findingsIn(markdownUnits('twin.md', outsidePayload))).toEqual([]);
    const afterTheBlock = ['```yaml', 'updates:', '  tasks:', '    - id: T-001', 'status: complete', '```'].join('\n');
    expect(findingsIn(markdownUnits('twin.md', afterTheBlock))).toEqual([]);
  });

  it('TaskCompletionTextCensus_SeededSpreadElement_IsFoundAndItsTwinIsClean', () => {
    const seeded = markdownUnits('seed.md', '```yaml\ntasks: [{...task, status: "complete", completedAt: timestamp}]\n```');
    expect(findingsIn(seeded)).toEqual([{ site: 'seed.md', line: 1, shape: 'spread-element' }]);

    const twin = markdownUnits('twin.md', '```yaml\ntasks: [{...task, nativeTaskId: "returned-id"}]\n```');
    expect(findingsIn(twin)).toEqual([]);
  });

  /** A guard reply that names the state write is found at its field. A reply that names `task_complete` is clean. */
  it('TaskCompletionTextCensus_SeededGuardReply_IsFoundAtItsField', () => {
    const seeded = [
      'const reply = {',
      '  suggestedFix: {',
      "    tool: 'exarchos_workflow',",
      "    params: { action: 'update', updates: { tasks: open.map((t) => ({ id: t.id, status: 'complete' })) } },",
      '  },',
      '};',
    ].join('\n');
    expect(findingsIn(guardReplyUnits('guard.ts', seeded))).toEqual([
      { site: 'guard.ts#suggestedFix', line: 2, shape: 'list-element' },
    ]);

    const twin = seeded.replace(
      "tool: 'exarchos_workflow',\n    params: { action: 'update', updates: { tasks: open.map((t) => ({ id: t.id, status: 'complete' })) } },",
      "tool: 'exarchos_orchestrate',\n    params: { action: 'task_complete', taskId: 't1' },",
    );
    expect(twin).not.toBe(seeded);
    expect(findingsIn(guardReplyUnits('guard.ts', twin))).toEqual([]);
  });

  /** A write seeded into a real skill file fails the census, and the same write in an excused file does not. */
  it('TaskCompletionTextCensus_SeededWriteInARealSkill_IsUnexcused', () => {
    const site = 'content/continuity/skills/checkpoint/SKILL.md';
    const markdown = readFileSync(join(REPO_ROOT, site), 'utf8');
    expect(unexcused(findingsIn(markdownUnits(site, markdown)), EXCEPTIONS)).toEqual([]);

    const seeded = `${markdown}\n- **Mark task complete**: \`updates: { "tasks[0].status": "complete" }\`\n`;
    const findings = findingsIn(markdownUnits(site, seeded));
    expect(unexcused(findings, EXCEPTIONS)).toEqual([`${site}:${markdown.split('\n').length + 1} index-path`]);

    const excusedSite = 'content/delivery/skills/delegate/references/agent-teams-saga.md';
    expect(unexcused(findingsIn(markdownUnits(excusedSite, seeded)), EXCEPTIONS)).toEqual([]);
  });

  /** A description that lists task results and names no gated writer gives both problems. */
  it('TaskCompletionTextCensus_SeededUpdateDescription_NamesBothProblems', () => {
    expect(
      updateDescriptionProblems('Mutate non-phase workflow state fields (artifacts, planReview, task results, etc.).'),
    ).toEqual([
      'the update description lists a task field among the fields that it mutates',
      'the update description does not name task_complete for task completion',
    ]);
    expect(updateDescriptionProblems('')).toContain('the workflow tool declares no update action with a description');
  });
});
