/**
 * Operational Resilience checker — pure TypeScript port of check-operational-resilience.sh.
 *
 * Scans a unified diff for anti-patterns in error handling:
 * - Empty catch blocks
 * - Swallowed errors (catch without rethrow/log/return)
 * - console.log in production source files
 * - Unbounded retry loops (while(true)/for(;;) without break/max)
 *
 * Operates in diff-only mode (no filesystem access required).
 */

/** Severity levels for findings. */
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

/** A single operational-resilience finding. */
export interface OperationalResilienceFinding {
  readonly severity: Severity;
  readonly message: string;
}

/** Result of running the operational-resilience checks. */
export interface OperationalResilienceResult {
  /** Whether all checks passed (no findings). */
  readonly pass: boolean;
  /** Total number of findings. */
  readonly findingCount: number;
  /** Individual findings, empty when pass === true. */
  readonly findings: readonly OperationalResilienceFinding[];
}

// ============================================================
// Internal: diff parsing
// ============================================================

interface ParsedFile {
  readonly name: string;
  readonly addedLines: readonly string[];
  /** The added lines joined as a single string for regex matching. */
  readonly addedText: string;
}

/**
 * Parse a unified diff into per-file added-line arrays.
 *
 * Only lines starting with `+` (excluding `+++` header lines) are counted
 * as added lines.
 */
function parseDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let currentName = '';
  let currentAdded: string[] = [];

  for (const line of diff.split('\n')) {
    const headerMatch = line.match(/^diff --git a\/(.+?) b\//);
    if (headerMatch) {
      // Flush previous file
      if (currentName) {
        const addedLines = currentAdded;
        files.push({
          name: currentName,
          addedLines,
          addedText: addedLines.join('\n'),
        });
      }
      currentName = headerMatch[1];
      currentAdded = [];
      continue;
    }

    // Skip +++ header lines
    if (line.startsWith('+++')) {
      continue;
    }

    // Count added lines (start with + but not ++)
    if (line.startsWith('+') && !line.startsWith('++')) {
      currentAdded.push(line.slice(1));
    }
  }

  // Flush last file
  if (currentName) {
    const addedLines = currentAdded;
    files.push({
      name: currentName,
      addedLines,
      addedText: addedLines.join('\n'),
    });
  }

  return files;
}

/** Check if a file is a TypeScript or JavaScript source file. */
function isSourceFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js');
}

/** Check if a file is a test file. */
function isTestFile(name: string): boolean {
  return (
    name.includes('.test.') ||
    name.includes('.spec.') ||
    name.includes('__tests__')
  );
}

// ============================================================
// Individual checks
// ============================================================

// Regex patterns ported from the bash grep -E patterns

/** Matches empty catch blocks: catch (...) { } or catch { } */
const EMPTY_CATCH_RE = /catch\s*(\([^)]*\))?\s*\{\s*\}/;

/** Matches the word 'catch' */
const HAS_CATCH_RE = /\bcatch\b/;

/** Matches error handling patterns (throw, console., return...err, reject) */
const ERROR_HANDLING_RE = /\bthrow\b|console\.|return\b.*[Ee]rr|\breject\b/;

/** Matches console.log specifically */
const CONSOLE_LOG_RE = /\bconsole\.log\b/;

/** Matches unbounded loop patterns */
const UNBOUNDED_LOOP_RE = /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/;

/** Matches patterns that bound a loop */
const LOOP_BOUND_RE = /\bbreak\b|maxRetries|MAX_|max_retries|maxAttempts/i;

/**
 * Check 1: Empty catch blocks.
 */
function checkEmptyCatchBlocks(files: readonly ParsedFile[]): OperationalResilienceFinding[] {
  const findings: OperationalResilienceFinding[] = [];

  for (const file of files) {
    if (!isSourceFile(file.name)) continue;

    if (EMPTY_CATCH_RE.test(file.addedText)) {
      findings.push({
        severity: 'HIGH',
        message: `\`${file.name}\` — Empty catch block detected`,
      });
    }
  }

  return findings;
}

/**
 * Check 2: Swallowed errors — catch blocks without rethrow/log/return.
 *
 * Scans per-catch-block by splitting added lines around `catch` keywords
 * and checking each block individually for error handling patterns.
 * Files already flagged for empty catch blocks are excluded to avoid
 * double-reporting.
 */
function checkSwallowedErrors(
  files: readonly ParsedFile[],
  emptyCatchFiles: ReadonlySet<string>,
): OperationalResilienceFinding[] {
  const findings: OperationalResilienceFinding[] = [];

  for (const file of files) {
    if (!isSourceFile(file.name)) continue;
    if (emptyCatchFiles.has(file.name)) continue;

    // Split added lines into segments around catch keywords and check each
    const lines = file.addedLines;
    for (let i = 0; i < lines.length; i++) {
      if (!HAS_CATCH_RE.test(lines[i])) continue;
      // Skip empty catches (handled by check 1)
      if (EMPTY_CATCH_RE.test(lines.slice(i, i + 3).join(' '))) continue;

      // Check the next ~10 lines for error handling within this catch block
      const catchContext = lines.slice(i, i + 10).join('\n');
      if (!ERROR_HANDLING_RE.test(catchContext)) {
        findings.push({
          severity: 'MEDIUM',
          message: `\`${file.name}\` — Possible swallowed error in catch block`,
        });
      }
    }
  }

  return findings;
}

/**
 * Check 3: console.log in non-test source files.
 */
function checkConsoleLog(files: readonly ParsedFile[]): OperationalResilienceFinding[] {
  const findings: OperationalResilienceFinding[] = [];

  for (const file of files) {
    if (!isSourceFile(file.name)) continue;
    if (isTestFile(file.name)) continue;

    if (CONSOLE_LOG_RE.test(file.addedText)) {
      findings.push({
        severity: 'MEDIUM',
        message: `\`${file.name}\` — console.log in source file`,
      });
    }
  }

  return findings;
}

/**
 * Check 4: Unbounded retry loops (while(true)/for(;;) without break/max).
 *
 * Checks for loop-bounding patterns within ~20 lines of the loop match
 * rather than file-wide, so an unrelated `break` elsewhere in the file
 * doesn't mask a genuinely unbounded loop.
 *
 * Skips test files.
 */
function checkUnboundedRetries(files: readonly ParsedFile[]): OperationalResilienceFinding[] {
  const findings: OperationalResilienceFinding[] = [];

  for (const file of files) {
    if (!isSourceFile(file.name)) continue;
    if (isTestFile(file.name)) continue;

    // Scan line-by-line so we can check nearby context for bounds
    const lines = file.addedLines;
    for (let i = 0; i < lines.length; i++) {
      if (!UNBOUNDED_LOOP_RE.test(lines[i])) continue;

      // Check ~20 lines after the loop header for bounding patterns
      const loopContext = lines.slice(i, i + 20).join('\n');
      if (!LOOP_BOUND_RE.test(loopContext)) {
        findings.push({
          severity: 'MEDIUM',
          message: `\`${file.name}\` — Unbounded retry loop (while(true)/for(;;) without break/max)`,
        });
      }
    }
  }

  return findings;
}

// ============================================================
// Public API
// ============================================================

/**
 * Run all operational-resilience checks on a unified diff string.
 *
 * @param diff - A unified diff string (as produced by `git diff`).
 * @returns The aggregated check result.
 */
export function checkOperationalResilience(diff: string): OperationalResilienceResult {
  if (!diff.trim()) {
    return { pass: true, findingCount: 0, findings: [] };
  }

  const files = parseDiff(diff);

  // Run empty catch check first so we can pass the set to swallowed errors
  const emptyCatchFindings = checkEmptyCatchBlocks(files);
  const emptyCatchFiles = new Set(
    emptyCatchFindings.map((f) => {
      // Extract file name from message: "`filename` — ..."
      const match = f.message.match(/^`(.+?)`/);
      return match ? match[1] : '';
    }),
  );

  const allFindings: OperationalResilienceFinding[] = [
    ...emptyCatchFindings,
    ...checkSwallowedErrors(files, emptyCatchFiles),
    ...checkConsoleLog(files),
    ...checkUnboundedRetries(files),
  ];

  return {
    pass: allFindings.length === 0,
    findingCount: allFindings.length,
    findings: allFindings,
  };
}
