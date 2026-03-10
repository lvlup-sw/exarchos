/**
 * TDD Compliance Check
 *
 * Verify test-first discipline by analyzing git log for test commits
 * preceding implementation commits. Ported from scripts/check-tdd-compliance.sh.
 *
 * Exit code semantics (when used as a gate):
 *   0 = compliant (test files committed before or alongside implementation)
 *   1 = violations found (implementation committed without test)
 */

import { execFileSync } from 'node:child_process';

// ============================================================
// Types
// ============================================================

export interface TddComplianceOptions {
  repoRoot: string;
  branch: string;
  baseBranch?: string;
  /** Dependency-injected git executor for testing. */
  execGit?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; encoding?: string }
  ) => string;
}

export interface TddComplianceResult {
  status: 'pass' | 'fail';
  branch: string;
  baseBranch: string;
  commitsAnalyzed: number;
  passCount: number;
  failCount: number;
  violations: string[];
  results: string[];
  report: string;
}

// ============================================================
// File classification helpers
// ============================================================

const TEST_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|sh)$/;
const IMPL_PATTERN = /\.(ts|tsx|js|jsx|sh)$/;

function isTestFile(file: string): boolean {
  return TEST_PATTERN.test(file);
}

function isImplFile(file: string): boolean {
  if (isTestFile(file)) return false;
  return IMPL_PATTERN.test(file);
}

// ============================================================
// Core logic
// ============================================================

export function checkTddCompliance(options: TddComplianceOptions): TddComplianceResult {
  const { repoRoot, branch, baseBranch = 'main' } = options;

  const exec = options.execGit ?? ((cmd: string, args: readonly string[]) => {
    return execFileSync(cmd, args as string[], {
      cwd: repoRoot,
      encoding: 'utf-8' as BufferEncoding,
    });
  });

  const runGit = (args: string[]): string => {
    try {
      return exec('git', args, { cwd: repoRoot, encoding: 'utf-8' });
    } catch {
      return '';
    }
  };

  // Get commits from base..branch in chronological order (oldest first)
  const commitsRaw = runGit([
    'log', '--reverse', '--format=%H', `${baseBranch}..${branch}`,
  ]);
  const commits = commitsRaw.split('\n').filter((line) => line.trim().length > 0);

  const results: string[] = [];
  const violations: string[] = [];
  let passCount = 0;
  let failCount = 0;

  // Track test files seen across all commits (cumulative)
  const testsSeen = new Set<string>();

  for (const commitHash of commits) {
    const commitMsg = runGit(['log', '-1', '--format=%s', commitHash]).trim();
    const commitShort = runGit(['log', '-1', '--format=%h', commitHash]).trim();

    // Get files changed in this commit
    const filesRaw = runGit([
      'diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', commitHash,
    ]);
    const filesInCommit = filesRaw.split('\n').filter((f) => f.trim().length > 0);

    // Classify files
    let hasTest = false;
    let hasImpl = false;
    const implFiles: string[] = [];
    const testFiles: string[] = [];

    for (const file of filesInCommit) {
      if (isTestFile(file)) {
        hasTest = true;
        testFiles.push(file);
        testsSeen.add(file);
      } else if (isImplFile(file)) {
        hasImpl = true;
        implFiles.push(file);
      }
    }

    if (hasImpl) {
      if (hasTest) {
        // Mixed commit: test and impl together -- OK
        results.push(`- **PASS**: \`${commitShort}\` — ${commitMsg} (test+impl)`);
        passCount++;
      } else {
        // Check if test files were seen before this commit
        let foundPriorTest = false;
        for (const implFile of implFiles) {
          const dotIdx = implFile.lastIndexOf('.');
          if (dotIdx === -1) continue;
          const base = implFile.substring(0, dotIdx);
          const ext = implFile.substring(dotIdx + 1);
          const testCandidate = `${base}.test.${ext}`;
          const specCandidate = `${base}.spec.${ext}`;

          if (testsSeen.has(testCandidate) || testsSeen.has(specCandidate)) {
            foundPriorTest = true;
            break;
          }
        }

        if (foundPriorTest) {
          results.push(`- **PASS**: \`${commitShort}\` — ${commitMsg} (test in prior commit)`);
          passCount++;
        } else {
          results.push(`- **FAIL**: \`${commitShort}\` — ${commitMsg} (implementation without test)`);
          violations.push(`${commitShort}: ${commitMsg}`);
          failCount++;
        }
      }
    } else if (hasTest) {
      // Test-only commit -- always compliant
      results.push(`- **PASS**: \`${commitShort}\` — ${commitMsg} (test-only)`);
      passCount++;
    } else {
      // Non-code commit (docs, config, etc.) -- skip
      results.push(`- **SKIP**: \`${commitShort}\` — ${commitMsg} (non-code)`);
    }
  }

  // Build structured report
  const reportLines: string[] = [];
  reportLines.push('## TDD Compliance Report');
  reportLines.push('');
  reportLines.push(`**Branch:** ${branch}`);
  reportLines.push(`**Base:** ${baseBranch}`);
  reportLines.push(`**Commits analyzed:** ${commits.length}`);
  reportLines.push('');

  if (commits.length === 0) {
    reportLines.push(`No commits found between ${baseBranch} and ${branch}`);
    reportLines.push('');
    reportLines.push('---');
    reportLines.push('');
    reportLines.push('**Result: PASS** (no commits to check)');
  } else {
    reportLines.push('### Per-commit Analysis');
    reportLines.push('');
    for (const result of results) {
      reportLines.push(result);
    }
    reportLines.push('');

    if (violations.length > 0) {
      reportLines.push('### Violations');
      reportLines.push('');
      for (const v of violations) {
        reportLines.push(`- ${v}`);
      }
      reportLines.push('');
    }

    const total = passCount + failCount;
    reportLines.push('---');
    reportLines.push('');

    if (failCount === 0) {
      reportLines.push(`**Result: PASS** (${passCount}/${total} commits compliant)`);
    } else {
      reportLines.push(`**Result: FAIL** (${failCount}/${total} commits have violations)`);
    }
  }

  return {
    status: failCount === 0 ? 'pass' : 'fail',
    branch,
    baseBranch,
    commitsAnalyzed: commits.length,
    passCount,
    failCount,
    violations,
    results,
    report: reportLines.join('\n'),
  };
}
