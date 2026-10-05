// Binds the posture table in the delegate skill to `POSTURE_DISPATCH_MAP`. Prose that restates a
// contract is a representation of the contract, so a test must hold it to the shipped map.
//
// Covered: the row key set must equal the key set of the map, in both directions. Each row must
// state `subagent` and `workspace`, and a row with `subagent: true` must state `naming`. Each
// stated cell must agree with the map.
//
// Not covered: `requires`, `fallback`, `rationale`, and the "At the call site" column. The Markdown
// states them only as free prose. A parser over free prose turns vacuous before it catches drift.
//
// The two authorities are the skill Markdown under `content/` and the frozen map in
// `dispatch-shape.ts`. The test reads the authored file, because a rendered copy only checks the
// renderer. The Markdown has no import edge, and no module imports it.
//
// @oracle-sources: ../../../../content/delivery/skills/delegate/references/parallel-strategy.md, ../../../../src/runtime/agents/dispatch-shape.ts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POSTURE_DISPATCH_MAP, type DispatchShape } from '../../../../src/runtime/agents/dispatch-shape.js';
import { skillReference as resolveSkillReference } from '../../../../tools/test-helpers/content-tree.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository root, four levels above this directory. */
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** The authoring surface. Each rendered skill tree holds a render of this file. */
const SKILL_SOURCE = resolveSkillReference('delegate', 'parallel-strategy.md');

/** The repo-relative path with forward slashes, so a failure message is the same on each machine. */
const SKILL_LABEL = path.relative(REPO_ROOT, SKILL_SOURCE).split(path.sep).join('/');

/**
 * The shipped map, keyed by plain string. `Object.entries` gives the own key set of the map, not a
 * list retyped here. A string key also lets the binding look up a posture that only the prose
 * names, without a cast.
 */
const boundShapes: ReadonlyMap<string, DispatchShape> = new Map(
  Object.entries(POSTURE_DISPATCH_MAP),
);

/**
 * The floor on the count of prose cells that the binding compares: 3 rows of 3 fields. The count is
 * written by hand on purpose, because a floor derived from the parse agrees with a parser that sees
 * no cells. This floor is a second, cruder check behind the mandatory-cell rule.
 */
const MIN_BOUND_CELLS = 9;

/** Thrown when the prose table cannot be read. A parse that resolves nothing must fail, not pass as agreement. */
class ProseBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProseBindingError';
  }
}

const BOUND_FIELDS = ['subagent', 'naming', 'workspace'] as const;
type BoundField = (typeof BOUND_FIELDS)[number];

/**
 * The fields that each row must state. `naming` is mandatory only for a row with `subagent: true`,
 * because a row that spawns no subagent has nothing to name. See `bindProseToMap`.
 */
const MANDATORY_FIELDS: readonly BoundField[] = ['subagent', 'workspace'];

function isBoundField(value: string): value is BoundField {
  return BOUND_FIELDS.some((field) => field === value);
}

/** Render a map field the way the prose states it, so the two are comparable. */
function mapValue(shape: DispatchShape, field: BoundField): string {
  switch (field) {
    case 'subagent':
      return String(shape.subagent);
    case 'naming':
      return shape.naming;
    case 'workspace':
      return shape.workspace;
  }
}

interface ProseLine {
  /** The line with every `<!-- … -->` region blanked out. */
  readonly text: string;
  /** 1-based, for failure messages that point at the real file. */
  readonly lineNo: number;
  /** The raw line was ENTIRELY an HTML comment — a capability guard. */
  readonly guardOnly: boolean;
}

/**
 * Blank every `<!-- … -->` region while preserving line structure.
 *
 * The section is wrapped in `<!-- requires:subagent:spawn -->` /
 * `<!-- /requires -->` capability guards, and a guard's TEXT must never be
 * mistaken for content. Newlines inside a (possibly multi-line) comment are
 * kept so reported line numbers still match the file on disk.
 */
function blankHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
}

function proseLines(markdown: string): readonly ProseLine[] {
  const raw = markdown.split('\n');
  return blankHtmlComments(markdown)
    .split('\n')
    .map((text, index) => ({
      text,
      lineNo: index + 1,
      guardOnly: text.trim().length === 0 && (raw[index] ?? '').trim().length > 0,
    }));
}

const SECTION_HEADING = /^##\s+Dispatch Shape by Posture\s*$/;
const TOP_LEVEL_HEADING = /^#{1,2}\s/;
const POSTURE_COLUMN = /^posture$/i;
const SHAPE_COLUMN = /emitted\s+launch\s+shape/i;

/**
 * The lines belonging to the `## Dispatch Shape by Posture` section: from just
 * after the heading to the next `#`/`##`. Sub-headings (`###`) stay INSIDE, so
 * a table pushed down under a future sub-heading is still found.
 */
function sectionOf(lines: readonly ProseLine[], label: string): readonly ProseLine[] {
  const headings = lines.filter((line) => SECTION_HEADING.test(line.text));
  if (headings.length !== 1) {
    throw new ProseBindingError(
      `${label}: expected exactly ONE \`## Dispatch Shape by Posture\` heading, found ` +
        `${headings.length}. A renamed, deleted or duplicated heading FAILS here rather ` +
        `than resolving zero rows into a clean run.`,
    );
  }
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.text));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL_HEADING.test(lines[i]?.text ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

interface TableRowLine {
  readonly cells: readonly string[];
  readonly lineNo: number;
}

interface RawTable {
  readonly header: readonly string[];
  readonly body: readonly TableRowLine[];
}

function splitCells(text: string): readonly string[] {
  return text
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Reads a pipe block as a table. A header and a delimiter with no body row is still a table, so the
 * caller reports "zero rows" and not "no table".
 */
function toTable(block: readonly ProseLine[]): RawTable | undefined {
  if (block.length < 2) return undefined;
  const header = splitCells(block[0]?.text ?? '');
  if (!isDelimiterRow(splitCells(block[1]?.text ?? ''))) return undefined;
  const body = block
    .slice(2)
    .map((line) => ({ cells: splitCells(line.text), lineNo: line.lineNo }));
  return { header, body };
}

/**
 * Every pipe table in `lines`. The scan skips a guard-comment line and does not treat it as blank.
 * Thus a `<!-- requires:… -->` line between two rows cannot split one table into two. Such a split
 * silently shrinks the parsed row count.
 */
function tablesIn(lines: readonly ProseLine[]): readonly RawTable[] {
  const tables: RawTable[] = [];
  let block: ProseLine[] = [];
  const flush = (): void => {
    const table = toTable(block);
    if (table !== undefined) tables.push(table);
    block = [];
  };
  for (const line of lines) {
    if (line.guardOnly) continue;
    if (line.text.trim().startsWith('|')) {
      block.push(line);
      continue;
    }
    flush();
  }
  flush();
  return tables;
}

function postureTable(section: readonly ProseLine[], label: string): RawTable {
  const candidates = tablesIn(section).filter(
    (table) =>
      table.header.some((cell) => POSTURE_COLUMN.test(cell)) &&
      table.header.some((cell) => SHAPE_COLUMN.test(cell)),
  );
  const found = candidates[0];
  if (candidates.length !== 1 || found === undefined) {
    throw new ProseBindingError(
      `${label}: expected exactly ONE posture table (a header carrying a "Posture" column and ` +
        `an "Emitted launch shape" column, followed by a delimiter row) in the ` +
        `\`## Dispatch Shape by Posture\` section, found ${candidates.length}. A reformatted or ` +
        `deleted table FAILS here rather than parsing as agreement.`,
    );
  }
  return found;
}

interface ProseRow {
  readonly posture: string;
  /** Only the fields the prose ACTUALLY states. Absence is meaningful. */
  readonly stated: ReadonlyMap<BoundField, string>;
  readonly lineNo: number;
}

/** ``  `naming: "anonymous"`  `` — a field assignment inside a code span. */
const CODE_SPAN_ASSIGNMENT = /`\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*([^`]*?)\s*`/g;
const SINGLE_CODE_SPAN = /^`([^`]+)`$/;

function unquote(value: string): string {
  return /^"(.*)"$/.exec(value)?.[1] ?? value;
}

function parseRow(
  row: TableRowLine,
  postureIndex: number,
  shapeIndex: number,
  label: string,
): ProseRow {
  const postureCell = row.cells[postureIndex] ?? '';
  const posture = SINGLE_CODE_SPAN.exec(postureCell)?.[1];
  if (posture === undefined) {
    throw new ProseBindingError(
      `${label} line ${row.lineNo}: posture cell ${JSON.stringify(postureCell)} is not a single ` +
        `backticked posture name.`,
    );
  }

  const stated = new Map<BoundField, string>();
  const shapeCell = row.cells[shapeIndex] ?? '';
  CODE_SPAN_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SPAN_ASSIGNMENT.exec(shapeCell)) !== null) {
    const field = match[1];
    const rawValue = match[2];
    if (field === undefined || rawValue === undefined) continue;
    if (!isBoundField(field)) {
      throw new ProseBindingError(
        `${label} line ${row.lineNo}: posture "${posture}" states \`${field}\`, a field this ` +
          `binding does not cover. A field added to the table must be added to the binding — ` +
          `an unbound documented field is precisely the drift surface DR-25 closes.`,
      );
    }
    if (stated.has(field)) {
      throw new ProseBindingError(
        `${label} line ${row.lineNo}: posture "${posture}" states \`${field}\` more than once.`,
      );
    }
    const value = unquote(rawValue);
    if (field === 'subagent' && value !== 'true' && value !== 'false') {
      throw new ProseBindingError(
        `${label} line ${row.lineNo}: posture "${posture}" states \`subagent: ${rawValue}\`, ` +
          `which is not a boolean literal. A cell that cannot be read is a FAILURE, never an ` +
          `unstated field.`,
      );
    }
    stated.set(field, value);
  }

  return { posture, stated, lineNo: row.lineNo };
}

interface ParsedProseTable {
  readonly label: string;
  readonly rows: readonly ProseRow[];
}

/**
 * Parse the posture table out of the delegate skill's markdown.
 *
 * FAILS CLOSED at every step — missing/renamed heading, missing/reformatted
 * table, zero data rows, an unreadable cell, an unknown field. There is no
 * input for which this returns an empty, clean result.
 */
function parseProseDispatchTable(markdown: string, label: string): ParsedProseTable {
  const section = sectionOf(proseLines(markdown), label);
  const table = postureTable(section, label);
  const postureIndex = table.header.findIndex((cell) => POSTURE_COLUMN.test(cell));
  const shapeIndex = table.header.findIndex((cell) => SHAPE_COLUMN.test(cell));
  const rows = table.body.map((row) => parseRow(row, postureIndex, shapeIndex, label));
  if (rows.length === 0) {
    throw new ProseBindingError(
      `${label}: the posture table resolved ZERO data rows. An empty denominator FAILS — a ` +
        `reformatted table must never read as a clean run.`,
    );
  }
  return { label, rows };
}

interface CellComparison {
  readonly posture: string;
  readonly field: BoundField;
  readonly prose: string;
  readonly map: string;
}

interface BindingReport {
  /** Every prose cell actually compared against the map. The denominator. */
  readonly comparisons: readonly CellComparison[];
  /** Human-readable disagreements. Empty ⇔ the two authorities agree. */
  readonly mismatches: readonly string[];
}

/**
 * Compares each parsed row with the map. The two key sets must be equal in both directions, and no
 * posture can have two rows. Three rules apply to each row:
 *
 * 1. Each cell that the prose states must agree with the map.
 * 2. Each row must state the mandatory fields, and a row with `subagent: true` must state `naming`.
 *    Without this rule, a deleted cell shrinks the binding and the test stays green.
 * 3. A row with `subagent: false` can omit `naming`, because there is no spawn to address. The map
 *    must then not bind `naming: "named"` for that posture.
 */
function bindProseToMap(
  parsed: ParsedProseTable,
  shapes: ReadonlyMap<string, DispatchShape>,
): BindingReport {
  const comparisons: CellComparison[] = [];
  const mismatches: string[] = [];

  const documented = parsed.rows.map((row) => row.posture);
  const bound = [...shapes.keys()];

  for (const posture of documented) {
    if (!shapes.has(posture)) {
      mismatches.push(
        `the skill table documents posture "${posture}", which POSTURE_DISPATCH_MAP does not bind`,
      );
    }
  }
  for (const posture of bound) {
    if (!documented.includes(posture)) {
      mismatches.push(
        `POSTURE_DISPATCH_MAP binds posture "${posture}", which the skill table does not document`,
      );
    }
  }
  for (const posture of new Set(documented.filter((p, i) => documented.indexOf(p) !== i))) {
    mismatches.push(`the skill table documents posture "${posture}" in more than one row`);
  }

  for (const row of parsed.rows) {
    const shape = shapes.get(row.posture);
    if (shape === undefined) continue;

    for (const field of BOUND_FIELDS) {
      const prose = row.stated.get(field);
      if (prose === undefined) continue;
      const value = mapValue(shape, field);
      comparisons.push({ posture: row.posture, field, prose, map: value });
      if (prose !== value) {
        mismatches.push(
          `posture "${row.posture}" (${parsed.label} line ${row.lineNo}): the skill table states ` +
            `\`${field}: ${prose}\` but POSTURE_DISPATCH_MAP binds \`${field}: ${value}\``,
        );
      }
    }

    for (const field of MANDATORY_FIELDS) {
      if (!row.stated.has(field)) {
        mismatches.push(
          `posture "${row.posture}" (${parsed.label} line ${row.lineNo}): the skill table states ` +
            `no \`${field}\`; every documented row must state it`,
        );
      }
    }
    if (row.stated.get('subagent') === 'true' && !row.stated.has('naming')) {
      mismatches.push(
        `posture "${row.posture}" (${parsed.label} line ${row.lineNo}): the skill table states ` +
          `\`subagent: true\` but no \`naming\`. Naming is the field the 2026-08-07 phantom-` +
          `teammate incident turned on; a row that spawns must document it`,
      );
    }

    if (
      row.stated.get('subagent') === 'false' &&
      !row.stated.has('naming') &&
      shape.naming === 'named'
    ) {
      mismatches.push(
        `posture "${row.posture}" (${parsed.label} line ${row.lineNo}): the skill table states ` +
          `\`subagent: false\` — nothing is spawned, so nothing can be named — yet ` +
          `POSTURE_DISPATCH_MAP binds \`naming: "named"\``,
      );
    }
  }

  return { comparisons, mismatches };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fixture surgery: blank the delimiter row of the posture table, leaving the
 * header and the data rows in place. Scoped to the section so it cannot hit
 * one of the file's other tables.
 */
function withDelimiterRowRemoved(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => SECTION_HEADING.test(line));
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('|') && isDelimiterRow(splitCells(line))) {
      lines[i] = 'the shapes, restated as a sentence instead of a table';
      return lines.join('\n');
    }
  }
  return markdown;
}

describe('Delegate skill prose ⇄ POSTURE_DISPATCH_MAP (DR-25, task 056)', () => {
  /**
   * The source must be under `content/`, the authoring surface. The test asserts the row count and
   * the cell count before the agreement, because a parse that resolves nothing gives an empty
   * `mismatches` list.
   */
  it('ProseBinding_SkillTableAndPostureMap_Agree', () => {
    const segments = path.relative(REPO_ROOT, SKILL_SOURCE).split(path.sep);
    expect(segments[0]).toBe('content');

    const markdown = readFileSync(SKILL_SOURCE, 'utf8');
    const parsed = parseProseDispatchTable(markdown, SKILL_LABEL);

    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.length).toBe(boundShapes.size);

    const report = bindProseToMap(parsed, boundShapes);

    expect(report.comparisons.length).toBeGreaterThanOrEqual(MIN_BOUND_CELLS);

    expect(report.mismatches).toEqual([]);
  });

  /**
   * The `shared-mutating` row states `naming`, and the binding compares that cell with the map. The
   * expected cell count comes from the map and the field list, which the parse never reads. Thus the
   * table is totally bound: each row states each bound field.
   *
   * A seeded drift in this cell must fail the binding. No shipped row omits `naming`, so a fixture
   * exercises rule 3 of `bindProseToMap`. A row with `subagent: false` and no `naming` passes
   * against the shipped map. It fails against a map that binds `naming: "named"`.
   */
  it('ProseBinding_SharedMutatingNaming_IsNowBound', () => {
    const markdown = readFileSync(SKILL_SOURCE, 'utf8');
    const parsed = parseProseDispatchTable(markdown, SKILL_LABEL);

    const row = parsed.rows.find((candidate) => candidate.posture === 'shared-mutating');
    expect(row, 'the posture table must document `shared-mutating`').toBeDefined();
    if (row === undefined) throw new Error('unreachable');

    expect(row.stated.get('naming')).toBe('anonymous');

    const report = bindProseToMap(parsed, boundShapes);
    expect(report.mismatches).toEqual([]);
    expect(
      report.comparisons.filter((c) => c.posture === 'shared-mutating' && c.field === 'naming'),
    ).toEqual([
      { posture: 'shared-mutating', field: 'naming', prose: 'anonymous', map: 'anonymous' },
    ]);

    expect(report.comparisons.length).toBe(boundShapes.size * BOUND_FIELDS.length);
    expect(MIN_BOUND_CELLS).toBe(boundShapes.size * BOUND_FIELDS.length);

    const needle = '`naming: "anonymous"`, `workspace: "main-worktree"`';
    const seeded = '`naming: "named"`, `workspace: "main-worktree"`';
    expect(markdown.split(needle).length - 1).toBe(1);
    const fixture = markdown.replace(needle, seeded);
    expect(fixture).not.toBe(markdown);

    const drifted = bindProseToMap(
      parseProseDispatchTable(fixture, '<shared-mutating-drift fixture>'),
      boundShapes,
    );
    const reported = drifted.mismatches.join('\n');
    expect(drifted.mismatches.length).toBeGreaterThan(0);
    expect(reported).toContain('shared-mutating');
    expect(reported).toContain('naming: named');
    expect(reported).toContain('naming: anonymous');

    const omitted = markdown.replace(
      '`subagent: false`, `naming: "anonymous"`',
      '`subagent: false`',
    );
    expect(omitted).not.toBe(markdown);
    const parsedOmitted = parseProseDispatchTable(omitted, '<naming-omitted fixture>');

    expect(bindProseToMap(parsedOmitted, boundShapes).mismatches).toEqual([]);

    const sharedMutating = boundShapes.get('shared-mutating');
    if (sharedMutating === undefined) throw new Error('unreachable');
    const namedMutator: ReadonlyMap<string, DispatchShape> = new Map(boundShapes).set(
      'shared-mutating',
      { ...sharedMutating, naming: 'named' },
    );
    const weak = bindProseToMap(parsedOmitted, namedMutator);
    expect(weak.mismatches.join('\n')).toContain('nothing can be named');
  });

  /**
   * The seed changes the `naming` cell of the `read-only` row from `anonymous` to `named`, the drift
   * that produces phantom teammates. The needle must occur exactly once. With no occurrence, the
   * fixture is the shipped file and the probe kills nothing. The row count proves that the fixture
   * still parses, so the failure is a disagreement. The unmutated file must still agree, which
   * proves that the binding does not fail on everything.
   */
  it('ProseBinding_SeededProseDrift_FailsTheBinding', () => {
    const markdown = readFileSync(SKILL_SOURCE, 'utf8');

    const needle = '`naming: "anonymous"`, `workspace: "inherited"`';
    const seeded = '`naming: "named"`, `workspace: "inherited"`';

    expect(markdown.split(needle).length - 1).toBe(1);
    const fixture = markdown.replace(needle, seeded);
    expect(fixture).not.toBe(markdown);

    const parsed = parseProseDispatchTable(fixture, '<seeded-drift fixture>');
    expect(parsed.rows.length).toBe(boundShapes.size);

    const report = bindProseToMap(parsed, boundShapes);
    expect(report.mismatches.length).toBeGreaterThan(0);

    const reported = report.mismatches.join('\n');
    expect(reported).toContain('read-only');
    expect(reported).toContain('naming: named');
    expect(reported).toContain('naming: anonymous');

    const control = bindProseToMap(parseProseDispatchTable(markdown, SKILL_LABEL), boundShapes);
    expect(control.mismatches).toEqual([]);
  });

  /**
   * A control proves first that the unmutated file parses to real rows. Without it, the three throws
   * cannot be told from a parser that resolves nothing. The three fixtures are a renamed heading, a
   * table with each data row deleted, and a delimiter row replaced by a sentence. The `dropped`
   * count proves that the second fixture removed the rows.
   */
  it('ProseBinding_ZeroRowsParsed_FailsClosed', () => {
    const markdown = readFileSync(SKILL_SOURCE, 'utf8');

    expect(parseProseDispatchTable(markdown, SKILL_LABEL).rows.length).toBeGreaterThan(0);

    const renamed = markdown.replace(
      '## Dispatch Shape by Posture',
      '## Dispatch Shapes, By Posture',
    );
    expect(renamed).not.toBe(markdown);
    expect(() => parseProseDispatchTable(renamed, '<renamed-heading fixture>')).toThrow(
      ProseBindingError,
    );
    expect(() => parseProseDispatchTable(renamed, '<renamed-heading fixture>')).toThrow(
      /exactly ONE .* heading, found 0/,
    );

    const rowPattern = new RegExp(
      `^\\|\\s*\`(?:${[...boundShapes.keys()].map(escapeRegExp).join('|')})\`\\s*\\|`,
    );
    const kept: string[] = [];
    let dropped = 0;
    for (const line of markdown.split('\n')) {
      if (rowPattern.test(line)) {
        dropped += 1;
        continue;
      }
      kept.push(line);
    }
    expect(dropped).toBe(boundShapes.size);
    expect(() => parseProseDispatchTable(kept.join('\n'), '<zero-row fixture>')).toThrow(
      /resolved ZERO data rows/,
    );

    const reformatted = withDelimiterRowRemoved(markdown);
    expect(reformatted).not.toBe(markdown);
    expect(() => parseProseDispatchTable(reformatted, '<reformatted fixture>')).toThrow(
      /exactly ONE posture table/,
    );
  });
});
