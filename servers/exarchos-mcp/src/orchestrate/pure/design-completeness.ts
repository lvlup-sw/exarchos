// ─── Design Completeness — Pure TypeScript Validation ───────────────────────
//
// Ported from scripts/verify-ideate-artifacts.sh — validates design document
// completeness at the ideate->plan boundary. No bash/execFileSync dependency.
//
// Exported functions:
//   resolveDesignFile    — locate the design document via explicit path, state file, or docs dir
//   checkRequiredSections — verify 7 required markdown sections (case-insensitive)
//   checkMultipleOptions — verify >= 2 option headings
//   checkStateDesignPath — read artifacts.design from state JSON
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

  // Read design content
  const content = readFileSync(designPath, 'utf-8');

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
