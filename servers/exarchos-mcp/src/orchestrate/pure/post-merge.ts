/**
 * Post-Merge Regression Check
 *
 * Gate check for the synthesize -> cleanup boundary.
 * Verifies CI passed on the merge commit and runs the test suite
 * to detect regressions. CI status is queried via VcsProvider.
 *
 * Exit code semantics (when used as a gate):
 *   0 = pass (CI green, tests pass)
 *   1 = findings (CI failure or test regression)
 */

import type { VcsProvider, CiStatus, CiCheck as VcsCiCheck } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';

// ============================================================
// Types
// ============================================================

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PostMergeOptions {
  prUrl: string;
  mergeSha: string;
  /** Dependency-injected command runner for testing (used for test suite check). */
  runCommand?: (
    cmd: string,
    args: readonly string[]
  ) => CommandResult;
  /** VcsProvider for CI status queries. Falls back to createVcsProvider(). */
  provider?: VcsProvider;
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
// CI check status mapping
// ============================================================

const PASSING_STATUSES: ReadonlySet<VcsCiCheck['status']> = new Set(['pass', 'skipped']);

// ============================================================
// Core logic
// ============================================================

export async function checkPostMerge(options: PostMergeOptions): Promise<PostMergeResult> {
  const { prUrl, mergeSha } = options;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const vcs = options.provider ?? await createVcsProvider();

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
  // CHECK 1: CI Status via VcsProvider
  // --------------------------------------------------------
  async function checkCiStatus(): Promise<void> {
    let ciStatus: CiStatus;
    try {
      ciStatus = await vcs.checkCi(prUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const evidence = message.includes('command not found')
        ? 'gh CLI not found in PATH'
        : 'CI status query failed';
      findings.push(
        `FINDING [D4] [HIGH] criterion="ci-green" evidence="${evidence}"`
      );
      checkFail('CI green', evidence);
      return;
    }

    if (ciStatus.checks.length === 0) {
      // No checks found — treat as pass (no CI configured)
      checkPass('CI green (no checks configured)');
      return;
    }

    const failedChecks = ciStatus.checks
      .filter((c) => !PASSING_STATUSES.has(c.status))
      .map((c) => `${c.name} (${c.status.toUpperCase()})`)
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
  await checkCiStatus();
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
