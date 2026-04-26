/**
 * README capability matrix validation.
 *
 * Asserts that the runtime × capability matrix in the README matches the
 * `supportedCapabilities` declared in each `runtimes/<name>.yaml`. This
 * catches drift when a runtime YAML is updated without re-rendering the
 * matrix in the README, per Task 15 of
 * docs/plans/2026-04-25-delegation-runtime-parity.md.
 *
 * Approach (Option A — hand-authored): the README owns the table; this
 * test compares each cell against the YAML source-of-truth using anchors
 * so a future README reorg can't silently turn this into a vacuous pass.
 *
 * Glyph contract:
 *   - `●` → `native` (declared as `native` in YAML)
 *   - `◐` → `advisory` (declared as `advisory` in YAML)
 *   - `○` → unsupported (omitted from YAML — consumers detect by absence)
 *   - `–` → unknown (runtime YAML has no `supportedCapabilities` block at all)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadAllRuntimes } from './runtimes/load.js';
import type { SupportedCapabilityName } from './runtimes/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const README_PATH = resolve(REPO_ROOT, 'README.md');
const RUNTIMES_DIR = resolve(REPO_ROOT, 'runtimes');

const NATIVE_GLYPH = '●'; // ●
const ADVISORY_GLYPH = '◐'; // ◐
const UNSUPPORTED_GLYPH = '○'; // ○
const UNKNOWN_GLYPH = '–'; // –

const BEGIN_MARKER = '<!-- BEGIN-CAPABILITY-MATRIX -->';
const END_MARKER = '<!-- END-CAPABILITY-MATRIX -->';

/**
 * The canonical capability ordering rendered in the README. Mirrors
 * `SupportedCapabilityKey` in `src/runtimes/types.ts`.
 */
const CAPABILITY_ORDER: readonly SupportedCapabilityName[] = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'subagent:completion-signal',
  'subagent:start-signal',
  'mcp:exarchos',
  'isolation:worktree',
  'team:agent-teams',
  'session:resume',
];

/**
 * Slice the capability matrix block out of README.md by anchor markers.
 * Throws if either marker is missing so a future README reorg fails this
 * test loudly rather than silently passing.
 */
function readMatrixBlock(content: string): string {
  const begin = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (begin === -1) {
    throw new Error(`README.md is missing "${BEGIN_MARKER}" anchor`);
  }
  if (end === -1) {
    throw new Error(`README.md is missing "${END_MARKER}" anchor`);
  }
  if (end < begin) {
    throw new Error(`README.md anchors out of order (END before BEGIN)`);
  }
  return content.slice(begin + BEGIN_MARKER.length, end);
}

/**
 * Parse a markdown pipe-table from the matrix block. Returns
 * `{ header: string[], rows: Array<{ capability: string, cells: string[] }> }`.
 * Skips the alignment row (`|---|`).
 */
function parseTable(block: string): {
  header: string[];
  rows: { capability: string; cells: string[] }[];
} {
  const tableLineRe = /^\s*\|.*\|\s*$/;
  const lines = block
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => tableLineRe.test(l));

  if (lines.length < 3) {
    throw new Error(
      `Capability matrix block must contain a table with header + alignment + at least one row (got ${lines.length} table lines)`,
    );
  }

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());

  const header = splitRow(lines[0]!);
  // lines[1] is the alignment row; skip.
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    return { capability: cells[0]!, cells: cells.slice(1) };
  });

  return { header, rows };
}

/**
 * Map a YAML support level (or absence) to its README glyph.
 */
function glyphFor(
  level: 'native' | 'advisory' | undefined,
  hasSupportedCapabilities: boolean,
): string {
  if (!hasSupportedCapabilities) return UNKNOWN_GLYPH;
  if (level === 'native') return NATIVE_GLYPH;
  if (level === 'advisory') return ADVISORY_GLYPH;
  return UNSUPPORTED_GLYPH;
}

describe('README capability matrix', () => {
  it('Readme_CapabilityMatrix_MatchesRuntimeYaml', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const block = readMatrixBlock(readme);
    const { header, rows } = parseTable(block);

    const runtimes = loadAllRuntimes(RUNTIMES_DIR);
    const runtimesByName = new Map(runtimes.map((r) => [r.name, r]));

    // Header column 0 is the capability label (e.g. "Capability"); columns 1+
    // are runtime names. Verify the runtime columns map to known runtimes.
    const runtimeColumns = header.slice(1).map((h) => {
      // Strip markdown bold/emphasis around the runtime name.
      return h.replace(/\*\*/g, '').toLowerCase();
    });

    expect(runtimeColumns.length).toBeGreaterThan(0);
    for (const col of runtimeColumns) {
      expect(
        runtimesByName.has(col),
        `Matrix header references unknown runtime "${col}". Known: ${[...runtimesByName.keys()].join(', ')}`,
      ).toBe(true);
    }

    // Every capability in the canonical ordering must appear as a row.
    const rowCapabilities = rows.map((r) => r.capability);
    for (const cap of CAPABILITY_ORDER) {
      expect(
        rowCapabilities.includes(cap),
        `Matrix is missing row for capability "${cap}"`,
      ).toBe(true);
    }

    // Per-cell comparison.
    for (const row of rows) {
      const cap = row.capability as SupportedCapabilityName;
      expect(
        CAPABILITY_ORDER.includes(cap),
        `Matrix row "${row.capability}" is not in the canonical capability vocabulary`,
      ).toBe(true);

      expect(
        row.cells.length,
        `Matrix row "${cap}" has ${row.cells.length} cells but header has ${runtimeColumns.length} runtime columns`,
      ).toBe(runtimeColumns.length);

      for (let i = 0; i < runtimeColumns.length; i++) {
        const runtimeName = runtimeColumns[i]!;
        const runtime = runtimesByName.get(runtimeName)!;
        const supportMap = runtime.supportedCapabilities;
        const expectedGlyph = glyphFor(supportMap?.[cap], supportMap !== undefined);
        const actualGlyph = row.cells[i]!;
        expect(
          actualGlyph,
          `Cell mismatch at row "${cap}" × column "${runtimeName}": README has "${actualGlyph}", YAML implies "${expectedGlyph}"`,
        ).toBe(expectedGlyph);
      }
    }
  });

  it('Readme_CapabilityMatrix_HasLegend', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const block = readMatrixBlock(readme);

    // Legend must mention each glyph at least once with its meaning.
    for (const [glyph, meaning] of [
      [NATIVE_GLYPH, 'native'],
      [ADVISORY_GLYPH, 'advisory'],
      [UNSUPPORTED_GLYPH, 'unsupported'],
    ] as const) {
      expect(
        block.includes(glyph),
        `Capability matrix legend missing glyph "${glyph}" (${meaning})`,
      ).toBe(true);
      expect(
        new RegExp(`\\b${meaning}\\b`, 'i').test(block),
        `Capability matrix legend missing word "${meaning}"`,
      ).toBe(true);
    }
  });
});
