/**
 * Operational-resilience checker. It scans the added lines of a unified diff for these
 * error-handling anti-patterns:
 *
 * - Empty catch blocks
 * - Swallowed errors (a catch without a throw, a log, an error return, or a reject)
 * - `console.log` in non-test source files
 * - Unbounded retry loops (`while(true)` or `for(;;)` without a break or a maximum)
 *
 * It reads only the diff, not the file system.
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
      if (currentName) {
        const addedLines = currentAdded;
        files.push({
          name: currentName,
          addedLines,
          addedText: addedLines.join('\n'),
        });
      }
      currentName = headerMatch[1] ?? '';
      currentAdded = [];
      continue;
    }

    if (line.startsWith('+++')) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('++')) {
      currentAdded.push(line.slice(1));
    }
  }

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
 * Check 2: swallowed errors. It flags a catch when the 10 added lines from its `catch` keyword hold
 * no error-handling pattern. It skips empty catches and each file already flagged for an empty
 * catch.
 */
function checkSwallowedErrors(
  files: readonly ParsedFile[],
  emptyCatchFiles: ReadonlySet<string>,
): OperationalResilienceFinding[] {
  const findings: OperationalResilienceFinding[] = [];

  for (const file of files) {
    if (!isSourceFile(file.name)) continue;
    if (emptyCatchFiles.has(file.name)) continue;

    const lines = file.addedLines;
    for (let i = 0; i < lines.length; i++) {
      if (!HAS_CATCH_RE.test(lines[i] ?? '')) continue;
      if (EMPTY_CATCH_RE.test(lines.slice(i, i + 3).join(' '))) continue;

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
 * Check 4: unbounded retry loops in non-test source files. The bound check reads only the 20 added
 * lines from the loop header. An unrelated `break` elsewhere in the file thus does not hide an
 * unbounded loop.
 */
function checkUnboundedRetries(files: readonly ParsedFile[]): OperationalResilienceFinding[] {
  const findings: OperationalResilienceFinding[] = [];

  for (const file of files) {
    if (!isSourceFile(file.name)) continue;
    if (isTestFile(file.name)) continue;

    const lines = file.addedLines;
    for (let i = 0; i < lines.length; i++) {
      if (!UNBOUNDED_LOOP_RE.test(lines[i] ?? '')) continue;

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

/**
 * Runs all operational-resilience checks on a unified diff string. The empty-catch check runs
 * first. The swallowed-error check then skips the files that it flagged, with the names read from
 * the finding messages.
 *
 * @param diff - A unified diff string (as produced by `git diff`).
 * @returns The aggregated check result.
 */
export function checkOperationalResilience(diff: string): OperationalResilienceResult {
  if (!diff.trim()) {
    return { pass: true, findingCount: 0, findings: [] };
  }

  const files = parseDiff(diff);

  const emptyCatchFindings = checkEmptyCatchBlocks(files);
  const emptyCatchFiles = new Set(
    emptyCatchFindings.map((f) => {
      const match = f.message.match(/^`(.+?)`/);
      return match ? (match[1] ?? '') : '';
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
