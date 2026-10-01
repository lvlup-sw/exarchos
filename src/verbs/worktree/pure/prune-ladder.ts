/**
 * Pure safety ladder that classifies one candidate of the worktree GC (`prune_worktrees`). The GC
 * must never destroy unsaved work, so the ladder fails closed and deletes nothing it cannot prove
 * safe. The handler supplies every fact, and this module makes no git, file system or OS call.
 * Eligibility depends on the projection state only, never on mtime. A long-running agent has a
 * stale mtime but still uses its worktree.
 */

/**
 * Lifecycle state of a worktree as reduced by the `worktrees@v1` projection.
 * Only `released` and `orphan` are deletion-eligible.
 */
export type WorktreeState = 'adopted' | 'reserved' | 'released' | 'orphan';

/** One prune candidate and the facts that the handler supplies for it. */
export interface PruneCandidate {
  /**
   * The `worktrees@v1` projection state, or `undefined` when no adoption record exists. The ladder
   * treats an absent record as unverifiable, behind the adopt gate of the handler.
   */
  state?: WorktreeState;
  /**
   * True when the worktree is reserved by a live owner: the PID exists and its recorded create
   * time matches. The ladder never deletes such a worktree.
   */
  inUse: boolean;
  /**
   * True when `git status --porcelain --untracked-files=all` shows changes. Untracked files count,
   * so they protect the worktree too.
   */
  dirty: boolean;
  /**
   * The ref for the merge check of HEAD, from `synthesis.integrationBranch`. It is `null` when the
   * candidate has no `featureId` or the branch does not resolve. The ladder then skips it.
   */
  integrationRef: string | null;
  /**
   * Result of `git merge-base --is-ancestor HEAD <integrationRef>`. It is `null` when the probe
   * cannot run, for example for an orphan with no backing repo.
   */
  headAncestorOfIntegration: boolean | null;
  /**
   * True when the `.git` gitdir pointer resolves. When it is false, the backing repo is gone and
   * the worktree is an orphan with unverifiable content.
   */
  backingGitdirPresent: boolean;
  /** True when `origin` is reachable. When it is false, the ladder does not trust the ancestry. */
  originReachable: boolean;
}

/**
 * Why a candidate was skipped. The dry-run report groups skips by this reason.
 * {@link classifyPruneCandidate} never returns `in-flight-merge`. The manager sets it when the
 * worktree or its integration branch holds an unpaired merge lease.
 */
export type PruneSkipReason =
  | 'no-adoption-record'
  | 'in-use'
  | 'active'
  | 'dirty'
  | 'unverifiable-integration-ref'
  | 'unmerged'
  | 'cannot-verify-merge'
  | 'origin-unreachable'
  | 'in-flight-merge';

/**
 * Classification of one prune candidate. The handler deletes an `orphan-unverifiable` candidate
 * only with the explicit `pruneOrphans` and `yes` opt-in.
 */
export type PruneClassification =
  | { readonly action: 'skip'; readonly reason: PruneSkipReason }
  | { readonly action: 'orphan-unverifiable' }
  | { readonly action: 'delete-eligible' };

const skip = (reason: PruneSkipReason): PruneClassification => ({ action: 'skip', reason });

/**
 * Checks the rungs in order and returns the first match, so the result leans toward no delete.
 * A null ancestry does not count as unmerged. It reaches the orphan rung, or `cannot-verify-merge`
 * when the backing repo is present. Only a clean, merged `released` or `orphan` worktree with its
 * backing repo and a reachable `origin` is `delete-eligible`.
 */
export function classifyPruneCandidate(candidate: PruneCandidate): PruneClassification {
  if (candidate.state === undefined) {
    return skip('no-adoption-record');
  }

  if (candidate.inUse) {
    return skip('in-use');
  }

  if (candidate.state === 'adopted' || candidate.state === 'reserved') {
    return skip('active');
  }

  if (candidate.dirty) {
    return skip('dirty');
  }

  if (candidate.integrationRef === null) {
    return skip('unverifiable-integration-ref');
  }

  if (candidate.headAncestorOfIntegration === false) {
    return skip('unmerged');
  }

  if (!candidate.backingGitdirPresent) {
    return { action: 'orphan-unverifiable' };
  }

  if (candidate.headAncestorOfIntegration === null) {
    return skip('cannot-verify-merge');
  }

  if (!candidate.originReachable) {
    return skip('origin-unreachable');
  }

  return { action: 'delete-eligible' };
}
