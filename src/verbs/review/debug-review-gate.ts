/**
 * The debug review gate. It checks that the diff of a debug fix changes at least one test file.
 * A changed file is a test when a test-name glob of the verification profile matches it.
 * The gate runs the test command that the resolver gives when the diff is not empty and `skipRun` is not set.
 * A provisioned verifier runs that command under a checkout subject of the phase attempt. A provisioned route never runs it locally.
 */
import { execFileSync } from 'node:child_process';
import { runCommandSync } from '../../utils/process.js';
import { existsSync } from 'node:fs';
import type { ToolResult } from '../../format.js';
import { resolveRunnableCommand } from '../../config/test-runtime-resolver.js';
import { matchesTestName } from '../../config/verification-profile.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { PROFILE_UNRESOLVED } from '../../workflow/verification/profile.js';
import type { VerificationHostConnector } from '../../contract/verification/harness-verification.js';
import { admitLifecycleLegs, hostedPendingResult, runPhaseGateWithEvidence } from '../gates/gate-runner.js';
import { profileOf, withProfileRoute, type ProfiledGateArgs } from '../gates/gate-utils.js';

export interface DebugReviewGateArgs extends ProfiledGateArgs {
  /** The stream the gate's durable evidence is recorded against. */
  readonly featureId: string;
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly skipRun?: boolean;
}

interface CheckCounts {
  pass: number;
  fail: number;
  skip: number;
}

/** The verifier of one call and the phase attempt that scopes its request. */
interface DebugReviewHost {
  readonly connector: VerificationHostConnector;
  readonly phaseAttemptId: () => string | undefined;
}

/**
 * Runs the gate through the shared phase-gate runner, which records durable gate evidence before a
 * success carrier returns. The action declares no catalog emission, so the gate appends no `gate.executed` row.
 * A connector comes only from the dispatch context. A pending hosted result maps to its existing code with no evidence.
 */
export async function handleDebugReviewGate(
  args: DebugReviewGateArgs,
  stateDir: string,
  eventStore: EventStore,
  connector?: VerificationHostConnector,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  let attempt: string | undefined;
  const host = connector === undefined ? undefined : { connector, phaseAttemptId: () => attempt };
  try {
    return await runPhaseGateWithEvidence({
      streamId: args.featureId,
      gateClass: 'debug-review',
      requirementId: 'requirement:debug-review',
      stateDir,
      eventStore,
      subject: (phaseAttemptId) => {
        attempt = phaseAttemptId;
        return createEvidenceSubject(
          { kind: 'phase-attempt', phaseAttemptId },
          {
            gate: 'debug-review',
            phase: 'debug-review',
            repoRoot: args.repoRoot,
            baseBranch: args.baseBranch,
          },
        );
      },
      providerInput: args,
      executeProvider: async () => executeDebugReviewGate(args, host),
    });
  } catch (error) {
    return hostedPendingResult(error);
  }
}

async function executeDebugReviewGate(args: DebugReviewGateArgs, host?: DebugReviewHost): Promise<ToolResult> {
  if (!args.repoRoot) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repoRoot is required' },
    };
  }

  if (!args.baseBranch) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'baseBranch is required' },
    };
  }

  if (!existsSync(args.repoRoot)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Repository root not found: ${args.repoRoot}`,
      },
    };
  }

  const checks: CheckCounts = { pass: 0, fail: 0, skip: 0 };
  const results: string[] = [];

  const changedFiles = getChangedFiles(args.repoRoot, args.baseBranch);

  if (changedFiles === null) {
    return {
      success: false,
      error: {
        code: 'DIFF_FAILED',
        message: `git diff failed for base branch '${args.baseBranch}' in ${args.repoRoot}`,
      },
    };
  }

  const globTerm = profileOf(args, args.repoRoot).tests.globs;
  let unresolvedReason: string | undefined;

  if (globTerm.state === 'unresolved') {
    unresolvedReason = withProfileRoute(args, globTerm.reason);
    results.push(`- **FAIL**: New test files added — ${PROFILE_UNRESOLVED}: ${unresolvedReason}`);
    checks.fail++;
  } else if (changedFiles.length === 0) {
    results.push(
      `- **FAIL**: New test files added — No changed files found between ${args.baseBranch} and HEAD`,
    );
    checks.fail++;
  } else {
    const testFiles = changedFiles.filter((f) => matchesTestName(f, globTerm.globs));

    if (testFiles.length === 0) {
      results.push(
        '- **FAIL**: New test files added — No test files found in changed files',
      );
      checks.fail++;
    } else {
      const fileList = testFiles.join(', ');
      results.push(
        `- **PASS**: New test files added (${testFiles.length} test file(s): ${fileList})`,
      );
      checks.pass++;
    }
  }

  if (args.skipRun) {
    results.push('- **SKIP**: Tests pass (--skip-run)');
    checks.skip++;
  } else if (changedFiles.length > 0) {
    const run = host === undefined ? runTests(args.repoRoot) : await runHostedTests(args, host);
    if ('success' in run) return run;
    if (run.passed) {
      results.push(`- **PASS**: Tests pass (${run.detail})`);
      checks.pass++;
    } else {
      results.push(`- **FAIL**: Tests pass — ${run.detail}`);
      checks.fail++;
    }
  } else {
    results.push('- **SKIP**: Tests pass (no changed files)');
    checks.skip++;
  }

  const passed = checks.fail === 0;
  const total = checks.pass + checks.fail;
  const report = buildReport(args.repoRoot, args.baseBranch, results, checks, passed, total);

  return {
    success: true,
    data: {
      passed,
      report,
      checks,
      ...(unresolvedReason === undefined ? {} : { discriminant: PROFILE_UNRESOLVED, reason: unresolvedReason }),
    },
  };
}

/** Lists the files changed since `baseBranch` with a three-dot diff, then a two-dot diff. It returns `null` when both fail. */
function getChangedFiles(repoRoot: string, baseBranch: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', `${baseBranch}...HEAD`],
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    try {
      const output = execFileSync(
        'git',
        ['diff', '--name-only', baseBranch, 'HEAD'],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch {
      return null;
    }
  }
}

/**
 * Run the test command the toolchain resolver resolves for `repoRoot`. No
 * resolvable test command fails the check. `detail` names the command that ran,
 * or the reason no command ran.
 */
function runTests(repoRoot: string): { readonly passed: boolean; readonly detail: string } {
  const resolved = resolveRunnableCommand(repoRoot, 'test');
  if (resolved.kind !== 'runnable') {
    return { passed: false, detail: `no test command resolved: ${resolved.reason}` };
  }
  try {
    runCommandSync(resolved.bin, resolved.args, {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
    return { passed: true, detail: resolved.command };
  } catch {
    return { passed: false, detail: `${resolved.command} failed` };
  }
}

/**
 * Run the resolved test command in the verifier. No resolvable command fails the check with no request.
 * A refusal returns as the gate result. A pending result and a run with no verdict throw the pending signal.
 */
async function runHostedTests(
  args: DebugReviewGateArgs, host: DebugReviewHost,
): Promise<{ readonly passed: boolean; readonly detail: string } | ToolResult> {
  const resolved = resolveRunnableCommand(args.repoRoot, 'test');
  if (resolved.kind !== 'runnable') return { passed: false, detail: `no test command resolved: ${resolved.reason}` };
  const phaseAttemptId = host.phaseAttemptId();
  const legs = await admitLifecycleLegs({
    connector: host.connector, checkout: args.repoRoot, legs: [{ kind: 'command', argv: [resolved.bin, ...resolved.args] }],
    streamId: args.featureId, ...(phaseAttemptId === undefined ? {} : { phaseAttemptId }),
  });
  if ('success' in legs) return legs;
  return legs[0]?.run.exitCode === 0 ? { passed: true, detail: resolved.command } : { passed: false, detail: `${resolved.command} failed` };
}

function buildReport(
  repoRoot: string,
  baseBranch: string,
  results: readonly string[],
  checks: CheckCounts,
  passed: boolean,
  total: number,
): string {
  const lines: string[] = [
    '## Debug Review Gate',
    '',
    `**Repository:** \`${repoRoot}\``,
    `**Base branch:** \`${baseBranch}\``,
    '',
    ...results,
    '',
    '---',
    '',
  ];

  if (passed) {
    lines.push(`**Result: PASS** (${checks.pass}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${checks.fail}/${total} checks failed)`);
  }

  return lines.join('\n');
}
