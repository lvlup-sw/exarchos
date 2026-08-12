// ─── Dispatch Guard ──────────────────────────────────────────────────────────
//
// Pre-delegation guards: branch ancestry validation and worktree assertions.
// Pure functions with injected dependencies — no side-effects (the guard
// primitives themselves remain side-effect-free; the orchestration helpers
// `runPreflightGuards` and `probeStashAndEmit` (#1261) emit a single event
// each and have their EventStore + DispatchContext threaded via arguments).
// ────────────────────────────────────────────────────────────────────────────

import type { EventStore } from '../events/store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AncestryResult {
  readonly passed: boolean;
  readonly blocked?: boolean;
  readonly checks?: string[];
  readonly reason?: 'ancestry' | 'git-error';
  readonly missing?: string[];
  readonly error?: string;
  /**
   * Operator-facing remediation hint (#1212 / DR-6). Populated by callers
   * that have enough context to spell out the recovery command (e.g.,
   * `mergePreflight` knows the source/target branch pair and links to the
   * merge-orchestrator runbook). `validateBranchAncestry` itself does not
   * set this — it has no remediation context for the various callers.
   */
  readonly hint?: string;
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
  /**
   * Operator-facing remediation hint (#1190). Present when `blocked: true`
   * so callers don't need to consult external docs to recover. Omitted
   * when `blocked: false` (no remediation needed).
   */
  readonly hint?: string;
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
      hint: `checkout the feature/phase branch before dispatching delegation (HEAD is on ${currentBranch})`,
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

// ─── Preflight Outcome Emission (#1261) ──────────────────────────────────────

/**
 * Aggregate outcome of `runPreflightGuards`. Mirrors the per-guard shape
 * stamped into the emitted `dispatch.preflight` event so callers can
 * branch on the same data without re-querying the event store.
 */
export interface PreflightOutcome {
  readonly guards: {
    readonly ancestry: { readonly passed: boolean };
    readonly worktree: { readonly passed: boolean };
    readonly protectedBranch: { readonly passed: boolean };
    readonly mainWorktree: { readonly passed: boolean };
  };
  readonly passed: boolean;
  readonly durationMs: number;
}

export interface RunPreflightGuardsArgs {
  readonly store: EventStore;
  readonly streamId: string;
  readonly integrationBranch: string;
  readonly requiredUpstream: readonly string[];
  readonly gitExec: GitExec;
  /** Worktree path used for `assertMainWorktree`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/**
 * Runs the four dispatch preflight guards and emits a single
 * `dispatch.preflight` event capturing the per-guard pass/fail outcome,
 * the aggregate `passed` flag, and the total runtime in ms.
 *
 * The `mainWorktree` slot is currently an alias for `worktree.passed` —
 * both surface the "we are not in a subagent worktree" assertion. The
 * split exists in the event schema so that a future cross-cutting "we
 * are in the canonical main worktree of the configured repo" check can
 * be added without bumping the schema version.
 *
 * `operationId` is inherited from the active `DispatchContext` (B1 /
 * #1291) by the `stampWithDispatchContext` helper inside
 * `EventStore.append`. No manual correlation threading is required here.
 *
 * Emission failures are logged-and-swallowed via the caller-provided
 * `EventStore.append` (which itself raises on schema-validation errors —
 * those *should* surface, so we deliberately do not catch here).
 */
export async function runPreflightGuards(
  args: RunPreflightGuardsArgs,
): Promise<PreflightOutcome> {
  const start = Date.now();

  const ancestry = await validateBranchAncestry(
    args.integrationBranch,
    [...args.requiredUpstream],
    args.gitExec,
  );

  const worktreeAssertion = assertMainWorktree(args.cwd);
  const worktreePassed = worktreeAssertion.isMain;

  const currentBranch = getCurrentBranch(args.gitExec);
  const protectionResult = assertCurrentBranchNotProtected(currentBranch);
  const protectedBranchPassed = !protectionResult.blocked;

  // `mainWorktree` is reserved for a future cross-cutting "canonical main
  // worktree" assertion; today it shadows `worktree.passed` so the schema
  // shape is stable from day one.
  const mainWorktreePassed = worktreePassed;

  const passed =
    ancestry.passed && worktreePassed && protectedBranchPassed && mainWorktreePassed;

  const durationMs = Date.now() - start;

  await args.store.append(args.streamId, {
    type: 'dispatch.preflight',
    data: {
      guards: {
        ancestry: { passed: ancestry.passed },
        worktree: { passed: worktreePassed },
        protectedBranch: { passed: protectedBranchPassed },
        mainWorktree: { passed: mainWorktreePassed },
      },
      passed,
      durationMs,
    },
  });

  return {
    guards: {
      ancestry: { passed: ancestry.passed },
      worktree: { passed: worktreePassed },
      protectedBranch: { passed: protectedBranchPassed },
      mainWorktree: { passed: mainWorktreePassed },
    },
    passed,
    durationMs,
  };
}

export interface ProbeStashAndEmitArgs {
  readonly store: EventStore;
  readonly streamId: string;
  readonly worktreePath: string;
  readonly gitExec: GitExec;
}

/**
 * Probes `git stash list --no-color` from the worktree under dispatch.
 * If the list is non-empty, emits a single `stash.detected` advisory
 * event carrying the worktree path and the most-recent stash ref.
 *
 * Stash storage is shared across worktrees in the same repository
 * (`feedback_subagent_stash_hazard`), so any pre-existing entry raises
 * the risk that a sibling agent's WIP will be popped into the current
 * worktree. The event is advisory only — dispatch is not blocked. Git
 * failures are swallowed (no event emitted) so the probe never escalates
 * a transient `git` outage into a dispatch failure.
 *
 * The most-recent stash ref is parsed as the prefix of the first
 * non-empty output line up to the first `:`. Output convention:
 *   `stash@{0}: WIP on feature/x: 1234567 message`
 */
export async function probeStashAndEmit(
  args: ProbeStashAndEmitArgs,
): Promise<void> {
  let listing: string;
  try {
    listing = args.gitExec(['stash', 'list', '--no-color']);
  } catch {
    // Probe is advisory — never escalate a `git stash list` failure into
    // a dispatch error. The absence of the event is the signal here.
    return;
  }

  const firstLine = listing.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return;

  const colonIdx = firstLine.indexOf(':');
  const stashRef = colonIdx > 0 ? firstLine.slice(0, colonIdx).trim() : firstLine.trim();
  if (!stashRef) return;

  await args.store.append(args.streamId, {
    type: 'stash.detected',
    data: {
      worktreePath: args.worktreePath,
      stashRef,
    },
  });
}
