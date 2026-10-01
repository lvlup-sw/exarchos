/**
 * Design completeness checks at the boundary between ideate and plan. They read files but run no
 * shell command.
 *
 * {@link handleDesignCompleteness} runs the checks. It resolves the design file, then checks the
 * required sections, the option count, the design path in the state, and the acceptance criteria.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

const REQUIRED_SECTIONS = [
  'Problem Statement',
  'Requirements',
  'Chosen Approach',
  'Technical Design',
  'Integration Points',
  'Testing Strategy',
  'Open Questions',
] as const;

export interface ResolveDesignFileArgs {
  readonly designFile?: string | undefined;
  readonly stateFile?: string | undefined;
  readonly docsDir?: string | undefined;
  /**
   * The `artifacts.design` path that the orchestrate layer resolved from the workflow state. It
   * takes precedence over a read of `stateFile`, so the gate works for a workflow without a
   * `.state.json` file. `null` means that the state has no design path. `undefined` means that
   * the caller did not supply it, so the check reads `stateFile`.
   */
  readonly designPathFromState?: string | null | undefined;
}

/**
 * Resolves the design document path in this order:
 *   1. The explicit `designFile` path.
 *   2. `artifacts.design`, from `designPathFromState` or else from the state file.
 *   3. The latest `YYYY-MM-DD-*.md` file in the docs directory, by name.
 *
 * It returns `undefined` when it finds no design file. A missing explicit path also gives
 * `undefined`, with no fallback.
 */
export function resolveDesignFile(args: ResolveDesignFileArgs): string | undefined {
  if (args.designFile) {
    if (existsSync(args.designFile)) {
      return args.designFile;
    }
    return undefined;
  }

  if (args.designPathFromState !== undefined) {
    if (
      args.designPathFromState &&
      args.designPathFromState.length > 0 &&
      existsSync(args.designPathFromState)
    ) {
      return args.designPathFromState;
    }
  } else if (args.stateFile) {
    const stateResult = checkStateDesignPath(args.stateFile);
    if (stateResult.passed && stateResult.designPath && existsSync(stateResult.designPath)) {
      return stateResult.designPath;
    }
  }

  if (args.docsDir && existsSync(args.docsDir)) {
    const datePattern = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
    const entries = readdirSync(args.docsDir).filter((f) => datePattern.test(f));

    if (entries.length > 0) {
      entries.sort((a, b) => b.localeCompare(a));
      const latest = entries[0];
      if (latest !== undefined) return join(args.docsDir, latest);
    }
  }

  return undefined;
}

/**
 * Checks that the 7 required design sections are present. A match is a case-insensitive heading of
 * level 2 or deeper that starts with the section name.
 */
export function checkRequiredSections(content: string): SectionsResult {
  const missing: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
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

/**
 * Counts option headings, for example `### Option 1` or `## Option [2]`. The check passes at 2 or
 * more.
 */
export function checkMultipleOptions(content: string): OptionsResult {
  const optionPattern = /^#{1,}\s+option\s+\[?\d+/gim;
  const matches = content.match(optionPattern);
  const count = matches ? matches.length : 0;

  return {
    passed: count >= 2,
    count,
  };
}

/** Matches a design requirement line, as a list item (`- DR-N:`) or a heading (`### DR-N:`). */
const DR_LINE_PATTERN = /(?:^[-*]\s+(DR-\d+):|^#{1,}\s+(DR-\d+):)/i;

/** The acceptance-criteria header shapes, matched case-insensitively. */
const ACCEPTANCE_CRITERIA_HEADER_SHAPES = [
  /** Bold header: `**Acceptance criteria:**`. The design template requires this shape. */
  /^\s*\*\*\s*acceptance\s+criteri/im,
  /** Heading: a markdown heading of any level with the text `Acceptance criteria`. */
  /^\s*#{1,}\s*acceptance\s+criteri/im,
  /** Bold bullet: `- **Acceptance criteria**`. */
  /^\s*[-*]\s*\*\*\s*acceptance/im,
  /** Plain bullet: `- Acceptance Criteria:`, indented or not. */
  /^\s*[-*]\s+acceptance\s+criteria\s*:?/im,
] as const;

/** Markdown section heading at document level (not indented). */
const SECTION_HEADING_PATTERN = /^#{1,}\s+/;

/**
 * Checks that each `DR-N` entry in the document has acceptance criteria. Accepted forms:
 *   1. A header in {@link ACCEPTANCE_CRITERIA_HEADER_SHAPES}.
 *   2. Given/When/Then on one bullet, as three bullets, or as a `- Given` bullet with indented
 *      `When` and `Then` lines.
 *
 * It returns the `DR-N` ids without criteria. A document without `DR-N` entries passes.
 */
export function checkAcceptanceCriteria(content: string): AcceptanceCriteriaResult {
  const lines = content.split('\n');

  const drEntries: Array<{ id: string; lineIndex: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = DR_LINE_PATTERN.exec(line);
    if (match) {
      drEntries.push({ id: match[1] ?? match[2] ?? '', lineIndex: i });
    }
  }

  if (drEntries.length === 0) {
    return { passed: true, missingCriteria: [] };
  }

  const missingCriteria: string[] = [];

  for (let idx = 0; idx < drEntries.length; idx++) {
    const entry = drEntries[idx];
    if (entry === undefined) continue;
    const drLine = lines[entry.lineIndex];
    const startLine = entry.lineIndex + 1;
    const endLine = findBlockEnd(lines, startLine, drEntries, idx, headingLevel(drLine ?? ''));
    const block = lines.slice(startLine, endLine).join('\n');

    if (!hasAcceptanceCriteria(block)) {
      missingCriteria.push(entry.id);
    }
  }

  return {
    passed: missingCriteria.length === 0,
    missingCriteria,
  };
}

/**
 * The advisory finding for `DR-N` entries without acceptance criteria, or `null` when there are
 * none. It is the one source of this string for {@link handleDesignCompleteness} and for the same
 * check in `check_plan_coverage`.
 */
export function acceptanceCriteriaFinding(content: string): string | null {
  const result = checkAcceptanceCriteria(content);
  if (result.passed || result.missingCriteria.length === 0) {
    return null;
  }
  return `Advisory: DR entries missing acceptance criteria: ${result.missingCriteria.join(', ')}`;
}

/**
 * The heading level of a line: the count of leading `#`, or 0 when the line is not a non-indented
 * heading. A bullet entry (`- DR-N:`) thus has level 0.
 */
function headingLevel(line: string): number {
  const match = /^(#{1,})\s+/.exec(line);
  return match?.[1]?.length ?? 0;
}

/**
 * Finds the end line of a `DR-N` block: the next `DR-N` entry, a sibling or parent heading, or the
 * end of the file. `drLevel` is the heading level of the entry, 0 for a bullet.
 *
 * A deeper heading, for example `#### Acceptance criteria` under `### DR-N:`, stays inside the
 * block. A bullet entry ends at the next non-indented heading.
 */
function findBlockEnd(
  lines: readonly string[],
  startLine: number,
  drEntries: ReadonlyArray<{ id: string; lineIndex: number }>,
  currentIdx: number,
  drLevel: number,
): number {
  const nextEntry = drEntries[currentIdx + 1];
  if (nextEntry !== undefined) {
    return nextEntry.lineIndex;
  }

  for (let j = startLine; j < lines.length; j++) {
    const lineJ = lines[j];
    if (lineJ === undefined) continue;
    if (SECTION_HEADING_PATTERN.test(lineJ) && !lineJ.startsWith(' ')) {
      const level = headingLevel(lineJ);
      if (level > 0 && level <= drLevel) {
        return j;
      }
      if (drLevel === 0) {
        return j;
      }
    }
  }

  return lines.length;
}

/** Single-line Given/When/Then on one bullet — `- Given X, when Y, then Z`. */
const SINGLE_LINE_GWT_PATTERN = /^\s*[-*]\s+given\b.*\bwhen\b.*\bthen\b/im;

/**
 * An indented `When` line with no list marker, which continues a `- Given` bullet. The design
 * template prefers this form.
 */
const CONTINUATION_WHEN_PATTERN = /^\s+when\b/im;
/** An indented `Then` line with no list marker. */
const CONTINUATION_THEN_PATTERN = /^\s+then\b/im;

/**
 * True when a text block holds a recognized acceptance-criteria form. The indented `When` and `Then`
 * lines count only when the block also has a `- Given` bullet.
 */
function hasAcceptanceCriteria(block: string): boolean {
  if (ACCEPTANCE_CRITERIA_HEADER_SHAPES.some((pattern) => pattern.test(block))) {
    return true;
  }

  if (SINGLE_LINE_GWT_PATTERN.test(block)) {
    return true;
  }

  const hasGivenBullet = /(?:^|\n)(?:\s+[-*]\s+|[-*]\s+)given\b/im.test(block);
  if (hasGivenBullet) {
    const hasWhenBullet = /(?:^|\n)(?:\s+[-*]\s+|[-*]\s+)when\b/im.test(block);
    const hasThenBullet = /(?:^|\n)(?:\s+[-*]\s+|[-*]\s+)then\b/im.test(block);
    if (hasWhenBullet && hasThenBullet) {
      return true;
    }
    if (CONTINUATION_WHEN_PATTERN.test(block) && CONTINUATION_THEN_PATTERN.test(block)) {
      return true;
    }
  }

  return false;
}

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

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'artifacts' in parsed &&
    typeof (parsed as Record<string, unknown>).artifacts === 'object' &&
    (parsed as Record<string, unknown>).artifacts !== null
  ) {
    const artifacts = (parsed as Record<string, Record<string, unknown>>).artifacts;
    const designPath = artifacts?.design;
    if (typeof designPath === 'string' && designPath.length > 0) {
      return { passed: true, designPath };
    }
  }

  return { passed: false, error: 'artifacts.design is empty or missing' };
}

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
 * Runs the design-completeness checks and returns a structured result:
 *   1. The design document exists. Without it, the run stops.
 *   2. The 7 required sections are present.
 *   3. The document has at least 2 option headings.
 *   4. The state records a design path, from `designPathFromState` or else from `stateFile`.
 *   5. Each `DR-N` entry has acceptance criteria. This check is advisory and fails nothing.
 */
export function handleDesignCompleteness(args: HandleDesignCompletenessArgs): DesignCompletenessResult {
  const findings: string[] = [];
  let passCount = 0;
  let failCount = 0;

  const designPath = resolveDesignFile({
    designFile: args.designFile,
    stateFile: args.stateFile,
    docsDir: args.docsDir,
    designPathFromState: args.designPathFromState,
  });

  if (!designPath) {
    failCount++;
    findings.push('Design document not found');
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

  const sectionsResult = checkRequiredSections(content);
  if (sectionsResult.passed) {
    passCount++;
  } else {
    failCount++;
    findings.push(`Required sections missing: ${sectionsResult.missing.join(', ')}`);
  }

  const optionsResult = checkMultipleOptions(content);
  if (optionsResult.passed) {
    passCount++;
  } else {
    failCount++;
    findings.push(`Found ${optionsResult.count} option(s), expected at least 2`);
  }

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
