// ─── Design Completeness — Pure TypeScript Validation ───────────────────────
//
// Ported from scripts/verify-ideate-artifacts.sh — validates design document
// completeness at the ideate->plan boundary. No bash/execFileSync dependency.
//
// Exported functions:
//   resolveDesignFile      — locate the design document via explicit path, state file, or docs dir
//   checkRequiredSections  — verify 7 required markdown sections (case-insensitive)
//   checkMultipleOptions   — verify >= 2 option headings
//   checkAcceptanceCriteria — verify DR-N entries have acceptance criteria (Given/When/Then or bullet-point)
//   checkStateDesignPath   — read artifacts.design from state JSON
//   handleDesignCompleteness — orchestrate all checks, return structured result
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Result Types ───────────────────────────────────────────────────────────

export interface SectionsResult {
  readonly passed: boolean;
  readonly missing: readonly string[];
}

export interface OptionsResult {
  readonly passed: boolean;
  readonly count: number;
}

export interface StateDesignPathResult {
  readonly passed: boolean;
  readonly designPath?: string;
  readonly error?: string;
}

export interface AcceptanceCriteriaResult {
  readonly passed: boolean;
  readonly missingCriteria: readonly string[];
}

export interface DesignCompletenessResult {
  readonly passed: boolean;
  readonly advisory: boolean;
  readonly findings: readonly string[];
  readonly checkCount: number;
  readonly passCount: number;
  readonly failCount: number;
}

// ─── Required Sections ──────────────────────────────────────────────────────

const REQUIRED_SECTIONS = [
  'Problem Statement',
  'Requirements',
  'Chosen Approach',
  'Technical Design',
  'Integration Points',
  'Testing Strategy',
  'Open Questions',
] as const;

// ─── resolveDesignFile ──────────────────────────────────────────────────────

export interface ResolveDesignFileArgs {
  readonly designFile?: string;
  readonly stateFile?: string;
  readonly docsDir?: string;
  /**
   * Pre-resolved `artifacts.design` path from the workflow state, supplied by
   * the orchestrate layer after materializing state via `resolveWorkflowState`
   * (file → event-store fallback). When provided, it takes precedence over
   * re-reading `stateFile` from disk, so the gate works for MCP-only workflows
   * that never wrote a `.state.json` stamp (INV-1). `null` means "state was
   * resolved but recorded no design path"; `undefined` means "not supplied —
   * fall back to reading `stateFile`".
   */
  readonly designPathFromState?: string | null;
}

/**
 * Resolve the path to a design document using a priority chain:
 *   1. Explicit --design-file path
 *   2. artifacts.design (pre-resolved from event-store state, or read from the
 *      state file)
 *   3. Latest YYYY-MM-DD-*.md in docs directory
 *
 * Returns the resolved path, or undefined if no design file can be found.
 */
export function resolveDesignFile(args: ResolveDesignFileArgs): string | undefined {
  // 1. Explicit design file path
  if (args.designFile) {
    if (existsSync(args.designFile)) {
      return args.designFile;
    }
    return undefined;
  }

  // 2a. Pre-resolved artifacts.design from event-store state (INV-1).
  if (args.designPathFromState !== undefined) {
    if (
      args.designPathFromState &&
      args.designPathFromState.length > 0 &&
      existsSync(args.designPathFromState)
    ) {
      return args.designPathFromState;
    }
  } else if (args.stateFile) {
    // 2b. Legacy: read artifacts.design from the state file on disk.
    const stateResult = checkStateDesignPath(args.stateFile);
    if (stateResult.passed && stateResult.designPath && existsSync(stateResult.designPath)) {
      return stateResult.designPath;
    }
  }

  // 3. Search docs dir for YYYY-MM-DD-*.md pattern, return latest by date
  if (args.docsDir && existsSync(args.docsDir)) {
    const datePattern = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
    const entries = readdirSync(args.docsDir).filter((f) => datePattern.test(f));

    if (entries.length > 0) {
      // Sort descending by filename (date prefix sorts lexicographically)
      entries.sort((a, b) => b.localeCompare(a));
      return join(args.docsDir, entries[0]);
    }
  }

  return undefined;
}

// ─── checkRequiredSections ──────────────────────────────────────────────────

/**
 * Check that all 7 required design sections are present in the content.
 * Matching is case-insensitive and looks for `## Section Name` markdown headings.
 */
export function checkRequiredSections(content: string): SectionsResult {
  const missing: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
    // Match ## (or ###, ####) followed by optional whitespace then section name, case-insensitive
    const pattern = new RegExp(`^#{2,}\\s+${escapeRegex(section)}`, 'im');
    if (!pattern.test(content)) {
      missing.push(section);
    }
  }

  return {
    passed: missing.length === 0,
    missing,
  };
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── checkMultipleOptions ───────────────────────────────────────────────────

/**
 * Count option headings (e.g. `### Option 1`, `### Option 2`) and verify >= 2.
 */
export function checkMultipleOptions(content: string): OptionsResult {
  // Match headings like: ### Option 1, ## Option 2, ### Option [1]
  const optionPattern = /^#{1,}\s+option\s+\[?\d+/gim;
  const matches = content.match(optionPattern);
  const count = matches ? matches.length : 0;

  return {
    passed: count >= 2,
    count,
  };
}

// ─── checkAcceptanceCriteria ─────────────────────────────────────────────────

/** Pattern matching a design requirement line — list item (`- DR-1:`) or heading (`### DR-1:`). */
const DR_LINE_PATTERN = /(?:^[-*]\s+(DR-\d+):|^#{1,}\s+(DR-\d+):)/i;

/**
 * Acceptance-criteria header shapes, in parity with the shell checker
 * `scripts/check-design-completeness.sh` (line ~149):
 *   grep -qiE '^\*\*[Aa]cceptance [Cc]riteri|^#+\s*[Aa]cceptance [Cc]riteri|^-\s*\*\*[Aa]cceptance'
 *
 * The template (skills-src/ideate/references/design-template.md, lines 51/87)
 * mandates the standalone bold `**Acceptance criteria:**` header, so we MUST accept
 * it. We also keep the pre-existing bullet-prefixed form (`- Acceptance Criteria:`)
 * that the TS parser historically recognized.
 */
const ACCEPTANCE_CRITERIA_HEADER_SHAPES = [
  // Standalone bold header — `**Acceptance criteria:**` (template-mandated)
  // Parity: `^\*\*[Aa]cceptance [Cc]riteri`
  /^\s*\*\*\s*acceptance\s+criteri/im,
  // Heading form — `#### Acceptance criteria`
  // Parity: `^#+\s*[Aa]cceptance [Cc]riteri`
  /^\s*#{1,}\s*acceptance\s+criteri/im,
  // Bullet-bold form — `- **Acceptance criteria**`
  // Parity: `^-\s*\*\*[Aa]cceptance`
  /^\s*[-*]\s*\*\*\s*acceptance/im,
  // Pre-existing bullet-prefixed form — `- Acceptance Criteria:` (indented or plain)
  // (No direct shell analogue; retained so prior TS behavior is preserved.)
  /^\s*[-*]\s+acceptance\s+criteria\s*:?/im,
] as const;

/** Markdown section heading at document level (not indented). */
const SECTION_HEADING_PATTERN = /^#{1,}\s+/;

/**
 * Check that each DR-N entry in the Requirements section has acceptance criteria.
 *
 * Accepts (in parity with scripts/check-design-completeness.sh and the
 * design-template.md mandated shapes):
 *   1. Structural header — bold `**Acceptance criteria:**`, heading
 *      `#### Acceptance criteria`, bullet-bold `- **Acceptance criteria**`,
 *      or the legacy bullet `- Acceptance Criteria:` form.
 *   2. Given/When/Then — single-line (`- Given …, when …, then …`),
 *      three separate `- Given` / `- When` / `- Then` bullets, OR a bulleted
 *      `- Given …` with non-bulleted indented `When …` / `Then …` continuation
 *      lines (the template-preferred form).
 *
 * Returns the list of DR-N identifiers that lack any acceptance criteria.
 * If no DR-N entries are found, the check passes vacuously.
 */
export function checkAcceptanceCriteria(content: string): AcceptanceCriteriaResult {
  const lines = content.split('\n');

  // Collect all DR-N entries with their line positions
  const drEntries: Array<{ id: string; lineIndex: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = DR_LINE_PATTERN.exec(lines[i]);
    if (match) {
      drEntries.push({ id: match[1] ?? match[2], lineIndex: i });
    }
  }

  if (drEntries.length === 0) {
    return { passed: true, missingCriteria: [] };
  }

  const missingCriteria: string[] = [];

  for (let idx = 0; idx < drEntries.length; idx++) {
    const drLine = lines[drEntries[idx].lineIndex];
    const startLine = drEntries[idx].lineIndex + 1;
    const endLine = findBlockEnd(lines, startLine, drEntries, idx, headingLevel(drLine));
    const block = lines.slice(startLine, endLine).join('\n');

    if (!hasAcceptanceCriteria(block)) {
      missingCriteria.push(drEntries[idx].id);
    }
  }

  return {
    passed: missingCriteria.length === 0,
    missingCriteria,
  };
}

/**
 * The advisory finding string for DR-N entries lacking acceptance criteria
 * (Given/When/Then, or a structural acceptance-criteria header), or `null` when
 * every DR-N entry carries criteria — or there are no DR-N entries at all.
 *
 * Extracted as the SINGLE source of this finding string so the standalone
 * design-completeness gate (Check 5 in {@link handleDesignCompleteness}) and
 * `check_plan_coverage`'s folded reproduction of it on the unified
 * `docs/specs/` artifact (DR-6 gate fold, #1581 task 011) cannot drift apart.
 */
export function acceptanceCriteriaFinding(content: string): string | null {
  const result = checkAcceptanceCriteria(content);
  if (result.passed || result.missingCriteria.length === 0) {
    return null;
  }
  return `Advisory: DR entries missing acceptance criteria: ${result.missingCriteria.join(', ')}`;
}

/**
 * Heading level of a line — number of leading `#` for a markdown heading, or 0
 * if the line is not a (non-indented) heading. A bullet-form DR (`- DR-1:`) has
 * level 0; a heading-form DR (`### DR-1:`) has its hash count.
 */
function headingLevel(line: string): number {
  const match = /^(#{1,})\s+/.exec(line);
  return match ? match[1].length : 0;
}

/**
 * Find the end line of a DR-N block: the next DR-N entry, a sibling/parent
 * section heading, or EOF.
 *
 * `drLevel` is the heading level of the DR entry itself (0 for bullet-form DRs).
 * A heading DEEPER than the DR (e.g. `#### Acceptance criteria` under a
 * `### DR-1:`) is a child of the DR and does NOT terminate the block — this is
 * what lets the template's `#### Acceptance criteria` sub-heading stay inside
 * the DR block. Bullet-form DRs (level 0) terminate at any top-level heading.
 */
function findBlockEnd(
  lines: readonly string[],
  startLine: number,
  drEntries: ReadonlyArray<{ id: string; lineIndex: number }>,
  currentIdx: number,
  drLevel: number,
): number {
  // If there's a subsequent DR-N entry, its line is the boundary
  if (currentIdx + 1 < drEntries.length) {
    return drEntries[currentIdx + 1].lineIndex;
  }

  // Otherwise, scan for the next sibling/parent section heading. A deeper
  // sub-heading (level > drLevel) belongs to this DR and is not a boundary.
  for (let j = startLine; j < lines.length; j++) {
    if (SECTION_HEADING_PATTERN.test(lines[j]) && !lines[j].startsWith(' ')) {
      const level = headingLevel(lines[j]);
      if (level > 0 && level <= drLevel) {
        return j;
      }
      if (drLevel === 0) {
        // Bullet-form DR: any non-indented heading terminates the block.
        return j;
      }
    }
  }

  return lines.length;
}

/** Single-line Given/When/Then on one bullet — `- Given X, when Y, then Z`. */
const SINGLE_LINE_GWT_PATTERN = /^\s*[-*]\s+given\b.*\bwhen\b.*\bthen\b/im;

/**
 * Continuation-line When/Then — a non-bulleted, indented continuation of a
 * preceding `- Given …` bullet (the template's preferred GWT form, see
 * design-template.md). E.g. `  When …` / `  Then …` with leading whitespace
 * and NO list marker.
 */
const CONTINUATION_WHEN_PATTERN = /^\s+when\b/im;
const CONTINUATION_THEN_PATTERN = /^\s+then\b/im;

/** Test whether a text block contains any recognized acceptance criteria format. */
function hasAcceptanceCriteria(block: string): boolean {
  // 1. Structural acceptance-criteria header (bold / heading / bullet-bold / bullet).
  if (ACCEPTANCE_CRITERIA_HEADER_SHAPES.some((pattern) => pattern.test(block))) {
    return true;
  }

  // 2. Single-line GWT — `- Given …, when …, then …` on one bullet.
  if (SINGLE_LINE_GWT_PATTERN.test(block)) {
    return true;
  }

  // 3. Three separate GWT bullets — `- Given`, `- When`, `- Then` (legacy form).
  const hasGivenBullet = /(?:^|\n)(?:\s+[-*]\s+|[-*]\s+)given\b/im.test(block);
  if (hasGivenBullet) {
    const hasWhenBullet = /(?:^|\n)(?:\s+[-*]\s+|[-*]\s+)when\b/im.test(block);
    const hasThenBullet = /(?:^|\n)(?:\s+[-*]\s+|[-*]\s+)then\b/im.test(block);
    if (hasWhenBullet && hasThenBullet) {
      return true;
    }
    // 4. Continuation-line GWT — bulleted Given followed by non-bulleted,
    //    indented When/Then continuation lines (template-preferred form).
    if (CONTINUATION_WHEN_PATTERN.test(block) && CONTINUATION_THEN_PATTERN.test(block)) {
      return true;
    }
  }

  return false;
}

// ─── checkStateDesignPath ───────────────────────────────────────────────────

/**
 * Read a state JSON file and extract `artifacts.design`.
 * Returns a failure result (without crashing) if the file is missing or invalid JSON.
 */
export function checkStateDesignPath(stateFile: string): StateDesignPathResult {
  if (!existsSync(stateFile)) {
    return { passed: false, error: `State file not found: ${stateFile}` };
  }

  let raw: string;
  try {
    raw = readFileSync(stateFile, 'utf-8');
  } catch {
    return { passed: false, error: `Cannot read state file: ${stateFile}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { passed: false, error: `Invalid JSON in state file: ${stateFile}` };
  }

  // Navigate to artifacts.design safely
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'artifacts' in parsed &&
    typeof (parsed as Record<string, unknown>).artifacts === 'object' &&
    (parsed as Record<string, unknown>).artifacts !== null
  ) {
    const artifacts = (parsed as Record<string, Record<string, unknown>>).artifacts;
    const designPath = artifacts.design;
    if (typeof designPath === 'string' && designPath.length > 0) {
      return { passed: true, designPath };
    }
  }

  return { passed: false, error: 'artifacts.design is empty or missing' };
}

// ─── handleDesignCompleteness ───────────────────────────────────────────────

export interface HandleDesignCompletenessArgs {
  readonly stateFile?: string;
  readonly designFile?: string;
  readonly docsDir?: string;
  /**
   * Pre-resolved `artifacts.design` from the workflow state (see
   * {@link ResolveDesignFileArgs.designPathFromState}). When supplied by the
   * orchestrate layer, Check 4 uses it instead of re-reading `stateFile`.
   */
  readonly designPathFromState?: string | null;
}

/**
 * Orchestrate all design-completeness checks and return a structured result.
 *
 * Checks:
 *   1. Design document exists (resolved via priority chain)
 *   2. Required sections present (7 sections, case-insensitive)
 *   3. Multiple options evaluated (>= 2)
 *   4. State file has design path recorded
 *   5. Acceptance criteria present on DR-N entries (advisory — does not fail the check)
 */
export function handleDesignCompleteness(args: HandleDesignCompletenessArgs): DesignCompletenessResult {
  const findings: string[] = [];
  let passCount = 0;
  let failCount = 0;

  // Check 1: Resolve design file
  const designPath = resolveDesignFile({
    designFile: args.designFile,
    stateFile: args.stateFile,
    docsDir: args.docsDir,
    designPathFromState: args.designPathFromState,
  });

  if (!designPath) {
    failCount++;
    findings.push('Design document not found');
    // Cannot continue without a design file
    return {
      passed: false,
      advisory: true,
      findings,
      checkCount: 1,
      passCount,
      failCount,
    };
  }

  passCount++;

  // Read design content (guard against race between existsSync and readFileSync)
  let content: string;
  try {
    content = readFileSync(designPath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failCount++;
    findings.push(`Failed to read design file: ${message}`);
    return {
      passed: false,
      advisory: true,
      findings,
      checkCount: passCount + failCount,
      passCount,
      failCount,
    };
  }

  // Check 2: Required sections
  const sectionsResult = checkRequiredSections(content);
  if (sectionsResult.passed) {
    passCount++;
  } else {
    failCount++;
    findings.push(`Required sections missing: ${sectionsResult.missing.join(', ')}`);
  }

  // Check 3: Multiple options
  const optionsResult = checkMultipleOptions(content);
  if (optionsResult.passed) {
    passCount++;
  } else {
    failCount++;
    findings.push(`Found ${optionsResult.count} option(s), expected at least 2`);
  }

  // Check 4: State records a design path
  // Prefer the pre-resolved value from event-store state (INV-1); fall back
  // to reading the state file when the orchestrate layer didn't supply one.
  if (args.designPathFromState !== undefined) {
    if (args.designPathFromState && args.designPathFromState.length > 0) {
      passCount++;
    } else {
      failCount++;
      findings.push('artifacts.design is empty or missing');
    }
  } else if (args.stateFile) {
    const stateResult = checkStateDesignPath(args.stateFile);
    if (stateResult.passed) {
      passCount++;
    } else {
      failCount++;
      findings.push(stateResult.error ?? 'State file missing design path');
    }
  }

  // Check 5: Acceptance criteria on DR-N entries (advisory — does not affect
  // pass/fail). Routed through the shared finding-string source so the folded
  // `check_plan_coverage` reproduction (DR-6, #1581 task 011) cannot drift.
  const acFinding = acceptanceCriteriaFinding(content);
  if (acFinding) {
    findings.push(acFinding);
  }

  const checkCount = passCount + failCount;

  return {
    passed: failCount === 0,
    advisory: true,
    findings,
    checkCount,
    passCount,
    failCount,
  };
}
