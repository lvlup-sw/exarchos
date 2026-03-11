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
}

/**
 * Resolve the path to a design document using a priority chain:
 *   1. Explicit --design-file path
 *   2. artifacts.design from state JSON
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

  // 2. From state file — artifacts.design
  if (args.stateFile) {
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

/** Pattern matching a single design requirement line (e.g. `- DR-1: ...`). */
const DR_LINE_PATTERN = /^[-*]\s+(DR-\d+):/i;

/** Given/When/Then acceptance criteria keywords (case-insensitive, indented sub-bullet). */
const GIVEN_WHEN_THEN_PATTERN = /^\s+[-*]\s+(?:given|when|then)\s*:/im;

/** Bullet-point acceptance criteria header (case-insensitive, indented sub-bullet). */
const ACCEPTANCE_CRITERIA_HEADER_PATTERN = /^\s+[-*]\s+acceptance\s+criteria\s*:/im;

/** Markdown section heading at document level (not indented). */
const SECTION_HEADING_PATTERN = /^#{1,}\s+/;

/**
 * Check that each DR-N entry in the Requirements section has acceptance criteria.
 *
 * Accepts two formats:
 *   1. Given/When/Then — indented sub-bullets starting with Given:, When:, Then:
 *   2. Bullet-point — indented sub-bullet "Acceptance Criteria:" followed by list items
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
      drEntries.push({ id: match[1], lineIndex: i });
    }
  }

  if (drEntries.length === 0) {
    return { passed: true, missingCriteria: [] };
  }

  const missingCriteria: string[] = [];

  for (let idx = 0; idx < drEntries.length; idx++) {
    const startLine = drEntries[idx].lineIndex + 1;
    const endLine = findBlockEnd(lines, startLine, drEntries, idx);
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
 * Find the end line of a DR-N block: the next DR-N entry, a section heading, or EOF.
 */
function findBlockEnd(
  lines: readonly string[],
  startLine: number,
  drEntries: ReadonlyArray<{ id: string; lineIndex: number }>,
  currentIdx: number,
): number {
  // If there's a subsequent DR-N entry, its line is the boundary
  if (currentIdx + 1 < drEntries.length) {
    return drEntries[currentIdx + 1].lineIndex;
  }

  // Otherwise, scan for the next section heading
  for (let j = startLine; j < lines.length; j++) {
    if (SECTION_HEADING_PATTERN.test(lines[j]) && !lines[j].startsWith(' ')) {
      return j;
    }
  }

  return lines.length;
}

/** Test whether a text block contains any recognized acceptance criteria format. */
function hasAcceptanceCriteria(block: string): boolean {
  return GIVEN_WHEN_THEN_PATTERN.test(block) || ACCEPTANCE_CRITERIA_HEADER_PATTERN.test(block);
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

  // Check 4: State file has design path
  if (args.stateFile) {
    const stateResult = checkStateDesignPath(args.stateFile);
    if (stateResult.passed) {
      passCount++;
    } else {
      failCount++;
      findings.push(stateResult.error ?? 'State file missing design path');
    }
  }

  // Check 5: Acceptance criteria on DR-N entries (advisory — does not affect pass/fail)
  const criteriaResult = checkAcceptanceCriteria(content);
  if (!criteriaResult.passed && criteriaResult.missingCriteria.length > 0) {
    findings.push(
      `Advisory: DR entries missing acceptance criteria: ${criteriaResult.missingCriteria.join(', ')}`,
    );
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
