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
