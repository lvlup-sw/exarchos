/**
 * Workflow Determinism Check
 *
 * Scans code changes (unified diff) for non-deterministic patterns
 * and test hygiene issues. Ported from scripts/check-workflow-determinism.sh.
 *
 * Detected patterns:
 *   - .only/.skip in tests (HIGH)
 *   - Non-deterministic time usage in tests (MEDIUM)
 *   - Non-deterministic random usage in tests (MEDIUM)
 *   - Debug artifacts in test files (LOW)
 *
 * Exit code semantics (when used as a gate):
 *   0 = no findings
 *   1 = findings detected
 */

// ============================================================
// Types
// ============================================================

export interface WorkflowDeterminismOptions {
  /** Raw unified diff content to scan. */
  diffContent: string;
}

export interface WorkflowDeterminismResult {
  status: 'pass' | 'findings';
  findingCount: number;
  findings: string[];
  passedChecks: number;
  totalChecks: number;
  report: string;
}

// ============================================================
// Pattern detection regexes
// ============================================================

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

const ONLY_SKIP_PATTERN = /\b(describe|it|test)\.(only|skip)\b/;
const DATE_NOW_PATTERN = /\bDate\.now\(\)|\bnew Date\(\)/;
const FAKE_TIMERS_PATTERN = /vi\.(useFakeTimers|setSystemTime|getRealSystemTime)/;
const MATH_RANDOM_PATTERN = /\bMath\.random\(\)/;
const RANDOM_MOCK_PATTERN = /vi\.(fn|spyOn|mock).*Math\.random|seed|mockRandom/;
const DEBUG_ARTIFACT_PATTERN = /\bconsole\.(log|debug|info|warn)\b|\bdebugger\b/;

// ============================================================
// Helpers
// ============================================================

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

interface Finding {
  file: string;
  line: number;
  pattern: string;
  severity: string;
  context: string;
}

// ============================================================
// Core logic
// ============================================================

export function checkWorkflowDeterminism(
  options: WorkflowDeterminismOptions
): WorkflowDeterminismResult {
  const { diffContent } = options;

  const findings: Finding[] = [];

  // Track per-check state
  let hasOnlySkip = false;
  let hasTimeIssue = false;
  let hasRandomIssue = false;
  let hasDebugArtifact = false;

  // Scan the diff
  let currentFile = '';
  let diffLineNum = 0;
  let fileContext = '';

  const lines = diffContent.split('\n');

  for (const line of lines) {
    // Track current file from diff headers
    const fileMatch = line.match(/^diff --git a\/(.+) b\//);
    if (fileMatch) {
      currentFile = fileMatch[1];
      diffLineNum = 0;
      fileContext = '';
      continue;
    }

    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      diffLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip non-addition lines but still track line numbers
    if (!line.startsWith('+')) {
      if (!line.startsWith('-')) {
        diffLineNum++;
      }
      // Track context lines for nearby-mock detection
      if (/^\s/.test(line)) {
        fileContext += line + '\n';
      }
      continue;
    }

    // Skip +++ header lines
    if (line.startsWith('+++')) {
      continue;
    }

    const addedLine = line.substring(1); // Strip leading +
    fileContext += addedLine + '\n';

    // Only check test files for patterns
    if (isTestFile(currentFile)) {
      // Pattern 1: .only/.skip in tests (HIGH)
      if (ONLY_SKIP_PATTERN.test(addedLine)) {
        findings.push({
          file: currentFile,
          line: diffLineNum,
          pattern: 'Test focus/skip modifier',
          severity: 'HIGH',
          context: truncate(addedLine, 120),
        });
        hasOnlySkip = true;
      }

      // Pattern 2: Non-deterministic time (MEDIUM)
      if (DATE_NOW_PATTERN.test(addedLine)) {
        // Check surrounding context for timer mocking
        if (!FAKE_TIMERS_PATTERN.test(fileContext)) {
          findings.push({
            file: currentFile,
            line: diffLineNum,
            pattern: 'Non-deterministic time without fake timers',
            severity: 'MEDIUM',
            context: truncate(addedLine, 120),
          });
          hasTimeIssue = true;
        }
      }

      // Pattern 3: Non-deterministic random (MEDIUM)
      if (MATH_RANDOM_PATTERN.test(addedLine)) {
        // Check surrounding context for seed/mock
        if (!RANDOM_MOCK_PATTERN.test(fileContext)) {
          findings.push({
            file: currentFile,
            line: diffLineNum,
            pattern: 'Non-deterministic Math.random() without mock',
            severity: 'MEDIUM',
            context: truncate(addedLine, 120),
          });
          hasRandomIssue = true;
        }
      }

      // Pattern 4: Debug artifacts in test files (LOW)
      if (DEBUG_ARTIFACT_PATTERN.test(addedLine)) {
        findings.push({
          file: currentFile,
          line: diffLineNum,
          pattern: 'Debug artifact in test file',
          severity: 'LOW',
          context: truncate(addedLine, 120),
        });
        hasDebugArtifact = true;
      }
    }

    diffLineNum++;
  }

  // Count passed checks (5 categories total, but script_coverage is repo-only)
  const totalChecks = 4;
  let passedChecks = 0;
  if (!hasOnlySkip) passedChecks++;
  if (!hasTimeIssue) passedChecks++;
  if (!hasRandomIssue) passedChecks++;
  if (!hasDebugArtifact) passedChecks++;

  const findingCount = findings.length;

  // Build structured report
  const reportLines: string[] = [];
  reportLines.push('## Workflow Determinism Report');
  reportLines.push('');

  if (findingCount === 0) {
    reportLines.push('No determinism issues detected.');
    reportLines.push('');
    reportLines.push('---');
    reportLines.push('');
    reportLines.push(`**Result: PASS** (${passedChecks}/${totalChecks} checks passed)`);
  } else {
    reportLines.push(`**Findings (${findingCount}):**`);
    reportLines.push('');
    for (const f of findings) {
      reportLines.push(
        `- **${f.severity}** \`${f.file}:${f.line}\` — ${f.pattern}: \`${f.context}\``
      );
    }
    reportLines.push('');
    reportLines.push('---');
    reportLines.push('');
    reportLines.push(
      `**Result: FINDINGS** (${findingCount} finding${findingCount === 1 ? '' : 's'} detected)`
    );
  }

  return {
    status: findingCount === 0 ? 'pass' : 'findings',
    findingCount,
    findings: findings.map(
      (f) =>
        `- **${f.severity}** \`${f.file}:${f.line}\` — ${f.pattern}: \`${f.context}\``
    ),
    passedChecks,
    totalChecks,
    report: reportLines.join('\n'),
  };
}

// ============================================================
// Utility
// ============================================================

function truncate(str: string, maxLen: number): string {
  const trimmed = str.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.substring(0, maxLen - 3) + '...';
}
