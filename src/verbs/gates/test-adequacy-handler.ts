/**
 * The `check_test_adequacy` handler. It runs the kill probe (mutation testing at N=1) over the diff of a task and persists subject-bound evidence.
 * `test-adequacy.ts` holds the probe itself. This handler wires the production seams.
 *
 * It resolves `repoRoot`, with the worktree-aware `auto` mode. It resolves the merge base of the task base and the head once, as a SHA.
 * The changed-file diff and the revert both use that SHA.
 * It resolves the test command with `resolveScopedTestCommand` and runs it on the changed test files.
 *
 * Evidence persistence is idempotent on the trusted operation id.
 * The result is an advisory carrier: `success: true`, with `data.passed` set from the probe verdict. A failed probe is a finding, not a tool error.
 */

import { mkdtempSync, rmSync, type RmOptions } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFailureFields, outputText, runCommandSync } from '../../utils/process.js';
import { PLUGIN_MODE_ENV_KEYS, STORE_LOCATION_ENV_KEYS } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import {
  defaultGitExec,
  resolvePolicySkip,
  SKIPPED_BY_POLICY,
  type ClosedGateVerdict,
  type GateCarrierVerdict,
} from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { resolveScopedTestCommand, type ScopedTestCommand } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { detectToolchain, resolveProbeTestGlobs, testGlobsForToolchain } from '../../config/toolchains.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import type { GitExec } from '../pure/execute-merge.js';
import {
  runProbe,
  probeNotRun,
  interpretProbeVerdict,
  verdictOf,
  type AdequacyDiscriminant,
  type AdequacyDisposition,
  type ProbeResult,
  type RunOutcome,
  type TestRunFn,
} from './test-adequacy.js';
import { assertNever } from '../../contract/error-families.js';
import { CapsuleBaseRefSchema } from '../../contract/capsule/exarchos-capsule.js';

export interface TestAdequacyArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /**
   * The branch that the task forked from. The diff starts at the merge base of this ref and the task head.
   * There is no default, because a guessed base judges other work. Without a base, the gate blocks with `base-missing`.
   */
  readonly baseBranch?: string;
  /**
   * The repo to probe. A literal path is used as given. `'auto'` resolves the agent worktree of the calling delegation.
   * When absent, the handler uses `process.cwd()`.
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /**
   * Legacy compatibility field. Evidence idempotency is bound exclusively to
   * the trusted DispatchContext operationId.
   */
  readonly operationId?: string;

  /**
   * Legacy phase carrier retained for public input compatibility. Evidence is
   * attributed to the active persisted phaseAttemptId.
   */
  readonly phase?: string;

  /**
   * The task's stamped risk tier. When provided together with
   * {@link boundaryTouching}, the handler self-skips when the resolved
   * verification sequence does not include this gate (`skipped-by-policy`).
   * Absent (legacy callers) → the gate runs unconditionally.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config. The dispatch adapter passes it, so the self-skip reads the same policy as the delegation stamp.
   * A `verification:` cell in `.exarchos.yml` that excludes this gate makes the stamp drop it and this handler skip it.
   * When absent, the resolver uses the built-in table.
   */
  readonly projectConfig?: ResolvedProjectConfig;
  /** Git executor. Defaults to a 30s-ceiling shell-out. */
  readonly gitExec?: GitExec;
  /** Test runner. Defaults to a shell-out of the command that `resolveScopedTestCommand` gives. */
  readonly runTests?: TestRunFn;
}

/** The time limit of one scoped test run of the probe. */
const SCOPED_TEST_TIMEOUT_MS = 120_000;

/** The output limit of one scoped test run of the probe. It is the default limit of `execFileSync`, written here so that the overflow end has a known size. */
const SCOPED_TEST_MAX_OUTPUT_BYTES = 1024 * 1024;

/** The limits of a scoped test run. A test sets short limits to drive a timeout or an overflow with a real process. */
export interface ScopedTestRunLimits {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Writes a list of exit codes as text, such as `1` or `1 or 101`. */
function exitCodeList(codes: readonly number[]): string {
  return codes.join(' or ');
}

/**
 * Reads the error of a scoped test run that did not exit 0. The order of the checks follows the fields that `execFileSync` sets.
 * A timeout and an overflow carry a code and a signal, so the code comes first. A test-failure exit code of the toolchain is a red run.
 * Every other end gives no verdict, with its cause and the fact that names it.
 */
function failedRunOutcome(err: unknown, testFailureExitCodes: readonly number[], limits: Required<ScopedTestRunLimits>): RunOutcome {
  const failure = execFailureFields(err);
  const output = { stdout: outputText(failure.stdout), stderr: outputText(failure.stderr) };
  if (failure.code === 'ETIMEDOUT') {
    return { kind: 'no-verdict', cause: 'timeout', detail: `the limit is ${limits.timeoutMs} ms`, ...output };
  }
  if (failure.code === 'ENOBUFS') {
    return { kind: 'no-verdict', cause: 'overflow', detail: `the limit is ${limits.maxOutputBytes} bytes`, ...output };
  }
  if (typeof failure.code === 'string') {
    return { kind: 'no-verdict', cause: 'did-not-start', detail: `the runner gave the error code ${failure.code}`, ...output };
  }
  if (typeof failure.signal === 'string') {
    return { kind: 'no-verdict', cause: 'signal', detail: `the signal is ${failure.signal}`, ...output };
  }
  if (typeof failure.status !== 'number') {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'no-verdict', cause: 'did-not-start', detail: `the runner gave no exit status: ${message}`, ...output };
  }
  if (testFailureExitCodes.includes(failure.status)) {
    return { kind: 'ran', result: 'red', ...output };
  }
  return {
    kind: 'no-verdict',
    cause: 'unknown-exit-code',
    detail: `the command exited ${failure.status}, and only exit ${exitCodeList(testFailureExitCodes)} reads as a red run`,
    ...output,
  };
}

/** The name prefix of the scratch directory of one probe test run, under the temporary directory of the system. */
export const PROBE_SCRATCH_PREFIX = 'exarchos-probe-';

/** The options of each delete of a probe scratch directory. The retries give a transient Windows lock time to end. */
const PROBE_SCRATCH_REMOVE: RmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

/** True when `key` names the environment key `name`. Windows reads environment keys without case, so the match there ignores case. */
function isEnvKey(key: string, name: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name;
}

/**
 * Returns the environment of one probe test run: a copy of `parent` in which each store key points under `scratchDir`.
 * No plugin-mode key stays. A deleted store key is not enough, because the resolver then falls back to the home directory.
 * Thus a test that resolves its store through these keys does not write the live store that settle writes in the same call.
 * `HOME` and `XDG_STATE_HOME` stay, so a test that builds a store path from them can still reach the live store.
 *
 * @internal Exported so that a test can read the environment without a process.
 */
export function probeTestEnvironment(
  parent: NodeJS.ProcessEnv,
  scratchDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const storeKeys = Object.entries(STORE_LOCATION_ENV_KEYS);
  const removed = [...PLUGIN_MODE_ENV_KEYS, ...storeKeys.map(([, key]) => key)];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (!removed.some((name) => isEnvKey(key, name, platform))) env[key] = value;
  }
  for (const [location, key] of storeKeys) env[key] = path.join(scratchDir, location);
  return env;
}

/** Deletes a probe scratch directory. A failed delete leaves the directory, and the verdict of the run stays. */
function removeProbeScratch(scratchDir: string): void {
  try {
    rmSync(scratchDir, PROBE_SCRATCH_REMOVE);
  } catch {
    return;
  }
}

/**
 * Builds a test runner of the probe from a resolved scoped test command.
 * `splitCommand` tokenizes the command with quoted arguments, and the runner appends the scoped test files after `--`.
 * A package script gets the files as its arguments. vitest, jest, `node --test`, and pytest accept path arguments in this form.
 *
 * Exit 0 is a green run. A test-failure exit code of the toolchain is a red run. Every other end gives no verdict, with its cause.
 * The runner uses `runCommandSync`, not `execFileSync`. On Windows, `execFile` refuses a `.cmd` shim with EINVAL.
 *
 * Each run gets a new scratch directory and the environment of {@link probeTestEnvironment}. The runner deletes the directory after the run.
 *
 * @internal Exported so that a test can run real processes through the runner of the probe.
 */
export function buildScopedTestRunner(
  scoped: ScopedTestCommand | null,
  repoRoot: string,
  limits: ScopedTestRunLimits = {},
): TestRunFn {
  const resolvedLimits: Required<ScopedTestRunLimits> = {
    timeoutMs: limits.timeoutMs ?? SCOPED_TEST_TIMEOUT_MS,
    maxOutputBytes: limits.maxOutputBytes ?? SCOPED_TEST_MAX_OUTPUT_BYTES,
  };
  return async ({ testFiles }) => {
    if (scoped === null || scoped.command.trim().length === 0) {
      return { kind: 'no-verdict', cause: 'no-command', detail: 'the resolver gave no scoped test command' };
    }
    let bin: string;
    let rest: readonly string[];
    try {
      const tokens = splitCommand(scoped.command);
      bin = tokens.cmd;
      rest = tokens.args;
    } catch (err) {
      return {
        kind: 'no-verdict',
        cause: 'unparseable-command',
        detail: `the command is "${scoped.command}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!bin) {
      return { kind: 'no-verdict', cause: 'no-command', detail: `the command "${scoped.command}" names no program` };
    }
    let scratchDir: string;
    try {
      scratchDir = mkdtempSync(path.join(os.tmpdir(), PROBE_SCRATCH_PREFIX));
    } catch (err) {
      return {
        kind: 'no-verdict',
        cause: 'did-not-start',
        detail: `the scratch directory of the run was not made: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      const stdout = runCommandSync(bin, [...rest, '--', ...testFiles], {
        cwd: repoRoot,
        env: probeTestEnvironment(process.env, scratchDir),
        timeout: resolvedLimits.timeoutMs,
        maxBuffer: resolvedLimits.maxOutputBytes,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { kind: 'ran', result: 'green', stdout: outputText(stdout) };
    } catch (err) {
      return failedRunOutcome(err, scoped.testFailureExitCodes, resolvedLimits);
    } finally {
      removeProbeScratch(scratchDir);
    }
  };
}

/**
 * Builds the production test runner from the scoped test command of `repoRoot`. A `test:files` package script comes first, and the resolved test command is the fallback.
 * The toolchain registry gives the exit codes of a red run. With no known toolchain, only exit 1 is red.
 */
export function buildDefaultRunTests(repoRoot: string, limits: ScopedTestRunLimits = {}): TestRunFn {
  return buildScopedTestRunner(resolveScopedTestCommand(repoRoot), repoRoot, limits);
}

/** The changed files and the deleted subset of them, or the detail of a git failure. */
export type ChangedFilesResult =
  | { readonly ok: true; readonly files: string[]; readonly deletedFiles: string[] }
  | { readonly ok: false; readonly detail: string };

/** A status token of `git diff --no-renames --name-status`: one status letter, as no rename or copy record occurs. */
const NAME_STATUS_TOKEN = /^[ADMTUX]$/;

/**
 * Parses the NUL-separated output of `git diff -z --no-renames --name-status`. Each record is a status token and one path.
 * A record that does not parse returns null, so the caller fails closed and does not probe a partial list.
 */
function parseNameStatus(stdout: string): { files: string[]; deletedFiles: string[] } | null {
  const tokens = stdout.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length % 2 !== 0) return null;
  const files: string[] = [];
  const deletedFiles: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index] ?? '';
    const file = tokens[index + 1] ?? '';
    if (!NAME_STATUS_TOKEN.test(status) || file.length === 0) return null;
    files.push(file);
    if (status === 'D') deletedFiles.push(file);
  }
  return { files, deletedFiles };
}

/**
 * Computes the repo-relative files that the task diff changes, and the subset that the head side deletes.
 * The HEAD side is the task `branch` when the caller names one, and the checked-out `HEAD` otherwise.
 * A fixed `HEAD` probes the wrong tree when `repoRoot` is not the task worktree, and gives an empty diff and a vacuous pass.
 * The diff is NUL-separated (`-z`), so git does not quote a path with non-ASCII characters.
 * Rename detection is off, so a renamed file is a deletion and an addition, whatever the git config of the repository says.
 * A git failure or an output that does not parse returns `ok: false`, so the gate fails instead of skipping on an empty diff.
 */
export function changedFilesFor(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  headRef?: string,
): ChangedFilesResult {
  const head = headRef && headRef.trim().length > 0 ? headRef.trim() : 'HEAD';
  const result = gitExec(repoRoot, ['diff', '-z', '--no-renames', '--name-status', `${baseRef}...${head}`]);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail: `git diff ${baseRef}...${head} exited ${result.exitCode}: ${result.stdout.trim()}`,
    };
  }
  const parsed = parseNameStatus(result.stdout);
  if (parsed === null) {
    return {
      ok: false,
      detail: `git diff -z --no-renames --name-status ${baseRef}...${head} gave output that does not parse`,
    };
  }
  return { ok: true, files: parsed.files, deletedFiles: parsed.deletedFiles };
}

/** The merge base that the task diff is measured from, or the reason that git did not resolve it. */
export type MergeBaseResult =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Resolves the merge base of the task base and its head once, as a commit SHA.
 * The changed-file diff and the revert both read this SHA, so the probe reverts the files to the commit that measured them.
 * It refuses a base outside the safe ref pattern of the capsule, or a head that starts with a dash, before git sees it.
 * Git reads such a value as an option.
 */
export function resolveMergeBase(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  headRef?: string,
): MergeBaseResult {
  const head = headRef && headRef.trim().length > 0 ? headRef.trim() : 'HEAD';
  if (!CapsuleBaseRefSchema.safeParse(baseRef).success || head.startsWith('-')) {
    return {
      ok: false,
      detail: `the base ${JSON.stringify(baseRef)} or the head ${JSON.stringify(head)} is not a safe ref, so no merge base was resolved`,
    };
  }
  const result = gitExec(repoRoot, ['merge-base', baseRef, head]);
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return { ok: false, detail: `git merge-base ${baseRef} ${head} exited ${result.exitCode}: ${sha}` };
  }
  return { ok: true, sha };
}

/** The probe detail when the caller names no base. */
const BASE_MISSING_DETAIL =
  'no base was supplied (`baseBranch`), so the task diff has nothing to be measured from. ' +
  'Pass the branch the task forked from: settle reads it from the capsule, and the primitive ' +
  "path takes it from prepare_delegation's `baseBranch`";

/**
 * Runs the preflight, then the kill probe inside the durable gate producer.
 * The preflight validates the dispatch context and the inputs, and resolves the worktree-aware `auto` repo root.
 * A policy skip returns a labelled advisory skip, not proof, because the ladder routed the gate out of the sequence.
 * The test globs of the toolchain add to the co-located `*.test.*` conventions and do not replace them.
 */
export async function handleTestAdequacy(
  args: TestAdequacyArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleTestAdequacy',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseBranch = args.baseBranch && args.baseBranch.trim().length > 0 ? args.baseBranch.trim() : undefined;

  return runDurableGateProducer(
    {
      gateClass: 'test-adequacy',
      featureId: args.featureId,
      taskId: args.taskId,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(baseBranch ? { baseRef: baseBranch } : {}),
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const policySkip = resolvePolicySkip({
        gateName: 'check_test_adequacy',
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
            disposition: 'advisory-skip',
            verdict: 'indeterminate',
            completeness: 'complete',
            redObserved: false,
            restoredClean: true,
            probedTests: [],
            discriminant: SKIPPED_BY_POLICY,
            reason: policySkip.reason,
          } satisfies AdequacyCarrier,
        };
      }

      if (baseBranch === undefined) {
        return {
          success: true,
          data: buildAdequacyCarrier(probeNotRun('base-missing', BASE_MISSING_DETAIL, args.riskTier), args.riskTier),
        };
      }

      const gitExec = args.gitExec ?? defaultGitExec;
      const runTests = args.runTests ?? buildDefaultRunTests(repoRoot);
      const mergeBase = resolveMergeBase(gitExec, repoRoot, baseBranch, args.branch);
      const changed: ChangedFilesResult = mergeBase.ok
        ? changedFilesFor(gitExec, repoRoot, mergeBase.sha, args.branch)
        : { ok: false, detail: mergeBase.detail };
      const toolchain = detectToolchain(repoRoot);
      const testGlobs = resolveProbeTestGlobs(
        toolchain ? testGlobsForToolchain(toolchain.id) : null,
      );

      const probe: ProbeResult = await runProbe({
        gitExec,
        repoRoot,
        baseRef: mergeBase.ok ? mergeBase.sha : baseBranch,
        changedFiles: changed.ok ? changed.files : [],
        ...(changed.ok ? { deletedFiles: changed.deletedFiles } : { diffFailed: true }),
        ...(args.riskTier ? { riskTier: args.riskTier } : {}),
        runTests,
        testGlobs,
      });

      return {
        success: true,
        data: buildAdequacyCarrier(probe, args.riskTier),
      };
    },
  );
}

/**
 * The advisory carrier the gate returns, derived from the probe's verdict.
 * It states the closed gate verdict, so the evidence verdict does not depend on how a reader combines the other fields.
 */
export interface AdequacyCarrier extends ClosedGateVerdict {
  readonly passed: boolean;
  readonly disposition: AdequacyDisposition;
  readonly redObserved: boolean;
  readonly restoredClean: boolean;
  readonly probedTests: readonly string[];
  readonly skipped?: boolean;
  readonly discriminant?: string;
  readonly report?: string;
  readonly reason?: string;
}

/**
 * The carrier verdict of a probe that blocks on an indeterminate cause.
 * A red run on the task source and a run with no verdict say nothing about the tests of the task, so they give `indeterminate`.
 * The other causes keep the `fail` that they gave before the carrier stated a verdict. A change of them needs a decision of the owner.
 */
const BLOCKED_CAUSE_VERDICT: Readonly<Record<AdequacyDiscriminant, GateCarrierVerdict>> = {
  'no-new-tests': 'fail',
  'diff-failed': 'fail',
  'revert-conflict': 'fail',
  'restore-failed': 'fail',
  'base-missing': 'fail',
  'baseline-red': 'indeterminate',
  'run-no-verdict': 'indeterminate',
};

/**
 * Translates a {@link ProbeResult} into the advisory carrier with an exhaustive switch on the verdict union.
 * An `indeterminate` verdict (the probe cannot run) must be handled here, so it cannot arrive as a success.
 * An indeterminate verdict that degrades to an advisory skip carries `skipped: true` and the verdict `indeterminate`, so a reader can tell a skip from a pass.
 * The probe is one check, so each carrier states the completeness `complete`.
 * `verdictOf` uses the stamped union, or rebuilds one fail-closed, so a legacy-shaped result is judged by the union too.
 * A new verdict variant fails the build at `assertNever`.
 */
function buildAdequacyCarrier(probe: ProbeResult, riskTier?: RiskTier): AdequacyCarrier {
  const verdict = verdictOf(probe);
  const interpretation = interpretProbeVerdict(verdict, riskTier);

  const base = {
    passed: interpretation.passed,
    disposition: interpretation.disposition,
    completeness: 'complete',
    redObserved: probe.redObserved === true,
    restoredClean: probe.restoredClean !== false,
    probedTests: probe.probedTests ?? [],
    ...(interpretation.report ? { report: interpretation.report } : {}),
  } satisfies Omit<AdequacyCarrier, 'verdict'>;

  switch (verdict.kind) {
    case 'passed':
      return { ...base, verdict: 'pass' };
    case 'failed':
      return { ...base, verdict: 'fail' };
    case 'indeterminate':
      return {
        ...base,
        verdict: interpretation.skipped ? 'indeterminate' : BLOCKED_CAUSE_VERDICT[verdict.cause],
        discriminant: verdict.cause,
        ...(interpretation.skipped ? { skipped: true } : {}),
      };
    default:
      return assertNever(verdict, 'ProbeVerdict');
  }
}
