/**
 * Pure preflight helpers for the autonomous merge orchestrator: topology checks and drift
 * detection. Callers inject a `GitExec` that returns `{ stdout, exitCode }`. The exit code
 * separates a detached HEAD from other failures, so this contract is richer than the
 * bare-string `gitExec` of `dispatch-guard.ts`. `mergePreflight` adapts between the two shapes.
 */

import {
  validateBranchAncestry,
  getCurrentBranch,
  assertCurrentBranchNotProtected,
  assertMainWorktree,
  type AncestryResult,
  type CurrentBranchProtectionResult,
  type WorktreeAssertionResult,
  type GitExec as DispatchGuardGitExec,
} from '../team/dispatch-guard.js';

export interface GitExecResult {
  readonly stdout: string;
  /**
   * Captured stderr. It is optional, because an adapter that merges the descriptors cannot
   * separate it. An absent value means "not captured separately", not "empty".
   */
  readonly stderr?: string;
  readonly exitCode: number;
}

export type GitExec = (
  repoRoot: string,
  args: readonly string[],
) => GitExecResult;

export interface DriftResult {
  /** True when the working tree has no uncommitted changes, the index is
   * not stale, and HEAD is on a named branch. */
  readonly clean: boolean;
  /** Files reported by `git status --porcelain`. */
  readonly uncommittedFiles: readonly string[];
  /** True when `git diff --cached --quiet` exits non-zero: staged changes, or a failed command. */
  readonly indexStale: boolean;
  /** True when `git rev-parse --abbrev-ref HEAD` returns `HEAD`, or fails. */
  readonly detachedHead: boolean;
}

/**
 * Parses `git status --porcelain` output into paths. Each line is `XY <path>`, so the path
 * starts at index 3. A rename keeps the full `old -> new` segment, because callers only need to
 * know that the tree is dirty.
 */
function parsePorcelainPaths(stdout: string): readonly string[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

/**
 * Detects working-tree drift relative to HEAD with three signals: `uncommittedFiles`,
 * `indexStale`, and `detachedHead`. `clean` is true only when all three are absent. It fails
 * closed: a failed `git status` adds a placeholder path, and a failed `git diff` or
 * `git rev-parse` counts as drift. It reports drift and does not recover.
 */
export function detectDrift(
  gitExec: GitExec,
  repoRoot: string = process.cwd(),
): DriftResult {
  const status = gitExec(repoRoot, ['status', '--porcelain']);
  const uncommittedFiles = status.exitCode === 0
    ? parsePorcelainPaths(status.stdout)
    : ['<git status failed>'];

  const cached = gitExec(repoRoot, ['diff', '--cached', '--quiet']);
  const indexStale = cached.exitCode !== 0;

  const head = gitExec(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const detachedHead = head.exitCode !== 0 || head.stdout.trim() === 'HEAD';

  const clean =
    uncommittedFiles.length === 0 && !indexStale && !detachedHead;

  return { clean, uncommittedFiles, indexStale, detachedHead };
}

export interface MergePreflightArgs {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly gitExec: GitExec;
  readonly cwd?: string;
}

export interface MergePreflightResult {
  /** True only when every guard passes and the working tree is clean. */
  readonly passed: boolean;
  readonly ancestry: AncestryResult;
  readonly currentBranchProtection: CurrentBranchProtectionResult;
  readonly worktree: WorktreeAssertionResult;
  readonly drift: DriftResult;
  /** Debug payload, set only when `EXARCHOS_PREFLIGHT_DEBUG=1` and ancestry fails. */
  readonly debug?: PreflightDebug;
}

/**
 * Diagnostic payload for an ancestry failure. Each field is best-effort, so the helper cannot throw
 * and hide the ancestry failure. The field order is the reading order for an operator.
 */
export interface PreflightDebug {
  /** Output of `git --version`, stripped of trailing newlines. */
  readonly gitVersion: string;
  /** Output of `git rev-parse --show-toplevel`, stripped of trailing newlines. */
  readonly repoRoot: string;
  /** Verbatim porcelain output of `git worktree list --porcelain`. */
  readonly worktreeList: string;
  /** SHA + packed-status of the source branch ref. */
  readonly refsHeadsSource: { readonly sha: string; readonly packed: boolean };
  /** SHA + packed-status of the target branch ref. */
  readonly refsHeadsTarget: { readonly sha: string; readonly packed: boolean };
  /** The exact argv used for `merge-base --is-ancestor`, including the
   * leading `'git'` literal so the operator can copy-paste verbatim. */
  readonly mergeBaseCommand: readonly string[];
  /** Exit code returned by the `merge-base --is-ancestor` invocation. */
  readonly mergeBaseExitCode: number;
  /** Stdout captured from the `merge-base --is-ancestor` invocation. */
  readonly mergeBaseStdout: string;
  /** Stderr of the `merge-base --is-ancestor` call, or empty when the adapter does not capture it. */
  readonly mergeBaseStderr: string;
}

/**
 * Collects the ancestry debug payload through the injected `gitExec`, and does not throw. A throw
 * from `gitExec` counts as exit 1 with empty output. A non-zero exit gives an empty string for the
 * version, root, worktree, and ref fields. The `merge-base` fields keep the raw exit code and
 * output. `packed` is always `false`, and an empty `sha` marks a failed ref lookup.
 */
export function gatherPreflightDebug(
  gitExec: GitExec,
  repoRoot: string,
  source: string,
  target: string,
): PreflightDebug {
  const safe = (
    args: readonly string[],
  ): { stdout: string; stderr?: string; exitCode: number } => {
    try {
      return gitExec(repoRoot, args);
    } catch {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
  };

  const versionRes = safe(['--version']);
  const gitVersion = versionRes.exitCode === 0 ? versionRes.stdout.trim() : '';

  const toplevelRes = safe(['rev-parse', '--show-toplevel']);
  const reportedRoot =
    toplevelRes.exitCode === 0 ? toplevelRes.stdout.trim() : '';

  const worktreeRes = safe(['worktree', 'list', '--porcelain']);
  const worktreeList = worktreeRes.exitCode === 0 ? worktreeRes.stdout : '';

  const refFor = (
    branch: string,
  ): { sha: string; packed: boolean } => {
    const refRes = safe([
      'for-each-ref',
      '--format=%(objectname) %(if)%(refname)%(then)%(refname)%(end)',
      `refs/heads/${branch}`,
    ]);
    const sha =
      refRes.exitCode === 0 ? refRes.stdout.trim().split(/\s+/)[0] ?? '' : '';
    if (sha !== '') {
      safe(['cat-file', '-e', sha]);
    }
    return { sha, packed: false };
  };

  const refsHeadsSource = refFor(source);
  const refsHeadsTarget = refFor(target);

  const mergeBaseCommand: readonly string[] = [
    'git',
    'merge-base',
    '--is-ancestor',
    target,
    source,
  ];
  const mbRes = safe(['merge-base', '--is-ancestor', target, source]);
  return {
    gitVersion,
    repoRoot: reportedRoot,
    worktreeList,
    refsHeadsSource,
    refsHeadsTarget,
    mergeBaseCommand,
    mergeBaseExitCode: mbRes.exitCode,
    mergeBaseStdout: mbRes.stdout,
    mergeBaseStderr: mbRes.stderr ?? '',
  };
}

/**
 * Adapts the rich `GitExec` to the bare-string `GitExec` of dispatch-guard. On a non-zero exit
 * it throws with `.status` set to the exit code, so `validateBranchAncestry` can separate a
 * missing ancestry (exit 1) from a git error.
 */
function adaptToDispatchGuardExec(
  gitExec: GitExec,
  repoRoot: string,
): DispatchGuardGitExec {
  return (args) => {
    const result = gitExec(repoRoot, args);
    if (result.exitCode !== 0) {
      const err = new Error(
        `git ${args.join(' ')} exited with code ${result.exitCode}`,
      ) as Error & { status?: number };
      err.status = result.exitCode;
      throw err;
    }
    return result.stdout;
  };
}

/**
 * Builds the operator hint for an ancestry failure: the `git rebase` command and the delegate
 * runbook anchor. The command omits the source branch, because `git rebase <target> <source>`
 * checks out the source, and that fails when another worktree holds it. It does not rebase.
 */
function formatAncestryRemediation(
  sourceBranch: string,
  targetBranch: string,
): string {
  return (
    `source branch ${sourceBranch} is not a descendant of ${targetBranch}. ` +
    `Rebase manually with: git rebase ${targetBranch} (run from the ${sourceBranch} worktree). ` +
    `Runbook: content/delivery/skills/delegate/SKILL.md#when-integration-advances-mid-wave`
  );
}

/**
 * Composes the four preflight guards: ancestry, current-branch protection, main worktree, and
 * drift. All four must pass before a merge.
 *
 * The ancestry check passes `sourceBranch` as the integration branch and `targetBranch` as the
 * upstream, so the target must be an ancestor of the source. An `ancestry` failure gets the
 * remediation hint here, because only this caller knows the runbook target. The debug payload
 * attaches only on an ancestry failure with the debug flag set, so a passing preflight adds no
 * event-store growth.
 */
export async function mergePreflight(
  args: MergePreflightArgs,
): Promise<MergePreflightResult> {
  const repoRoot = args.cwd ?? process.cwd();
  const adapter = adaptToDispatchGuardExec(args.gitExec, repoRoot);

  const ancestryRaw = await validateBranchAncestry(
    args.sourceBranch,
    [args.targetBranch],
    adapter,
  );

  const ancestry: AncestryResult =
    ancestryRaw.reason === 'ancestry'
      ? {
          ...ancestryRaw,
          hint: formatAncestryRemediation(
            args.sourceBranch,
            args.targetBranch,
          ),
        }
      : ancestryRaw;

  const currentBranch = getCurrentBranch(adapter);
  const currentBranchProtection = assertCurrentBranchNotProtected(currentBranch);
  const worktree = assertMainWorktree(repoRoot);
  const drift = detectDrift(args.gitExec, repoRoot);

  const passed =
    ancestry.passed &&
    !currentBranchProtection.blocked &&
    worktree.isMain &&
    drift.clean;

  let debug: PreflightDebug | undefined;
  if (
    process.env.EXARCHOS_PREFLIGHT_DEBUG === '1' &&
    !ancestry.passed
  ) {
    debug = gatherPreflightDebug(
      args.gitExec,
      repoRoot,
      args.sourceBranch,
      args.targetBranch,
    );
  }

  return {
    passed,
    ancestry,
    currentBranchProtection,
    worktree,
    drift,
    ...(debug !== undefined ? { debug } : {}),
  };
}
