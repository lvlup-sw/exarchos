/**
 * The debug review gate. It checks that the diff of a debug fix changes at least one test file.
 * A changed file is a test when a test-name glob of the verification profile matches it.
 * The gate runs the test command that the resolver gives when the diff is not empty and `skipRun` is not set.
 *
 * The local approved-check executor runs that command as a lifecycle check of the phase attempt, with no verifier provisioning.
 * The changed files come from the constrained reader with the process-wide Git path.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolResult } from '../../format.js';
import { resolveRunnableCommand } from '../../config/test-runtime-resolver.js';
import { matchesTestName } from '../../config/verification-profile.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { PROFILE_UNRESOLVED } from '../../workflow/verification/profile.js';
import { processObservationalGitPath } from '../../utils/git-tree.js';
import { hostedPendingResult, runPhaseGateWithEvidence } from '../gates/gate-runner.js';
import { observeCurrentCheckout, profileOf, withProfileRoute, type ProfiledGateArgs } from '../gates/gate-utils.js';
import { admitLifecycleLegs } from '../verification/lifecycle-check.js';
import type { CheckExecutor } from '../verification/check-executor.js';

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

/** The event store, the executor and the phase attempt that scope the test run of one call. */
interface DebugReviewRun {
  readonly eventStore: EventStore;
  readonly executor?: CheckExecutor;
  readonly phaseAttemptId: () => string | undefined;
}

/**
 * Runs the gate through the shared phase-gate runner, which records durable gate evidence before a
 * success carrier returns. The action declares no catalog emission, so the gate appends no `gate.executed` row.
 * The tests run in the local executor with no verifier provisioning. A pending result maps to its existing code with no evidence.
 *
 * @param executor - The local check executor. The default is the real executor. A test passes its own executor.
 */
export async function handleDebugReviewGate(
  args: DebugReviewGateArgs,
  stateDir: string,
  eventStore: EventStore,
  executor?: CheckExecutor,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  let attempt: string | undefined;
  const run: DebugReviewRun = { eventStore, ...(executor === undefined ? {} : { executor }), phaseAttemptId: () => attempt };
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
      executeProvider: async () => executeDebugReviewGate(args, run),
    });
  } catch (error) {
    return hostedPendingResult(error);
  }
}

async function executeDebugReviewGate(args: DebugReviewGateArgs, run: DebugReviewRun): Promise<ToolResult> {
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

  const changedFiles = await getChangedFiles(processObservationalGitPath(), args.repoRoot, args.baseBranch);

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
    const tests = await runLocalTests(args, run);
    if ('success' in tests) return tests;
    if (tests.passed) {
      results.push(`- **PASS**: Tests pass (${tests.detail})`);
      checks.pass++;
    } else {
      results.push(`- **FAIL**: Tests pass — ${tests.detail}`);
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

/** The lines of a name-only diff, with no empty line. */
function nameLines(output: string): string[] {
  return output.trim().split('\n').filter((line) => line.length > 0);
}

/**
 * Lists the files changed since `baseBranch` through the constrained reader with the process-wide Git path. It starts no bare `git` name.
 * The repo root climbs to its checkout root, and the base resolves by the closed base-name order.
 * The first read is a name-only diff from the merge base of the base and the head, which is the meaning of `base...HEAD`.
 * When that read fails, the second read is a name-only diff of the base and the head.
 * It returns `null` when no Git is usable, or when the observation, the base or both reads fail.
 */
async function getChangedFiles(gitPath: string | undefined, repoRoot: string, baseBranch: string): Promise<string[] | null> {
  if (gitPath === undefined) return null;
  const observed = await observeCurrentCheckout(gitPath, resolve(repoRoot));
  if (observed.kind === 'refused') return null;
  const { observer, checkout } = observed;
  const base = await observer.base(checkout, baseBranch);
  if (base.kind === 'refused') return null;
  const { gitDir } = checkout;
  try {
    const mergeBase = (await observer.reads.mergeBase(gitDir, checkout.checkout, base.value, checkout.head)).trim();
    return nameLines(await observer.reads.nameOnly(gitDir, checkout.checkout, mergeBase, checkout.head));
  } catch {
    try {
      return nameLines(await observer.reads.nameOnly(gitDir, checkout.checkout, base.value, checkout.head));
    } catch {
      return null;
    }
  }
}

/**
 * Run the resolved test command in the local executor. No resolvable command fails the check with no run.
 * A refusal returns as the gate result. A pending result and a run with no verdict throw the pending signal.
 */
async function runLocalTests(
  args: DebugReviewGateArgs, run: DebugReviewRun,
): Promise<{ readonly passed: boolean; readonly detail: string } | ToolResult> {
  const resolved = resolveRunnableCommand(args.repoRoot, 'test');
  if (resolved.kind !== 'runnable') return { passed: false, detail: `no test command resolved: ${resolved.reason}` };
  const phaseAttemptId = run.phaseAttemptId();
  const legs = await admitLifecycleLegs({
    eventStore: run.eventStore, checkout: args.repoRoot, legs: [{ kind: 'command', argv: [resolved.bin, ...resolved.args] }],
    streamId: args.featureId, ...(phaseAttemptId === undefined ? {} : { phaseAttemptId }),
    ...(run.executor === undefined ? {} : { executor: run.executor }),
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
