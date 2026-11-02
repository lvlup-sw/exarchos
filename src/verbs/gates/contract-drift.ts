/**
 * The core of the check_contract_drift gate. It checks that the schema-boundary
 * changes of a task do not break the contract. It runs codegen, then a
 * typecheck of the output, then a breaking-change diff.
 *
 * The gate reports findings. It does not change the working tree or hold a
 * lock. Git and the command runner are injected, so unit tests run no shell
 * command. When no contract command resolves, the gate gives an advisory pass
 * with `skipped: true`, not a fail.
 */

import type { GitExec } from '../pure/execute-merge.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';

/** Result of running a single contract leg (codegen / typecheck / diff). */
export interface CommandRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Injected runner that runs the argv of one contract leg in the repo and
 * returns its exit code + combined output. Async to match real shell-outs.
 * The argv comes from the profile, so no runner splits a string.
 */
export type CommandRunFn = (input: {
  readonly repoRoot: string;
  readonly argv: readonly string[];
}) => Promise<CommandRunResult>;

export interface ContractDriftArgs {
  readonly repoRoot: string;
  /** Base ref the branch diverged from — the merge-base is computed against this. */
  readonly baseRef: string;
  /**
   * The `contract` term of the verification profile. An unresolved `codegen` or `diff` skips that leg.
   * An unresolved `typecheck` skips the typecheck leg. When both `codegen` and `diff` are unresolved, the gate skips.
   */
  readonly contract: VerificationProfile['contract'];
  /** Git executor (injected). */
  readonly gitExec: GitExec;
  /** Command runner (injected). */
  readonly runCommand: CommandRunFn;
}

export interface ContractDriftResult {
  /**
   * The gate verdict. PASS means: every wired leg succeeded and the breaking-
   * diff reported no breakage. A skipped gate (no tool) also passes (advisory).
   */
  readonly passed: boolean;
  /** True when the breaking-diff reported breaking changes. */
  readonly drift: boolean;
  /** The breaking-change lines surfaced by the diff tool (empty when none). */
  readonly breaking: string[];
  /** Human-readable summary of what the gate did and found. */
  readonly report: string;
  /** True when no contract command resolved, which gives an advisory pass. */
  readonly skipped?: boolean;
  /** The discriminant of a skip: the profile does not resolve the contract term. */
  readonly discriminant?: typeof PROFILE_UNRESOLVED;
  /** The reason of a skip. It holds the reason of the `contract.codegen` term and of the `contract.diff` term. */
  readonly reason?: string;
  /** The merge-base sha, when git computes it. The report shows it, but the diff command does not use it. */
  readonly baseline?: string;
}

/**
 * Extracts the breaking-change lines from the stdout of a diff tool. A line
 * that starts with `breaking`, `err`, or `error`, in any case, matches. A clean
 * line such as "no breaking changes" does not match.
 */
function extractBreaking(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /^(breaking\b|err\b|error\b)/i.test(l));
}

/**
 * Computes `git merge-base <baseRef> HEAD`. It returns null when git fails,
 * and the report then says that the gate cannot compute the baseline.
 */
function computeMergeBase(gitExec: GitExec, repoRoot: string, baseRef: string): string | null {
  const result = gitExec(repoRoot, ['merge-base', baseRef, 'HEAD']);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Runs the contract-drift gate. Each leg runs only when its command is resolved.
 *   1. With no codegen and no diff command, it gives a skipped advisory pass with `profile-unresolved` and a reason.
 *   2. It writes the merge-base of `baseRef` and HEAD to the report.
 *   3. A non-zero codegen or typecheck exit fails the gate with `drift: false`.
 *   4. A non-zero diff exit or a breaking line is drift and fails the gate.
 *      Diff tools exit non-zero on a breaking change. With no breaking line,
 *      the raw output becomes the finding, so the finding is not empty.
 */
export async function runContractDrift(args: ContractDriftArgs): Promise<ContractDriftResult> {
  const { repoRoot, baseRef, contract, gitExec, runCommand } = args;
  const { codegen, typecheck, diff } = contract;

  if (codegen.state === 'unresolved' && diff.state === 'unresolved') {
    return {
      passed: true,
      drift: false,
      breaking: [],
      skipped: true,
      discriminant: PROFILE_UNRESOLVED,
      reason: `${codegen.reason} ${diff.reason}`,
      report:
        'check_contract_drift skipped: no contract codegen/diff command resolved ' +
        '(no .exarchos.yml contract: block and no artifact-keyed tool detected). Advisory pass.',
    };
  }

  const baseline = computeMergeBase(gitExec, repoRoot, baseRef);
  const reportLines: string[] = [];
  reportLines.push(
    baseline
      ? `baseline = merge-base(${baseRef}, HEAD) = ${baseline}`
      : `baseline = merge-base(${baseRef}, HEAD) could not be computed`,
  );

  if (codegen.state === 'resolved') {
    const cg = await runCommand({ repoRoot, argv: codegen.argv });
    if (cg.exitCode !== 0) {
      reportLines.push(`codegen FAILED (exit ${cg.exitCode}): ${cg.stdout.trim()}`);
      return {
        passed: false,
        drift: false,
        breaking: [],
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('codegen ok');
  }

  if (typecheck.state === 'resolved') {
    const tc = await runCommand({ repoRoot, argv: typecheck.argv });
    if (tc.exitCode !== 0) {
      reportLines.push(`typecheck FAILED (exit ${tc.exitCode}): ${tc.stdout.trim()}`);
      return {
        passed: false,
        drift: false,
        breaking: [],
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('typecheck ok');
  }

  if (diff.state === 'resolved') {
    const df = await runCommand({ repoRoot, argv: diff.argv });
    const breaking = extractBreaking(df.stdout);
    const isDrift = df.exitCode !== 0 || breaking.length > 0;
    if (isDrift) {
      const surfaced =
        breaking.length > 0
          ? breaking
          : [`breaking-diff reported drift (exit ${df.exitCode}): ${df.stdout.trim() || '<no output>'}`];
      reportLines.push(`breaking-diff DRIFT: ${surfaced.length} finding(s)`);
      return {
        passed: false,
        drift: true,
        breaking: surfaced,
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('breaking-diff clean');
  }

  return {
    passed: true,
    drift: false,
    breaking: [],
    report: reportLines.join('\n'),
    ...(baseline ? { baseline } : {}),
  };
}
