/**
 * The `check_test_adequacy` handler. It runs the kill probe (mutation testing at N=1) over the diff of a task and persists subject-bound evidence.
 * `test-adequacy.ts` holds the probe itself. This handler wires the production seams.
 *
 * It resolves `repoRoot`, with the worktree-aware `auto` mode. It resolves the merge base of the task base and the head once, as a SHA.
 * The changed-file diff and the revert both use that SHA.
 * It resolves the test command with `resolveTestRuntime` and runs it on the changed test files.
 *
 * Evidence persistence is idempotent on the trusted operation id.
 * The result is an advisory carrier: `success: true`, with `data.passed` set from the probe verdict. A failed probe is a finding, not a tool error.
 */

import { runCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { defaultGitExec, resolvePolicySkip, SKIPPED_BY_POLICY } from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { resolveTestRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { detectToolchain, testGlobsForToolchain } from '../../config/toolchains.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import type { GitExec } from '../pure/execute-merge.js';
import {
  runProbe,
  probeNotRun,
  resolveProbeTestGlobs,
  interpretProbeVerdict,
  verdictOf,
  type ProbeResult,
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
  /** Test runner. Defaults to the resolveTestRuntime-backed shell-out. */
  readonly runTests?: TestRunFn;
}

/**
 * Builds the production test runner from the resolved test command.
 * `splitCommand` tokenizes the command with quoted arguments, and the runner appends the scoped test files after `--`.
 * vitest, jest, `node --test`, and pytest accept path arguments in this form.
 *
 * A missing, blank, or unparseable command counts as a passing run, so the probe reports `redObserved: false` and never a false kill.
 * The runner uses `runCommandSync`, not `execFileSync`. On Windows, `execFile` refuses a `.cmd` shim with EINVAL.
 * With `execFile`, the catch reads that error as a red test and falsely passes the kill probe.
 */
function buildDefaultRunTests(repoRoot: string): TestRunFn {
  const resolved = resolveTestRuntime(repoRoot);
  const testCmd = resolved.test;
  return async ({ testFiles }) => {
    if (!testCmd) {
      return { passed: true, output: 'no resolvable test command' };
    }
    let bin: string;
    let rest: readonly string[];
    try {
      const tokens = splitCommand(testCmd);
      bin = tokens.cmd;
      rest = tokens.args;
    } catch (err) {
      return {
        passed: true,
        output: `unparseable test command "${testCmd}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!bin) {
      return { passed: true, output: 'no resolvable test command' };
    }
    const args = [...rest, '--', ...testFiles];
    try {
      const output = runCommandSync(bin, args, {
        cwd: repoRoot,
        timeout: 120_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { passed: true, output: output.toString() };
    } catch (err) {
      const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
      const out =
        (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
        (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
      return { passed: false, output: out };
    }
  };
}

/** The changed files, or the detail of a git failure. */
export type ChangedFilesResult =
  | { readonly ok: true; readonly files: string[] }
  | { readonly ok: false; readonly detail: string };

/**
 * Computes the repo-relative files that the task diff changes.
 * The HEAD side is the task `branch` when the caller names one, and the checked-out `HEAD` otherwise.
 * A fixed `HEAD` probes the wrong tree when `repoRoot` is not the task worktree, and gives an empty diff and a vacuous pass.
 * A git failure returns `ok: false`, so the gate fails instead of skipping on an empty diff.
 */
export function changedFilesFor(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  headRef?: string,
): ChangedFilesResult {
  const head = headRef && headRef.trim().length > 0 ? headRef.trim() : 'HEAD';
  const result = gitExec(repoRoot, ['diff', '--name-only', `${baseRef}...${head}`]);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail: `git diff ${baseRef}...${head} exited ${result.exitCode}: ${result.stdout.trim()}`,
    };
  }
  return {
    ok: true,
    files: result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  };
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
            redObserved: false,
            restoredClean: true,
            probedTests: [],
            discriminant: SKIPPED_BY_POLICY,
            reason: policySkip.reason,
          },
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
        ...(changed.ok ? {} : { diffFailed: true }),
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

/** The advisory carrier the gate returns, derived from the probe's verdict. */
interface AdequacyCarrier {
  readonly passed: boolean;
  readonly disposition: string;
  readonly redObserved: boolean;
  readonly restoredClean: boolean;
  readonly probedTests: readonly string[];
  readonly skipped?: boolean;
  readonly discriminant?: string;
  readonly report?: string;
}

/**
 * Translates a {@link ProbeResult} into the advisory carrier with an exhaustive switch on the verdict union.
 * An `indeterminate` verdict (the probe cannot run) must be handled here, so it cannot arrive as a success.
 * An indeterminate verdict that degrades to an advisory skip carries `skipped: true`, so a reader can tell a skip from a pass.
 * `verdictOf` uses the stamped union, or rebuilds one fail-closed, so a legacy-shaped result is judged by the union too.
 * A new verdict variant fails the build at `assertNever`.
 */
function buildAdequacyCarrier(probe: ProbeResult, riskTier?: RiskTier): AdequacyCarrier {
  const verdict = verdictOf(probe);
  const interpretation = interpretProbeVerdict(verdict, riskTier);

  const base = {
    passed: interpretation.passed,
    disposition: interpretation.disposition,
    redObserved: probe.redObserved === true,
    restoredClean: probe.restoredClean !== false,
    probedTests: probe.probedTests ?? [],
    ...(interpretation.report ? { report: interpretation.report } : {}),
  };

  switch (verdict.kind) {
    case 'passed':
      return base;
    case 'failed':
      return base;
    case 'indeterminate':
      return {
        ...base,
        discriminant: verdict.cause,
        ...(interpretation.skipped ? { skipped: true } : {}),
      };
    default:
      return assertNever(verdict, 'ProbeVerdict');
  }
}
