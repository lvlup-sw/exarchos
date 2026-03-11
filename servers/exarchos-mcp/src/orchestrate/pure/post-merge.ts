/**
 * Post-Merge Regression Check
 *
 * Gate check for the synthesize -> cleanup boundary.
 * Verifies CI passed on the merge commit and runs the test suite
 * to detect regressions. Ported from scripts/check-post-merge.sh.
 *
 * Exit code semantics (when used as a gate):
 *   0 = pass (CI green, tests pass)
 *   1 = findings (CI failure or test regression)
 */

// ============================================================
// Types
// ============================================================

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PostMergeOptions {
  prUrl: string;
  mergeSha: string;
  /** Dependency-injected command runner for testing. */
  runCommand?: (
    cmd: string,
    args: readonly string[]
  ) => CommandResult;
}

export interface PostMergeResult {
  status: 'pass' | 'fail';
  prUrl: string;
  mergeSha: string;
  passCount: number;
  failCount: number;
  results: string[];
  findings: string[];
  report: string;
}

// ============================================================
// CI check types
// ============================================================

interface CICheck {
  name: string;
  state: string;
}

// ============================================================
// Default command runner using child_process
// ============================================================

function defaultCommandRunner(
  cmd: string,
  args: readonly string[]
): CommandResult {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    const stdout = execFileSync(cmd, args as string[], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: execErr.status ?? 1,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    };
  }
}

// ============================================================
// Core logic
// ============================================================

export function checkPostMerge(options: PostMergeOptions): PostMergeResult {
  const { prUrl, mergeSha } = options;
  const runCommand = options.runCommand ?? defaultCommandRunner;

  const results: string[] = [];
  const findings: string[] = [];
  let passCount = 0;
  let failCount = 0;

  function checkPass(name: string): void {
    results.push(`- **PASS**: ${name}`);
    passCount++;
  }

  function checkFail(name: string, detail?: string): void {
    const line = detail
      ? `- **FAIL**: ${name} -- ${detail}`
      : `- **FAIL**: ${name}`;
    results.push(line);
    failCount++;
  }

  // --------------------------------------------------------
  // CHECK 1: CI Status via gh pr checks
  // --------------------------------------------------------
  function checkCiStatus(): void {
    const ghResult = runCommand('gh', [
      'pr', 'checks', prUrl, '--json', 'name,state',
    ]);

    if (ghResult.exitCode !== 0) {
      const evidence = ghResult.stderr.includes('command not found')
        ? 'gh CLI not found in PATH'
        : 'gh pr checks command failed';
      findings.push(
        `FINDING [D4] [HIGH] criterion="ci-green" evidence="${evidence}"`
      );
      checkFail('CI green', evidence);
      return;
    }

    let checks: CICheck[];
    try {
      checks = JSON.parse(ghResult.stdout) as CICheck[];
    } catch {
      findings.push(
        'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed to parse CI check results"'
      );
      checkFail('CI green', 'Failed to parse CI check results');
      return;
    }

    const PASSING_STATES = ['SUCCESS', 'SKIPPED', 'NEUTRAL'];
    const failedChecks = checks
      .filter((c) => !PASSING_STATES.includes(c.state))
      .map((c) => `${c.name} (${c.state})`)
      .join(', ');

    if (failedChecks.length > 0) {
      findings.push(
        `FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: ${failedChecks}"`
      );
      checkFail('CI green', `Failed checks: ${failedChecks}`);
      return;
    }

    checkPass('CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)');
  }

  // --------------------------------------------------------
  // CHECK 2: Test Suite
  // --------------------------------------------------------
  function checkTestSuite(): void {
    const testResult = runCommand('npm', ['run', 'test:run']);

    if (testResult.exitCode !== 0) {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', 'npm run test:run failed');
      return;
    }

    checkPass('Test suite (npm run test:run passed)');
  }

  // Execute checks
  checkCiStatus();
  checkTestSuite();

  // Build structured report
  const reportLines: string[] = [];
  reportLines.push('## Post-Merge Regression Report');
  reportLines.push('');
  reportLines.push(`**PR:** \`${prUrl}\``);
  reportLines.push(`**Merge SHA:** \`${mergeSha}\``);
  reportLines.push('');

  for (const result of results) {
    reportLines.push(result);
  }

  reportLines.push('');
  const total = passCount + failCount;
  reportLines.push('---');
  reportLines.push('');

  if (failCount === 0) {
    reportLines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    reportLines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  return {
    status: failCount === 0 ? 'pass' : 'fail',
    prUrl,
    mergeSha,
    passCount,
    failCount,
    results,
    findings,
    report: reportLines.join('\n'),
  };
}
