// ─── Dispatch Guard ──────────────────────────────────────────────────────────
//
// Pre-delegation guards: branch ancestry validation and worktree assertions.
// Pure functions with injected dependencies — no side-effects.
// ────────────────────────────────────────────────────────────────────────────

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AncestryResult {
  readonly passed: boolean;
  readonly blocked?: boolean;
  readonly checks?: string[];
  readonly reason?: 'ancestry' | 'git-error';
  readonly missing?: string[];
  readonly error?: string;
}

export interface WorktreeAssertionResult {
  readonly isMain: boolean;
  readonly actual: string;
  readonly expected: string;
}

export interface CurrentBranchProtectionResult {
  readonly blocked: boolean;
  readonly reason?: 'current-branch-protected';
  readonly currentBranch?: string;
}

export type GitExec = (args: readonly string[]) => string;

/**
 * Branches that dispatch must never run *from*. The guard refuses
 * `prepare_delegation` when HEAD points at any of these — you must
 * check out a feature branch first.
 */
const PROTECTED_CURRENT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

// ─── Branch Ancestry Validation ─────────────────────────────────────────────

/**
 * Validates that all required upstream branches are ancestors of the
 * integration branch.
 *
 * Uses `git merge-base --is-ancestor <upstream> <integration>`:
 *   - exit 0 → upstream IS an ancestor (passed)
 *   - non-zero → upstream is NOT an ancestor (missing)
 *
 * DR-10: Never throws — returns structured error on git failures.
 */
export async function validateBranchAncestry(
  integrationBranch: string,
  requiredUpstream: string[],
  gitExec: (args: readonly string[]) => string,
): Promise<AncestryResult> {
  if (requiredUpstream.length === 0) {
    return { passed: true, checks: ['ancestry'] };
  }

  const missing: string[] = [];

  for (const upstream of requiredUpstream) {
    try {
      gitExec(['merge-base', '--is-ancestor', upstream, integrationBranch]);
    } catch (err) {
      // Distinguish ancestry-missing (exit code 1) from git errors
      const e = err as Error & { status?: number };
      if (e.status === 1) {
        missing.push(upstream);
      } else {
        // DR-10: git command failure — return structured error, never throw
        return {
          passed: false,
          blocked: true,
          reason: 'git-error',
          error: e.message,
        };
      }
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      blocked: true,
      reason: 'ancestry',
      missing,
    };
  }

  return { passed: true, checks: ['ancestry'] };
}

// ─── Current Branch ─────────────────────────────────────────────────────────

/**
 * Resolve the current checked-out branch via `git rev-parse --abbrev-ref
 * HEAD`. Returns `null` on any git failure — callers treat absence as a
 * non-signal, not as a block.
 *
 * On detached HEAD, `git rev-parse --abbrev-ref HEAD` returns the literal
 * string "HEAD". Collapse that to `null` so downstream guards (protected-
 * branch refusal, prepare-delegation fallback) treat it as "no current
 * branch" rather than a branch literally named "HEAD".
 */
export function getCurrentBranch(gitExec: GitExec): string | null {
  try {
    const branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch === '' || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Refuse dispatch when HEAD is on a protected base branch (main / master).
 * Distinct from the ancestry check: ancestry tests "does integrationBranch
 * descend from main?" which trivially passes when integrationBranch IS
 * main. The stated "never dispatch from main" rule needs to inspect
 * current HEAD, not workflow-state metadata.
 *
 * Accepts `null` (current branch unknown) and returns "not blocked" — the
 * absence of a signal is not grounds to escalate to a refusal.
 */
export function assertCurrentBranchNotProtected(
  currentBranch: string | null,
): CurrentBranchProtectionResult {
  if (currentBranch !== null && PROTECTED_CURRENT_BRANCHES.has(currentBranch)) {
    return {
      blocked: true,
      reason: 'current-branch-protected',
      currentBranch,
    };
  }
  return { blocked: false };
}

// ─── Worktree Assertion ─────────────────────────────────────────────────────

/**
 * Asserts whether the current working directory is the main worktree
 * (not a subagent worktree under `.claude/worktrees/`).
 *
 * DR-2: Subagent worktrees must not dispatch further subagents.
 */
export function assertMainWorktree(cwd?: string): WorktreeAssertionResult {
  const actual = cwd ?? process.cwd();
  const isSubagent = actual.includes('.claude/worktrees/');

  return {
    isMain: !isSubagent,
    actual,
    expected: 'main worktree (no .claude/worktrees/ in path)',
  };
}
