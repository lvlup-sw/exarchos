/**
 * Merge Preflight — pure helpers for the autonomous merge orchestrator.
 *
 * Implements pieces of DR-MO-1 (topology preflight) and DR-MO-4 (drift
 * detection). This module is split across multiple TDD tasks:
 *
 *   T04 — detectDrift clean-tree path
 *   T05 — detectDrift dirty-tree / stale-index / detached-HEAD extensions
 *   T06 — composed mergePreflight entry point (this commit; happy path only)
 *   T07 — mergePreflight failure-path coverage (next)
 *
 * The `GitExec` injection point keeps the module unit-testable: callers
 * supply a function that runs `git` with a repo root and arg array and
 * returns the captured `{ stdout, exitCode }`. T05 needs `exitCode` to
 * distinguish detached HEAD from other failures, which is why this
 * contract is richer than the bare-string `gitExec` used by
 * `setup-worktree.ts` / `dispatch-guard.ts`. `mergePreflight` adapts
 * between the two shapes internally.
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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitExecResult {
  readonly stdout: string;
  /**
   * Captured stderr from the underlying git invocation. Optional: adapters
   * that cannot separate stderr from stdout (e.g., a subprocess wrapper that
   * merges descriptors) may omit it, in which case consumers should treat
   * the absence as "not separately captured" rather than "definitely empty".
   * The production `defaultGitExec` in merge-orchestrate.ts captures stderr
   * separately on failure so phase-1 diagnostics can distinguish git's
   * error output from any partial stdout.
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
  /** True when `git diff --cached --quiet` reports staged-but-uncommitted
   * changes (exit code != 0). */
  readonly indexStale: boolean;
  /** True when HEAD is detached (i.e., `git rev-parse --abbrev-ref HEAD`
   * returns the literal string "HEAD"). */
  readonly detachedHead: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain` output into a list of paths.
 *
 * Each non-empty line has the form `XY <path>` where XY is two status
 * characters followed by a space. We slice from index 3 to extract the
 * path. Renames (`R  old -> new`) are reported via the full segment as a
 * v1 minimal-handling decision; callers only care that the working tree
 * is dirty, not the exact file accounting.
 */
function parsePorcelainPaths(stdout: string): readonly string[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

// ─── detectDrift ────────────────────────────────────────────────────────────

/**
 * Detect working-tree drift relative to HEAD.
 *
 * Reports three independent drift signals:
 *   1. `uncommittedFiles` — paths from `git status --porcelain`.
 *   2. `indexStale` — `git diff --cached --quiet` exited non-zero (staged
 *      changes present that aren't yet committed).
 *   3. `detachedHead` — `git rev-parse --abbrev-ref HEAD` returned `HEAD`.
 *
 * `clean` is true only when all three signals are absent. Per DR-MO-4,
 * this is fail-only — no auto-recovery is attempted here.
 */
export function detectDrift(
  gitExec: GitExec,
  repoRoot: string = process.cwd(),
): DriftResult {
  // Fail closed: a non-zero exit from `git status` or `git rev-parse` means
  // the working state is unknown — treat it as drift rather than as
  // "no files / not detached", which would let a broken repo or bad
  // `repoRoot` slip through preflight.
  const status = gitExec(repoRoot, ['status', '--porcelain']);
  const uncommittedFiles = status.exitCode === 0
    ? parsePorcelainPaths(status.stdout)
    : ['<git status failed>'];

  // For `git diff --cached --quiet`, exit code is the signal: 0=clean, 1=dirty.
  // Any other non-zero code means the command itself failed — treat as stale.
  const cached = gitExec(repoRoot, ['diff', '--cached', '--quiet']);
  const indexStale = cached.exitCode !== 0;

  const head = gitExec(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Treat a failed rev-parse as detached (unknown HEAD state) so preflight
  // refuses to merge into an indeterminate target.
  const detachedHead = head.exitCode !== 0 || head.stdout.trim() === 'HEAD';

  const clean =
    uncommittedFiles.length === 0 && !indexStale && !detachedHead;

  return { clean, uncommittedFiles, indexStale, detachedHead };
}

// ─── mergePreflight ─────────────────────────────────────────────────────────

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
  /**
   * Optional debug payload populated only when `EXARCHOS_PREFLIGHT_DEBUG=1`
   * is set AND ancestry fails. Phase-1 Windows ancestry-mismatch
   * instrumentation (#1362). Failure-only gating is deliberate (DIM-8 /
   * event-store growth — verbose sub-modes will land separately via
   * `EXARCHOS_PREFLIGHT_DEBUG=2` if/when phase 2 needs them).
   */
  readonly debug?: PreflightDebug;
}

/**
 * Structured diagnostic payload for the Phase-1 Windows ancestry-mismatch
 * investigation (#1362). All fields are best-effort: individual git call
 * failures degrade gracefully to empty strings / default values rather than
 * throwing. Reasoning: a debug helper that throws inside an already-failed
 * preflight would mask the underlying ancestry failure the operator is
 * trying to diagnose.
 *
 * Field order is the canonical reading order for an operator inspecting an
 * issue report — git version → repo root → worktree layout → ref state →
 * the actual ancestry invocation that failed.
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
  /** Stderr captured from the `merge-base --is-ancestor` invocation. The
   * default `GitExec` shape collapses stderr into `stdout` on failure — this
   * field is currently a duplicate of `mergeBaseStdout` for Windows-specific
   * gitExec implementations that may split the streams. */
  readonly mergeBaseStderr: string;
}

// ─── gatherPreflightDebug (#1362 phase 1) ───────────────────────────────────

/**
 * Collect the Phase-1 Windows ancestry-debug payload.
 *
 * Every git invocation goes through the injected `gitExec` so the helper
 * stays pure and unit-testable. Each call is wrapped in fail-closed
 * semantics — a non-zero exit (or thrown error from a misbehaving gitExec)
 * collapses to an empty string / default value for that field, never
 * throws. The on-failure debug attachment is best-effort by design.
 *
 * The `for-each-ref` ref inspection is structured as
 * `{ sha, packed }` because a Windows-host investigation needs to
 * distinguish "ref does not exist" from "ref exists but is packed and
 * unreadable by some downstream tool." Phase-1 reports `packed: false`
 * universally; phase-2 may upgrade the helper to use `git pack-refs
 * --print` for genuine packed-ref discrimination.
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
    // Phase-1: `cat-file -e <sha>` confirms the SHA is reachable; we treat a
    // success as `packed: false` (the typical loose-ref case). Phase-2 will
    // distinguish loose vs packed via `pack-refs --print`. If the ref lookup
    // failed outright, leave `packed: false` and let `sha === ''` signal it.
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
  // `mergeBaseStderr` reflects only what the adapter actually captured.
  // Adapters that merge descriptors (so stderr lands in stdout) leave the
  // field empty here; the canonical `defaultGitExec` in merge-orchestrate.ts
  // captures stderr separately on failure so phase-2 diagnostics can
  // distinguish merge-base's error output from any partial stdout.
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
 * Adapt the rich merge-preflight `GitExec` shape into the bare-string
 * `GitExec` consumed by dispatch-guard helpers. The dispatch-guard
 * convention is "throw on failure with `.status` set to the git exit
 * code"; we reproduce that here so `validateBranchAncestry` can
 * distinguish ancestry-missing (exit 1) from genuine git errors.
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
 * Build the operator-facing remediation hint for an ancestry-failed merge
 * preflight (T-15 / DR-6, #1212). The hint must be self-contained so the
 * operator can recover without consulting external docs:
 *
 *   1. The exact `git rebase` command, with both branch names interpolated
 *      so it is copy-pasteable.
 *   2. A link to the runbook section in the delegate skill that
 *      documents the manual rebase + rollback procedure. The anchor
 *      `#when-integration-advances-mid-wave` is the slugified heading
 *      added in `content/delivery/skills/delegate/SKILL.md` under task T-15.
 *
 * No auto-rebase is invoked here; per the plan, automation is deferred
 * to issue #1119.
 */
function formatAncestryRemediation(
  sourceBranch: string,
  targetBranch: string,
): string {
  // CodeRabbit #1213/#6: omit the source-branch arg from the rebase hint.
  // `git rebase <target> <source>` checks `<source>` out, which fails when
  // the same branch is checked out in another worktree (the common case
  // here — operator runs from the feature worktree). The two-arg form
  // also forces a hard branch checkout instead of using the operator's
  // current HEAD, which is rarely what they want. Run from the feature
  // worktree with `git rebase <target>`.
  return (
    `source branch ${sourceBranch} is not a descendant of ${targetBranch}. ` +
    `Rebase manually with: git rebase ${targetBranch} (run from the ${sourceBranch} worktree). ` +
    `Runbook: content/delivery/skills/delegate/SKILL.md#when-integration-advances-mid-wave`
  );
}

/**
 * Compose all four preflight guards into a single result. DR-MO-1
 * (topology preflight) requires that ancestry, current-branch
 * protection, main-worktree assertion, and working-tree drift all
 * pass before a merge is attempted.
 *
 * T06 covers only the happy path; T07 exercises each failure
 * branch independently. T-15 (#1212, DR-6) added the ancestry-failure
 * remediation hint so operators can recover without consulting
 * external docs.
 */
export async function mergePreflight(
  args: MergePreflightArgs,
): Promise<MergePreflightResult> {
  const repoRoot = args.cwd ?? process.cwd();
  const adapter = adaptToDispatchGuardExec(args.gitExec, repoRoot);

  // Merge-preflight intent: source must be up-to-date with target (i.e.,
  // target IS an ancestor of source). `validateBranchAncestry(integration,
  // [upstream...])` checks each upstream is an ancestor of integration, so
  // the merge preflight passes `sourceBranch` as the integration arg and
  // `[targetBranch]` as the required upstream. The synthesis-flow caller
  // uses the opposite direction (target=main, upstream=feature-branches)
  // because there the assertion is "all features have landed in main."
  const ancestryRaw = await validateBranchAncestry(
    args.sourceBranch,
    [args.targetBranch],
    adapter,
  );

  // T-15: when ancestry fails because the source has diverged from the
  // target (`reason: 'ancestry'`), enrich the result with a remediation
  // hint that names the manual rebase command and links to the runbook.
  // We do this here rather than inside `validateBranchAncestry` because
  // only the merge-preflight caller knows the appropriate runbook target —
  // other callers (synthesis-flow) need different remediation copy.
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

  // Phase-1 Windows ancestry-debug instrumentation (#1362). Failure-only
  // gating: only attach a debug block when the env var is explicitly set
  // AND ancestry failed. DIM-8 sustainability — we do NOT pay event-store
  // growth for passing preflights even when an operator turns the flag on.
  // Verbose sub-modes (passing-preflight diagnostics) belong on a
  // separate `EXARCHOS_PREFLIGHT_DEBUG=2` channel and are out of scope.
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
