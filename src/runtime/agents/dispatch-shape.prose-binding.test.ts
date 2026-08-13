// ─── The delegate skill's posture table is a REPRESENTATION, so it is bound ──
//
// Task 048 documented the posture → dispatch contract in the delegate skill's
// `parallel-strategy.md`. That made the prose a FIFTH representation of one
// contract — alongside the agent-spec YAML, `dispatch-shape.ts`, the MCP
// handshake, and INV-11 — and nothing held it to the shipped map. Task 048
// mitigated it the only way a docs task could: by declaring in the prose that
// the emitted `dispatch` field wins. That is a convention someone must
// remember, which is the exact anti-pattern row DR-25 exists to close.
//
// This is also the SECOND boundary to grow an unbound prose representation
// (the spec's authority-topology table already records "skill prose" as an
// unbound representation of the event catalog). Two occurrences make it a
// pattern: documentation that restates a contract is a representation, and
// representations get bound.
//
// ── What this binding COVERS ────────────────────────────────────────────────
//
//   posture    — the table's row key set must EQUAL the map's key set, both
//                directions. A posture added to the map without a documented
//                row reddens; so does a documented row for a posture the map
//                does not bind.
//   subagent   — every row must state it, and it must agree.
//   workspace  — every row must state it, and it must agree.
//   naming     — every row stating `subagent: true` must state it, and it must
//                agree. A row stating `subagent: false` may omit it (there is
//                no spawn to address); such a row still binds the map to "not
//                `named`", which is the weaker half of the claim.
//
// ── What this binding DOES NOT COVER — stated plainly ───────────────────────
//
//   requires  — the capability list is not in the table. The section's closing
//     paragraph describes degradation in sentences; sentences are not parsed
//     here, because a parser over free prose degrades to vacuous far faster
//     than it catches drift.
//   fallback  — likewise unbound. The prose narrates both fallbacks
//     ("inline in the caller's own context", "anonymous into the shared
//     checkout"); neither is machine-compared.
//   rationale — unbound by construction; it is operator prose with no
//     canonical rendering.
//   the third column ("At the call site") — normative English
//     ("**Omit `name`.**"). Unbound.
//
// A partial binding that is honestly described beats one that overclaims.
//
// ── CLOSED by task 059: naming for `shared-mutating` ────────────────────────
//
// That row used to state only `subagent: false` and `workspace: "main-worktree"`,
// so the map's `naming: 'anonymous'` was pinned by rule (3) below only to "not
// `named`" — 1 of 9 posture-field cells unbindable. The row now states
// `naming: "anonymous"` and the cell is compared like any other, which takes
// `MIN_BOUND_CELLS` from 8 to 9 and makes the table TOTALLY bound: 3 rows ×
// 3 fields. `ProseBinding_SharedMutatingNaming_IsNowBound` pins that.
//
// Rule (3) — the weaker "not `named`" claim for a row that omits `naming` — is
// KEPT rather than deleted: it is the correct behaviour for any future
// `subagent: false` row that legitimately omits the field. No shipped row
// exercises it any more, so it is exercised below against a fixture map.
//
// ── The two authorities (DR-30) ─────────────────────────────────────────────
//
//   the skill markdown  — hand-authored English + a Markdown table, read from
//                         `skills-src/` (the AUTHORING surface). Deliberately
//                         NOT a rendered `skills/<runtime>/` copy: binding a
//                         generated artifact would only re-check the renderer,
//                         and the drift this test exists to catch happens where
//                         a human edits.
//   `./dispatch-shape.ts` — the shipped map, read off the frozen object.
//
// Neither reaches the other: the markdown has no import edges at all, and no
// module imports it. The comparison can genuinely disagree, and
// `ProseBinding_SeededProseDrift_FailsTheBinding` proves it does.
//
// @oracle-sources: ../../../../skills-src/delegate/references/parallel-strategy.md, ./dispatch-shape.ts
//
// Implements: DR-25.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POSTURE_DISPATCH_MAP, type DispatchShape } from './dispatch-shape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** repository root — `src/runtime/agents` is four levels down. */
const REPO_ROOT = path.resolve(HERE, '../../..');

/** The authoring surface. `skills/<runtime>/**` is a render of THIS file. */
const SKILL_SOURCE = path.join(
  REPO_ROOT,
  'skills-src',
  'delegate',
  'references',
  'parallel-strategy.md',
);

/** Repo-relative, forward-slashed — so a failure message reads the same on
 *  every machine and in CI logs rather than quoting a worktree path. */
const SKILL_LABEL = path.relative(REPO_ROOT, SKILL_SOURCE).split(path.sep).join('/');

/**
 * The shipped map, keyed by plain string.
 *
 * Read through `Object.entries` so a posture the prose invents can be looked up
 * (and reported as unbound) without a cast, and so the key set compared below
 * is the map's OWN, not a list retyped in this file.
 */
const boundShapes: ReadonlyMap<string, DispatchShape> = new Map(
  Object.entries(POSTURE_DISPATCH_MAP),
);

/**
 * The floor on how many prose cells this binding actually compares.
 *
 * Hand-counted against the shipped table (task 059, 2026-08-07): all three
 * rows state all three fields — 3 × 3 = 9. It was 8 until `shared-mutating`
 * gained its `naming` cell. Written by hand ON PURPOSE: a floor derived from
 * the parse would agree with a parser that had stopped seeing cells, which is
 * the vacuity this whole test is guarding against. A row that loses a cell
 * reddens the mandatory-cell rule; this floor is the second, cruder tooth
 * under the same property.
 */
const MIN_BOUND_CELLS = 9;

// ─── Failure mode: a prose parse that resolves nothing must never read clean ─

class ProseBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProseBindingError';
  }
}

// ─── The fields the prose can carry ─────────────────────────────────────────

const BOUND_FIELDS = ['subagent', 'naming', 'workspace'] as const;
type BoundField = (typeof BOUND_FIELDS)[number];

/**
 * Fields EVERY row must state. `naming` is deliberately not here: it is
 * conditionally mandatory (see `bindProseToMap`), because a row that spawns no
 * subagent has nothing to name.
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

// ─── Markdown reading, guard-comment aware ──────────────────────────────────

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

// ─── Locating the table ─────────────────────────────────────────────────────

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

function toTable(block: readonly ProseLine[]): RawTable | undefined {
  if (block.length < 2) return undefined;
  const header = splitCells(block[0]?.text ?? '');
  if (!isDelimiterRow(splitCells(block[1]?.text ?? ''))) return undefined;
  // A header + delimiter with NO body rows is still a table. It is returned so
  // the zero-row failure is reported as "zero rows", not as "no table".
  const body = block
    .slice(2)
    .map((line) => ({ cells: splitCells(line.text), lineNo: line.lineNo }));
  return { header, body };
}

/**
 * Every pipe table in `lines`.
 *
 * Guard-comment lines are SKIPPED rather than treated as blank, so a
 * `<!-- requires:… -->` placed between two rows cannot split one table into
 * two half-tables (which would silently shrink the parsed row count).
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

// ─── Parsing a row ──────────────────────────────────────────────────────────

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

// ─── The binding ────────────────────────────────────────────────────────────

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
    if (shape === undefined) continue; // already reported as an unbound posture

    // (1) Every cell the prose STATES must agree with the map.
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

    // (2) The binding may not erode by DELETION. Without this, dropping a cell
    //     from the table would silently shrink the binding and stay green.
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

    // (3) A row that spawns nothing may legitimately omit `naming` — there is
    //     no spawn to address. It still binds the WEAKER half of the claim: the
    //     map may not answer `named` for a shape the prose says is not a
    //     subagent at all. This is the honest partial binding, not a skip.
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

// ─── The three cases ────────────────────────────────────────────────────────

describe('Delegate skill prose ⇄ POSTURE_DISPATCH_MAP (DR-25, task 056)', () => {
  it('ProseBinding_SkillTableAndPostureMap_Agree', () => {
    // The AUTHORING surface. A rendered `skills/<runtime>/` copy would make
    // this a test of the renderer, not of the contract.
    const segments = path.relative(REPO_ROOT, SKILL_SOURCE).split(path.sep);
    expect(segments[0]).toBe('skills-src');

    const markdown = readFileSync(SKILL_SOURCE, 'utf8');
    const parsed = parseProseDispatchTable(markdown, SKILL_LABEL);

    // DENOMINATOR. A parse that resolved nothing must never read as agreement,
    // so the row count is asserted BEFORE the agreement claim.
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.length).toBe(boundShapes.size);

    const report = bindProseToMap(parsed, boundShapes);

    // …and the same for the CELL denominator: three rows that stated nothing
    // would produce zero comparisons and an empty `mismatches`.
    expect(report.comparisons.length).toBeGreaterThanOrEqual(MIN_BOUND_CELLS);

    expect(report.mismatches).toEqual([]);
  });

  it('ProseBinding_SharedMutatingNaming_IsNowBound', () => {
    const markdown = readFileSync(SKILL_SOURCE, 'utf8');
    const parsed = parseProseDispatchTable(markdown, SKILL_LABEL);

    const row = parsed.rows.find((candidate) => candidate.posture === 'shared-mutating');
    expect(row, 'the posture table must document `shared-mutating`').toBeDefined();
    if (row === undefined) throw new Error('unreachable');

    // The cell that used to be missing. While it was, the map's
    // `naming: 'anonymous'` was pinned only to "not `named`".
    expect(row.stated.get('naming')).toBe('anonymous');

    // …and it is genuinely COMPARED against the map, not merely present in the
    // prose. Presence without a comparison would be exactly the overclaim the
    // header warns about.
    const report = bindProseToMap(parsed, boundShapes);
    expect(report.mismatches).toEqual([]);
    expect(
      report.comparisons.filter((c) => c.posture === 'shared-mutating' && c.field === 'naming'),
    ).toEqual([
      { posture: 'shared-mutating', field: 'naming', prose: 'anonymous', map: 'anonymous' },
    ]);

    // The table is now TOTALLY bound: every row states every bound field. The
    // expectation is derived from the MAP and the field list — two authorities
    // the parse never touches — so it is a real denominator, not a restatement
    // of what the parser happened to find.
    expect(report.comparisons.length).toBe(boundShapes.size * BOUND_FIELDS.length);
    expect(MIN_BOUND_CELLS).toBe(boundShapes.size * BOUND_FIELDS.length);

    // ── FALSIFIABILITY ──────────────────────────────────────────────────────
    // The newly-bound cell has teeth: seed a drift into exactly this cell and
    // the binding reddens. Before the cell was stated there was nothing here
    // to seed, which is what "unbindable" meant.
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

    // ── The weaker rule (3) survives for a FUTURE row that omits `naming` ────
    // No shipped row exercises it now, so it is exercised against a fixture
    // map: prose that omits `naming` on a `subagent: false` row still refuses
    // a map binding `naming: 'named'`.
    const omitted = markdown.replace(
      '`subagent: false`, `naming: "anonymous"`',
      '`subagent: false`',
    );
    expect(omitted).not.toBe(markdown);
    const parsedOmitted = parseProseDispatchTable(omitted, '<naming-omitted fixture>');

    // Against the SHIPPED map (`anonymous`) omission is legal — under-specified,
    // not a disagreement…
    expect(bindProseToMap(parsedOmitted, boundShapes).mismatches).toEqual([]);

    // …but against a map that answered `named`, it is a mismatch.
    const sharedMutating = boundShapes.get('shared-mutating');
    if (sharedMutating === undefined) throw new Error('unreachable');
    const namedMutator: ReadonlyMap<string, DispatchShape> = new Map(boundShapes).set(
      'shared-mutating',
      { ...sharedMutating, naming: 'named' },
    );
    const weak = bindProseToMap(parsedOmitted, namedMutator);
    expect(weak.mismatches.join('\n')).toContain('nothing can be named');
  });

  it('ProseBinding_SeededProseDrift_FailsTheBinding', () => {
    const markdown = readFileSync(SKILL_SOURCE, 'utf8');

    // Mutate the `read-only` row's naming cell: `anonymous` → `named`. That is
    // the exact drift with teeth — a named read-only spawn is the shape that
    // produced three phantom teammates and zero verdicts on 2026-08-07.
    const needle = '`naming: "anonymous"`, `workspace: "inherited"`';
    const seeded = '`naming: "named"`, `workspace: "inherited"`';

    // The mutation must BITE, and bite in exactly one place. If the prose were
    // reformatted so this text no longer occurs (or occurs twice), the fixture
    // would be silently unmutated and the assertions below would be measuring
    // the shipped file — a kill probe that kills nothing.
    expect(markdown.split(needle).length - 1).toBe(1);
    const fixture = markdown.replace(needle, seeded);
    expect(fixture).not.toBe(markdown);

    const parsed = parseProseDispatchTable(fixture, '<seeded-drift fixture>');
    // Still a WELL-FORMED table — only a value changed. This isolates the red
    // below to disagreement rather than to a parse failure.
    expect(parsed.rows.length).toBe(boundShapes.size);

    const report = bindProseToMap(parsed, boundShapes);
    expect(report.mismatches.length).toBeGreaterThan(0);

    const reported = report.mismatches.join('\n');
    expect(reported).toContain('read-only');
    expect(reported).toContain('naming: named');
    expect(reported).toContain('naming: anonymous');

    // NEGATIVE TWIN — the unmutated file still agrees, so the red above is
    // attributable to the seeded cell and not to a parser that reddens on
    // everything.
    const control = bindProseToMap(parseProseDispatchTable(markdown, SKILL_LABEL), boundShapes);
    expect(control.mismatches).toEqual([]);
  });

  it('ProseBinding_ZeroRowsParsed_FailsClosed', () => {
    const markdown = readFileSync(SKILL_SOURCE, 'utf8');

    // CONTROL — unmutated, the parse resolves real rows. Without this arm the
    // three throws below would be indistinguishable from a broken parser that
    // never resolves anything.
    expect(parseProseDispatchTable(markdown, SKILL_LABEL).rows.length).toBeGreaterThan(0);

    // (a) RENAMED HEADING — the anchor moves and the section is gone.
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

    // (b) ZERO DATA ROWS — header and delimiter survive, every row is deleted.
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
    // The fixture must actually have removed the rows it claims to remove.
    expect(dropped).toBe(boundShapes.size);
    expect(() => parseProseDispatchTable(kept.join('\n'), '<zero-row fixture>')).toThrow(
      /resolved ZERO data rows/,
    );

    // (c) REFORMATTED TABLE — the delimiter row is replaced by a sentence, so
    //     the pipe block is no longer a table at all.
    const reformatted = withDelimiterRowRemoved(markdown);
    expect(reformatted).not.toBe(markdown);
    expect(() => parseProseDispatchTable(reformatted, '<reformatted fixture>')).toThrow(
      /exactly ONE posture table/,
    );
  });
});
