/**
 * Post-merge regression check for the synthesize-to-cleanup boundary. It runs the resolved test
 * command of the checkout. The status is `fail` when the test suite fails.
 * The check reads no CI status from a provider. The harness owns the CI state of the PR.
 */

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
  /**
   * The test runner of the local approved-check executor. When present, it replaces `runCommand`.
   * A run with no verdict throws, so it never reads as a red suite.
   */
  localTestRun?: (bin: string, args: readonly string[]) => Promise<CommandResult>;
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

/** Runs the test suite and builds the report. */
export async function checkPostMerge(options: PostMergeOptions): Promise<PostMergeResult> {
  const { prUrl, mergeSha, repoRoot } = options;
  const runCommand =
    options.runCommand ?? ((cmd: string, args: readonly string[]) => defaultCommandRunner(cmd, args, repoRoot));

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

  async function checkTestSuite(): Promise<void> {
    const resolved = resolveRunnableCommand(repoRoot, 'test');
    if (resolved.kind !== 'runnable') {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="no test command resolved (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', `no test command resolved: ${resolved.reason}`);
      return;
    }

    const testResult = options.localTestRun === undefined
      ? runCommand(resolved.bin, resolved.args) : await options.localTestRun(resolved.bin, resolved.args);

    if (testResult.exitCode !== 0) {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="${resolved.command} failed (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', `${resolved.command} failed`);
      return;
    }

    checkPass(`Test suite (${resolved.command} passed)`);
  }

  await checkTestSuite();

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
