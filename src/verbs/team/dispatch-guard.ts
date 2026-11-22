/**
 * Guards that run before delegation: branch ancestry, the current branch, and
 * the main worktree.
 *
 * The guards take their dependencies as arguments and have no side effects.
 * The delegation handler reads Git through the constrained forms, and the merge preflight keeps the forms over its injected Git call.
 * Only `probeStashAndEmit` appends an event. This module does not emit
 * `dispatch.preflight`. The delegation handler runs each guard and emits that
 * summary itself.
 */

import type { EventStore } from '../../events/store.js';
import {
  decideRelation, exitedWithOne, locateObservational, resolveObservedBase, type Observation,
} from '../../utils/git-observer.js';
import { observationalReader } from '../../utils/git-tree.js';

export interface AncestryResult {
  readonly passed: boolean;
  readonly blocked?: boolean;
  readonly checks?: string[];
  readonly reason?: 'ancestry' | 'git-error';
  readonly missing?: string[];
  readonly error?: string;
  /**
   * A remediation hint for the operator. A caller with enough context sets it.
   * For example, `mergePreflight` names the branch pair and the runbook.
   * `validateBranchAncestry` does not set it.
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
  /** A remediation hint for the operator. It is present only when `blocked` is true. */
  readonly hint?: string;
}

export type GitExec = (args: readonly string[]) => string;

/** Branches that dispatch must never run from. The guard refuses when HEAD is on one of them. */
const PROTECTED_CURRENT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/**
 * Checks that each required upstream branch is an ancestor of the integration
 * branch, with `git merge-base --is-ancestor`.
 *
 * Exit code 1 marks the upstream as missing. Any other git failure returns a
 * `git-error` result. The function never throws.
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
      const e = err as Error & { status?: number };
      if (e.status === 1) {
        missing.push(upstream);
      } else {
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

/**
 * Returns the current branch from `git rev-parse --abbrev-ref HEAD`.
 *
 * A git failure returns `null`, and callers do not treat it as a block. A
 * detached HEAD prints the literal `HEAD`, so the function also returns `null`
 * for it. Then no guard reads it as a branch with the name `HEAD`.
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
 * Blocks dispatch when HEAD is on `main` or `master`.
 *
 * The ancestry check cannot do this, because it passes when the integration
 * branch is `main`. A `null` branch is unknown and does not block.
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

/**
 * Reports whether the working directory is the main worktree, not a subagent
 * worktree under `.claude/worktrees/`. A subagent worktree must not dispatch
 * more subagents.
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

/**
 * Locate the checkout of the dispatch guards with the observational located form. With no `repoRoot`, the climb starts at the server directory.
 * A non-empty `gitPath` is the connector Git path, else the reads use the process-wide Git path. The guards of one call share the one reader.
 */
export function observeDispatchCheckout(repoRoot: string | undefined, gitPath: string | undefined): Promise<Observation> {
  return locateObservational(repoRoot ?? process.cwd(), observationalReader(gitPath));
}

/** The current branch of a dispatch checkout: the short name, null for a detached HEAD, or the cause of an unreadable read. */
type ObservedBranchRead =
  | { readonly kind: 'branch'; readonly branch: string | null }
  | { readonly kind: 'unreadable'; readonly error: string };

/** The cause of a dispatch observation that located no readable checkout. */
function unlocatedCause(observation: Exclude<Observation, { readonly kind: 'located' }>): string {
  return observation.kind === 'absent' ? 'No Git checkout holds the dispatch directory' : observation.reason;
}

/**
 * Read the current branch through the constrained reader. A detached HEAD gives null, which does not block.
 * A missing checkout, a refused check and a failed read are unreadable, and the caller blocks with the git-error reason.
 */
export async function readObservedBranch(observation: Observation): Promise<ObservedBranchRead> {
  if (observation.kind !== 'located') return { kind: 'unreadable', error: unlocatedCause(observation) };
  const { located } = observation;
  try {
    const ref = (await located.reads.branch(located.gitDir, located.checkout)).trim();
    return { kind: 'branch', branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref };
  } catch (error) {
    if (exitedWithOne(error)) return { kind: 'branch', branch: null };
    return { kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Checks that each required upstream name is an ancestor of the integration name, through the constrained reader.
 * Each name resolves in the base-name order. A decided negative answer marks the upstream as missing.
 * An unresolvable name, an unreadable checkout and an answer that a shallow boundary leaves undecided give the git-error block. The function never throws.
 */
export async function validateObservedAncestry(
  observation: Observation,
  integrationBranch: string,
  requiredUpstream: readonly string[],
): Promise<AncestryResult> {
  if (requiredUpstream.length === 0) return { passed: true, checks: ['ancestry'] };
  const gitError = (error: unknown): AncestryResult => ({
    passed: false, blocked: true, reason: 'git-error', error: error instanceof Error ? error.message : String(error),
  });
  if (observation.kind !== 'located') return gitError(unlocatedCause(observation));
  const { located } = observation;
  const missing: string[] = [];
  try {
    const integration = await resolveObservedBase(located, integrationBranch);
    for (const upstream of requiredUpstream) {
      const relation = await decideRelation(located, 'ancestry', await resolveObservedBase(located, upstream), integration);
      if (relation.kind === 'unreadable') return gitError(relation.reason);
      if (relation.kind === 'unrelated') missing.push(upstream);
    }
  } catch (error) {
    return gitError(error);
  }
  return missing.length > 0 ? { passed: false, blocked: true, reason: 'ancestry', missing } : { passed: true, checks: ['ancestry'] };
}

export interface ProbeStashAndEmitArgs {
  readonly store: EventStore;
  readonly streamId: string;
  readonly worktreePath: string;
  readonly observation: Observation;
}

/**
 * Reads the stash listing through the constrained reader. When the list is not
 * empty, appends one advisory `stash.detected` event with the newest stash ref.
 *
 * All worktrees of a repository share one stash, so an entry can bring the
 * work of a sibling agent into this worktree. The event does not block
 * dispatch. An unreadable read appends no event and does not fail dispatch. The
 * ref is the first line of output up to its first `:`.
 */
export async function probeStashAndEmit(
  args: ProbeStashAndEmitArgs,
): Promise<void> {
  if (args.observation.kind !== 'located') return;
  const { located } = args.observation;
  let listing: string;
  try {
    listing = await located.reads.stashList(located.gitDir, located.checkout);
  } catch {
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
