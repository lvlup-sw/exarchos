/**
 * Scans a unified diff for non-deterministic patterns and test hygiene problems in the added lines of test files:
 *   - `.only` or `.skip` in tests (HIGH)
 *   - time usage with no fake timers (MEDIUM)
 *   - `Math.random()` with no mock or seed (MEDIUM)
 *   - debug artifacts (LOW)
 */

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

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

const ONLY_SKIP_PATTERN = /\b(describe|it|test)\.(only|skip)\b/;
const DATE_NOW_PATTERN = /\bDate\.now\(\)|\bnew Date\(\)/;
const FAKE_TIMERS_PATTERN = /vi\.(useFakeTimers|setSystemTime|getRealSystemTime)/;
const MATH_RANDOM_PATTERN = /\bMath\.random\(\)/;
const RANDOM_MOCK_PATTERN = /vi\.(fn|spyOn|mock).*Math\.random|seed|mockRandom/;
const DEBUG_ARTIFACT_PATTERN = /\bconsole\.(log|debug|info|warn)\b|\bdebugger\b/;

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

/**
 * Runs the four checks over the added lines of test files and builds the report.
 * Line numbers come from the hunk headers. A removed line does not advance the count.
 * The context lines and added lines of a file collect into a context. The time and random checks search it for fake timers or mocks.
 * The total is four checks, because the script-coverage check needs the repo.
 */
export function checkWorkflowDeterminism(
  options: WorkflowDeterminismOptions
): WorkflowDeterminismResult {
  const { diffContent } = options;

  const findings: Finding[] = [];

  let hasOnlySkip = false;
  let hasTimeIssue = false;
  let hasRandomIssue = false;
  let hasDebugArtifact = false;

  let currentFile = '';
  let diffLineNum = 0;
  let fileContext = '';

  const lines = diffContent.split('\n');

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\//);
    if (fileMatch) {
      currentFile = fileMatch[1] ?? '';
      diffLineNum = 0;
      fileContext = '';
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      diffLineNum = parseInt(hunkMatch[1] ?? '0', 10);
      continue;
    }

    if (!line.startsWith('+')) {
      if (!line.startsWith('-')) {
        diffLineNum++;
      }
      if (/^\s/.test(line)) {
        fileContext += line + '\n';
      }
      continue;
    }

    if (line.startsWith('+++')) {
      continue;
    }

    const addedLine = line.substring(1);
    fileContext += addedLine + '\n';

    if (isTestFile(currentFile)) {
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

      if (DATE_NOW_PATTERN.test(addedLine)) {
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

      if (MATH_RANDOM_PATTERN.test(addedLine)) {
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

  const totalChecks = 4;
  let passedChecks = 0;
  if (!hasOnlySkip) passedChecks++;
  if (!hasTimeIssue) passedChecks++;
  if (!hasRandomIssue) passedChecks++;
  if (!hasDebugArtifact) passedChecks++;

  const findingCount = findings.length;

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

function truncate(str: string, maxLen: number): string {
  const trimmed = str.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.substring(0, maxLen - 3) + '...';
}
