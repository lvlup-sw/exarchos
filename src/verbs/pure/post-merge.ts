/**
 * Post-merge regression check for the synthesize-to-cleanup boundary. It reads the CI status of
 * the PR through the `VcsProvider`, then runs `npm run test:run`. The status is `fail` when
 * either check fails.
 */

import type { VcsProvider, CiStatus, CiCheck as VcsCiCheck } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';
import { runCommandSync } from '../../utils/process.js';
import { resolveRunnableCommand } from '../../config/test-runtime-resolver.js';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PostMergeOptions {
  prUrl: string;
  mergeSha: string;
  /** The checkout to test. The test command is resolved and run here. */
  repoRoot: string;
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

function defaultCommandRunner(
  cmd: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  try {
    const stdout = runCommandSync(cmd, args as string[], {
      cwd,
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

const PASSING_STATUSES: ReadonlySet<VcsCiCheck['status']> = new Set(['pass', 'skipped']);

/** Runs the CI check and the test suite, and builds the report. A PR with no CI checks passes the CI check. */
export async function checkPostMerge(options: PostMergeOptions): Promise<PostMergeResult> {
  const { prUrl, mergeSha, repoRoot } = options;
  const runCommand =
    options.runCommand ?? ((cmd: string, args: readonly string[]) => defaultCommandRunner(cmd, args, repoRoot));
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

  function checkTestSuite(): void {
    const resolved = resolveRunnableCommand(repoRoot, 'test');
    if (resolved.kind !== 'runnable') {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="no test command resolved (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', `no test command resolved: ${resolved.reason}`);
      return;
    }

    const testResult = runCommand(resolved.bin, resolved.args);

    if (testResult.exitCode !== 0) {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="${resolved.command} failed (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', `${resolved.command} failed`);
      return;
    }

    checkPass(`Test suite (${resolved.command} passed)`);
  }

  await checkCiStatus();
  checkTestSuite();

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
