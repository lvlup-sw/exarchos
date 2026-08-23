/**
 * Post-Merge Regression Check
 *
 * Gate check for the synthesize -> cleanup boundary.
 * Verifies CI passed on the merge commit and runs the merged repository's own
 * resolved test suite to detect regressions. CI status is queried via
 * VcsProvider.
 *
 * `status` has THREE values, not two:
 *   'pass'          — CI green and the suite ran and passed.
 *   'fail'          — a regression was OBSERVED (CI failure, or a non-zero exit
 *                     from a suite that really ran).
 *   'indeterminate' — a check could not be performed: no test command resolves
 *                     for this tree, the runner never started, or it was killed
 *                     at its wall clock. Nothing failed; nothing was measured.
 */

import type { VcsProvider, CiStatus, CiCheck as VcsCiCheck } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';
import { runCommandSync } from '../../utils/process.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { classifyCommandFailure } from './command-outcome.js';

// ============================================================
// Types
// ============================================================

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set when the command could not be SPAWNED at all — the process never ran,
   * so `exitCode` is not authoritative and a non-zero value is not a
   * regression. Distinct from an ordinary non-zero exit, which IS one.
   */
  readonly spawnError?: string;
  /**
   * Set when the runner was killed for exceeding its wall clock. The status
   * belongs to the kill, not to the suite, so it decides nothing either.
   */
  readonly timedOut?: boolean;
}

export interface PostMergeOptions {
  prUrl: string;
  mergeSha: string;
  /**
   * The repository the regression check is about. It is BOTH where the test
   * command is resolved from and where the default runner runs it, so the two
   * can never disagree about which tree was measured. Defaults to the process's
   * own directory, which is where the default runner already ran.
   */
  repoRoot?: string;
  /** Dependency-injected command runner for testing (used for test suite check). */
  runCommand?: (
    cmd: string,
    args: readonly string[]
  ) => CommandResult;
  /** VcsProvider for CI status queries. Falls back to createVcsProvider(). */
  provider?: VcsProvider;
}

export interface PostMergeResult {
  status: 'pass' | 'fail' | 'indeterminate';
  prUrl: string;
  mergeSha: string;
  passCount: number;
  failCount: number;
  results: string[];
  findings: string[];
  report: string;
  /**
   * Why `status` is `'indeterminate'`, when it is. Read by `handlePostMerge`,
   * which surfaces it on the action's carrier and stamps it into the durable
   * `gate.executed` row — so an unmeasured check is not recorded as an
   * observed failure. `status` is the only discriminant; there is no second
   * flag saying the same thing that could drift from it.
   */
  reason?: string;
}

// ============================================================
// Default command runner using child_process
// ============================================================

function defaultCommandRunner(
  cmd: string,
  args: readonly string[],
  cwd?: string
): CommandResult {
  try {
    const stdout = runCommandSync(cmd, args as string[], {
      ...(cwd !== undefined ? { cwd } : {}),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const failure = classifyCommandFailure(err);
    return {
      exitCode: failure.exitCode,
      stdout: failure.stdout,
      stderr: failure.stderr,
      ...(failure.kind === 'spawn' ? { spawnError: failure.detail } : {}),
      ...(failure.kind === 'timeout' ? { timedOut: true } : {}),
    };
  }
}

// ============================================================
// CI check status mapping
// ============================================================

const PASSING_STATUSES: ReadonlySet<VcsCiCheck['status']> = new Set(['pass', 'skipped']);

// ============================================================
// Test-command resolution
// ============================================================

type TestCommandResolution =
  | { readonly kind: 'resolved'; readonly command: string; readonly cmd: string; readonly args: readonly string[] }
  | { readonly kind: 'indeterminate'; readonly reason: string };

/**
 * The command that re-runs the merged repository's suite, taken from the
 * toolchain source of truth. Spelling one package manager's invocation here
 * made this check undischargeable on every repository that does not use it,
 * and a regression check that cannot run must say so rather than pass.
 */
function resolveTestCommand(repoRoot: string): TestCommandResolution {
  let runtime: ResolvedRuntime;
  try {
    runtime = resolveTestRuntime(repoRoot);
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
  if (runtime.source === 'unresolved' || runtime.test === null) {
    return {
      kind: 'indeterminate',
      reason: runtime.remediation ?? `no test command resolves for '${repoRoot}'`,
    };
  }
  try {
    const { cmd, args } = splitCommand(runtime.test);
    if (cmd === '') {
      return { kind: 'indeterminate', reason: `empty test command: '${runtime.test}'` };
    }
    return { kind: 'resolved', command: runtime.test, cmd, args };
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// Core logic
// ============================================================

export async function checkPostMerge(options: PostMergeOptions): Promise<PostMergeResult> {
  const { prUrl, mergeSha } = options;
  const repoRoot = options.repoRoot ?? process.cwd();
  const runCommand =
    options.runCommand ?? ((cmd, args) => defaultCommandRunner(cmd, args, repoRoot));
  const vcs = options.provider ?? await createVcsProvider();

  const results: string[] = [];
  const findings: string[] = [];
  const unrunnable: string[] = [];
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
    const resolution = resolveTestCommand(repoRoot);
    if (resolution.kind === 'indeterminate') {
      unrunnable.push(`Test suite: ${resolution.reason}`);
      results.push(`- **INDETERMINATE**: Test suite -- ${resolution.reason}`);
      return;
    }

    const testResult = runCommand(resolution.cmd, resolution.args);

    // A runner that never started, or one killed at its wall clock, observed no
    // regression — its exit status belongs to the failure to run, not to the
    // suite. Checked before the exit code is read, because reading it would
    // report a regression nobody measured.
    if (testResult.timedOut === true) {
      const detail = `\`${resolution.command}\` was killed for exceeding its time limit`;
      unrunnable.push(`Test suite: ${detail}`);
      results.push(`- **INDETERMINATE**: Test suite -- ${detail}`);
      return;
    }
    if (testResult.spawnError !== undefined) {
      const detail = `\`${resolution.command}\` could not be started (${testResult.spawnError})`;
      unrunnable.push(`Test suite: ${detail}`);
      results.push(`- **INDETERMINATE**: Test suite -- ${detail}`);
      return;
    }

    if (testResult.exitCode !== 0) {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="${resolution.command} failed (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', `${resolution.command} failed`);
      return;
    }

    checkPass(`Test suite (${resolution.command} passed)`);
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

  if (unrunnable.length > 0) {
    reportLines.push(
      `**Result: INDETERMINATE** (${unrunnable.length} check(s) could not run; ` +
        `${passCount}/${total} of the rest passed)`,
    );
  } else if (failCount === 0) {
    reportLines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    reportLines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  const status: PostMergeResult['status'] =
    unrunnable.length > 0 ? 'indeterminate' : failCount === 0 ? 'pass' : 'fail';

  return {
    status,
    ...(unrunnable.length > 0 ? { reason: unrunnable.join('; ') } : {}),
    prUrl,
    mergeSha,
    passCount,
    failCount,
    results,
    findings,
    report: reportLines.join('\n'),
  };
}
