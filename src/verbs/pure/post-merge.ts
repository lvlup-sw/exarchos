/**
 * Post-merge regression check for the synthesize-to-cleanup boundary. It reads the CI status of
 * the PR through the `VcsProvider`, then runs `npm run test:run`. The status is `fail` when
 * either check fails.
 */

import type { VcsProvider, CiStatus, CiCheck as VcsCiCheck, PrRepository } from '../../vcs/provider.js';
import { requireRepository } from '../../vcs/provider.js';
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
  /**
   * The hosted test runner of a provisioned route. When present, it replaces `runCommand` and waits for the authenticated result.
   * A hosted run with no verdict throws, so it never reads as a red suite.
   */
  hostedTestRun?: (bin: string, args: readonly string[]) => Promise<CommandResult>;
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

/** The pull request that `prUrl` names: its number and, for a GitHub or GitLab URL, its repository. */
interface PrTarget {
  readonly number: string;
  readonly repository?: PrRepository | undefined;
}

/**
 * Reads the pull request from a bare number, or from the path of a pull request URL.
 * A GitHub `/OWNER/REPO/pull/N` path and a GitLab `/GROUP/PROJECT/-/merge_requests/N` path also give the repository.
 * Then the CI query reads that repository and not the current checkout.
 * An Azure DevOps `/pullrequest/N` path gives only the number.
 * The result is `undefined` when the number or the repository does not have a safe form.
 */
function prTargetOf(prUrl: string): PrTarget | undefined {
  if (/^[1-9]\d*$/.test(prUrl)) return { number: prUrl };
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return undefined;
  }
  const github = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  const gitlab = /^\/(.+?)(?:\/-)?\/merge_requests\/([1-9]\d*)\/?$/.exec(url.pathname);
  const [, repoPath, repoNumber] = github ?? gitlab ?? [];
  if (repoPath !== undefined && repoNumber !== undefined) {
    const repository: PrRepository = { host: url.host, path: repoPath };
    try {
      requireRepository(repository);
    } catch {
      return undefined;
    }
    return { number: repoNumber, repository };
  }
  const azureNumber = /\/pullrequest\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  return azureNumber === undefined ? undefined : { number: azureNumber };
}

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
    const target = prTargetOf(prUrl);
    if (target === undefined) {
      const evidence = 'prUrl names no pull request number';
      findings.push(
        `FINDING [D4] [HIGH] criterion="ci-green" evidence="${evidence}"`
      );
      checkFail('CI green', evidence);
      return;
    }

    let ciStatus: CiStatus;
    try {
      ciStatus = await vcs.checkCi(target.number, { repository: target.repository });
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

  async function checkTestSuite(): Promise<void> {
    const resolved = resolveRunnableCommand(repoRoot, 'test');
    if (resolved.kind !== 'runnable') {
      findings.push(
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="no test command resolved (merge-sha: ${mergeSha})"`
      );
      checkFail('Test suite', `no test command resolved: ${resolved.reason}`);
      return;
    }

    const testResult = options.hostedTestRun === undefined
      ? runCommand(resolved.bin, resolved.args) : await options.hostedTestRun(resolved.bin, resolved.args);

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
