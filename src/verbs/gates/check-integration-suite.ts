/**
 * check_integration_suite: runs the `integration` term of the verification profile and judges the exit code.
 * A segment reads the pinned term, and a direct call resolves the term live at `repoRoot`.
 * The gate is a leaf of the high-tier task segment, and the policy skips it at each other tier.
 * The saga keeps one run for each wave.
 *
 * The suite runs with the store keys of a scratch directory, so its tests do not write the live store.
 * A verdict is not a tool error. Thus the result is `success: true` with the verdict in `data`.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFailureFields, outputText, runCommandSync, type ExecFailureFields } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import {
  profileOf,
  profilePathOf,
  resolvePolicySkip,
  SKIPPED_BY_POLICY,
  WHOLE_SUITE_MAX_OUTPUT_BYTES,
  WHOLE_SUITE_TIMEOUT_MS,
  withProfileRoute,
  type ClosedGateVerdict,
  type ProfiledGateArgs,
} from './gate-utils.js';
import { PROBE_SCRATCH_PREFIX, probeTestEnvironment, removeProbeScratch } from './test-adequacy-handler.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import {
  NO_EXIT_STATUS,
  runIntegrationSuite,
  type IntegrationNoVerdictCause,
  type RunIntegrationSuiteResult,
} from '../pure/integration-suite.js';
import type { RunCommandFn, CommandResult } from '../pure/static-analysis.js';

interface CheckIntegrationSuiteArgs extends ProfiledGateArgs {
  readonly featureId: string;
  /**
   * The repository root for the suite. The gate uses a literal path as given.
   * `'auto'` resolves to the agent worktree of the calling delegation. When
   * absent, the gate uses `process.cwd()`. After a merge, it must point at the
   * worktree of the integration tip.
   */
  readonly repoRoot?: string;
  /**
   * The explicit worktree path, which `repoRoot:'auto'` uses first. When it is
   * absent, `'auto'` uses the latest `worktree.created` event for `taskId`.
   */
  readonly worktreePath?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  /**
   * The stamped risk tier of the task. With {@link boundaryTouching}, the gate skips itself when the
   * resolved verification sequence does not hold it. When either is absent, the gate runs.
   */
  readonly riskTier?: RiskTier;
  /** The stamped boundary-touching flag of the task. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /** The resolved project config. The dispatch adapter passes it, so the skip uses the same policy as the delegation stamp. */
  readonly projectConfig?: ResolvedProjectConfig;
}

interface CheckIntegrationSuiteResult extends ClosedGateVerdict {
  readonly passed: boolean;
  /** failedTests + loadFailures — the load cascade can never read as 0. */
  readonly failCount: number;
  /** Suites that failed before they collected a test. */
  readonly loadFailures: number;
  readonly failedTests: number;
  readonly failedSuites: number;
  readonly totalTests: number;
  readonly report: string;
  /**
   * True when the verdict is `indeterminate`. The gate then fails closed with `passed=false`
   * and `failCount>=1`. The flag tells callers that the counts are not authoritative.
   */
  readonly parseError: boolean;
  /**
   * The cause of a `parseError` that names the output of the command. `'spawn-failure'` means that
   * the test command did not start. `'shape-mismatch'` means that it ran, but the gate cannot parse the report.
   */
  readonly parseFailureKind?: 'spawn-failure' | 'shape-mismatch';
  /** The cause of an `indeterminate` verdict of a run. */
  readonly noVerdictCause?: IntegrationNoVerdictCause;
  /** Set only for a term that is not resolved. It is not a skip, so the segment halts. */
  readonly discriminant?: string;
  /** The reason of a term that is not resolved, with the path of the profile and the route of a remedy. */
  readonly reason?: string;
}

/**
 * OS errno codes that mean the child process did not start: `ENOENT` (no such
 * file), `EACCES` and `EPERM` (no permission), `ENOTDIR` (a path part is not a
 * directory), and `ENOMEM` (no memory to fork). A process that ran stays out of
 * the set. This includes a timeout, which gives `ETIMEDOUT`, and an output
 * overflow, which gives `ENOBUFS`. Both have no `status`.
 */
const SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'ENOMEM',
]);

/**
 * True only for an execFileSync error that means the process did not start:
 * no numeric exit `status` and a code in {@link SPAWN_ERROR_CODES}. Exported
 * for unit tests.
 */
export function isSpawnFailure(err: { status?: unknown; code?: unknown }): boolean {
  return (
    typeof err.status !== 'number' &&
    typeof err.code === 'string' &&
    SPAWN_ERROR_CODES.has(err.code)
  );
}

/** The exit code of a command that did not start. It is the code that a shell gives for a command that it cannot run. */
const DID_NOT_START_EXIT = 127;

/** The exit code of a thrown runner error. A missing status is never a red exit, so it never maps to exit 1. */
function exitCodeOfFailure(failure: ExecFailureFields): number {
  if (typeof failure.status === 'number') return failure.status;
  return isSpawnFailure(failure) ? DID_NOT_START_EXIT : NO_EXIT_STATUS;
}

/** The result of a run with no scratch directory. The command did not start, so the code of the error is its `spawnError`. */
function scratchFailure(err: unknown): CommandResult {
  const { code } = execFailureFields(err);
  return {
    exitCode: DID_NOT_START_EXIT,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    spawnError: typeof code === 'string' ? code : 'no-scratch-directory',
  };
}

/**
 * Wraps `runCommandSync` to match the RunCommandFn signature. It returns a non-zero exit as a CommandResult and does not throw.
 * The result carries the error code of the runner as `spawnError`, and the signal.
 * Thus a timeout, an overflow or a signal cannot read as a red exit.
 *
 * Each run gets a new scratch directory and the environment of {@link probeTestEnvironment}, and the runner deletes the directory after the run.
 * Thus the tests of a task cannot write the live store that settle writes in the same call.
 * The limits are the limits of a whole suite. A test sets a short time limit with `timeoutMs`.
 *
 * @internal Exported so a test can run the real spawn and parse chain without the suite of this repository.
 */
export const execCommandRunner: RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
): CommandResult => {
  let scratchDir: string;
  try {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), PROBE_SCRATCH_PREFIX));
  } catch (err: unknown) {
    return scratchFailure(err);
  }
  try {
    const output = runCommandSync(cmd, args, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      env: probeTestEnvironment(process.env, scratchDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options?.timeoutMs ?? WHOLE_SUITE_TIMEOUT_MS,
      maxBuffer: WHOLE_SUITE_MAX_OUTPUT_BYTES,
    });
    return { exitCode: 0, stdout: outputText(output), stderr: '' };
  } catch (err: unknown) {
    const failure = execFailureFields(err);
    return {
      exitCode: exitCodeOfFailure(failure),
      stdout: outputText(failure.stdout),
      stderr: outputText(failure.stderr),
      ...(typeof failure.signal === 'string' ? { signal: failure.signal } : {}),
      ...(typeof failure.code === 'string' ? { spawnError: failure.code } : {}),
    };
  } finally {
    removeProbeScratch(scratchDir);
  }
};

/** Builds the carrier of a run. The report names the source of the profile, and the reason of a term that is not resolved names the route of a remedy. */
function suiteCarrier(
  args: CheckIntegrationSuiteArgs,
  repoRoot: string,
  suite: RunIntegrationSuiteResult,
): CheckIntegrationSuiteResult {
  const profilePath = profilePathOf(args, repoRoot);
  return {
    passed: suite.passed,
    verdict: suite.verdict,
    completeness: suite.completeness,
    failCount: suite.failCount,
    loadFailures: suite.loadFailures,
    failedTests: suite.failedTests,
    failedSuites: suite.failedSuites,
    totalTests: suite.totalTests,
    report: `profile = ${profilePath}\n${suite.report}`,
    parseError: suite.parseError,
    ...(suite.parseFailureKind ? { parseFailureKind: suite.parseFailureKind } : {}),
    ...(suite.noVerdictCause ? { noVerdictCause: suite.noVerdictCause } : {}),
    ...(suite.discriminant ? { discriminant: suite.discriminant } : {}),
    ...(suite.reason === undefined ? {} : { reason: `${profilePath}. ${withProfileRoute(args, suite.reason)}` }),
  };
}

/**
 * Runs the shared gate preflight, then runs the gate inside the durable gate
 * producer. The preflight rejects a miswired event store and an absent
 * `featureId`, and resolves `repoRoot`. `taskId` is optional for this gate.
 * A policy skip gives a passing result with `skipped: true`, and it records a row as a run does.
 *
 * @param runCommand - The runner, {@link execCommandRunner} by default. Tests pass a stub.
 */
export async function handleCheckIntegrationSuite(
  args: CheckIntegrationSuiteArgs,
  stateDir: string,
  eventStore: EventStore,
  runCommand: RunCommandFn = execCommandRunner,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleCheckIntegrationSuite',
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;

  return runDurableGateProducer(
    {
      coordinate: args.coordinate,
      gateClass: 'integration-suite',
      featureId: args.featureId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      baseRef: args.baseBranch ?? 'main',
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const policySkip = resolvePolicySkip({
        gateName: 'check_integration_suite',
        riskTier: args.riskTier,
        boundaryTouching: args.boundaryTouching,
        config: args.projectConfig,
      });
      if (policySkip) {
        return {
          success: true,
          data: {
            passed: true,
            skipped: true,
            failCount: 0,
            report: policySkip.reason,
            discriminant: SKIPPED_BY_POLICY,
          },
        };
      }

      const suite = runIntegrationSuite({
        repoRoot,
        runCommand,
        integration: profileOf(args, repoRoot).integration,
      });
      return { success: true, data: suiteCarrier(args, repoRoot, suite) };
    },
  );
}
