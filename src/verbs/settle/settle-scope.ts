/**
 * The scope rules of `settle`. They judge the claimed worktree of one completed claim against the scope that the capsule pins.
 *
 * Nine rules run in order, and the first rule that fails gives the cause of the finding.
 * The rules read the observation that settle made with git before any gate, and the terms of the task.
 * They also read the other claims of the batch and the completed trees of the stream.
 * They spawn nothing and read no file, so the commit applies them again to the rows of its transaction.
 *
 * `task_complete` judges a named tree with rules 1 to 7 and the completion-row half of rule 9, so the module exports them.
 * `completionTreeOf` gives the tree of one completion row in lexical form, so the fold and the rules compare one form.
 */

import * as path from 'node:path';

import type { CapsuleScope } from '../../contract/capsule/exarchos-capsule.js';
import { normalizedPath, type ClaimedTreeObservation, type TreeObservation } from '../../utils/git-tree.js';
import type { ClaimScope } from './adjudicate.js';

/** The claimed worktree of one completed claim, as settle observed it before any gate. */
export interface ClaimedTree {
  /** The canonical form of the claimed `worktreePath`. */
  readonly path: string;
  /** The branch that the claim names. It is absent when the claim names no branch. */
  readonly branch?: string;
  /** What git observed at the claimed path. */
  readonly observed: ClaimedTreeObservation;
}

/**
 * The pinned terms of rules 2 to 7: the scope of the capsule, and the base of the task.
 * A task with no terms in the capsule has no `baseRef`, so rule 5 does not run. A task with no base commit has no `baseCommit`.
 */
export interface WorktreeTerms {
  readonly scope: CapsuleScope;
  readonly baseRef?: string;
  readonly baseCommit?: string;
}

/** The pinned terms that settle judges one claimed worktree against: the scope of the capsule, and the base of its task. */
export interface ScopeTerms extends WorktreeTerms {
  readonly baseRef: string;
  readonly baseCommit: string;
}

/** The cause of an out-of-scope worktree. Each cause names one rule, in the order of the rules. */
type ScopeCause =
  | 'unobservable'
  | 'not-a-worktree-root'
  | 'other-repository'
  | 'the-checkout'
  | 'on-the-base-branch'
  | 'other-branch'
  | 'base-not-held'
  | 'uncommitted-changes'
  | 'shared-worktree';

/** The first rule that a worktree fails: its cause, and what the observation shows. */
export interface ScopeBreach {
  readonly cause: ScopeCause;
  readonly detail: string;
}

/**
 * The tree that one `task.completed` row names, in lexical form. The function reads the raw `worktreePath` of the row,
 * because a parse of the row schema drops the field. A row with no path, or with an empty path, names no tree.
 */
export function completionTreeOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const worktreePath: unknown = Reflect.get(data, 'worktreePath');
  return typeof worktreePath === 'string' && worktreePath.length > 0 ? normalizedPath(worktreePath) : undefined;
}

/**
 * The primary worktree of a repository: the parent of its common dir when that dir is named `.git`.
 * A common dir with another name gives no primary worktree. The function spawns no git.
 */
function primaryWorktreeOf(repository: string): string | undefined {
  return path.posix.basename(repository) === '.git' ? path.posix.dirname(repository) : undefined;
}

/** A path or a ref in quotes, as a message names it. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/**
 * Rule 1 and the first half of rule 2, for an observation that is not a git work tree.
 * A git call that did not answer gives `unobservable`. A path outside any git work tree gives `not-a-worktree-root`.
 */
export function unobservedBreach(observed: Exclude<TreeObservation, { readonly kind: 'tree' }>): ScopeBreach {
  return observed.kind === 'unobservable'
    ? { cause: 'unobservable', detail: `git did not answer: ${observed.cause}` }
    : { cause: 'not-a-worktree-root', detail: 'the path is outside any git work tree' };
}

/**
 * Rules 2 to 6 for a git work tree at the canonical path `claimed`, or undefined when the tree passes each of them.
 * `branch` is the branch that the claim or the result names. Rule 6 runs only when it is present.
 * Rule 5 runs only when the terms hold a `baseRef`.
 */
export function worktreeBreach(
  claimed: string,
  branch: string | undefined,
  observed: Extract<TreeObservation, { readonly kind: 'tree' }>,
  terms: WorktreeTerms,
): ScopeBreach | undefined {
  const { scope, baseRef } = terms;
  if (observed.toplevel !== claimed) {
    return { cause: 'not-a-worktree-root', detail: `the path is inside the work tree ${quoted(observed.toplevel)}, not at its root` };
  }
  if (observed.repository !== scope.repository) {
    return {
      cause: 'other-repository',
      detail: `its repository is ${quoted(observed.repository)}, and the capsule pins ${quoted(scope.repository)}`,
    };
  }
  if (observed.toplevel === scope.checkout) {
    return { cause: 'the-checkout', detail: 'it is the checkout that prepare read' };
  }
  if (observed.toplevel === primaryWorktreeOf(scope.repository)) {
    return { cause: 'the-checkout', detail: 'it is the primary worktree of the repository' };
  }
  if (baseRef !== undefined && observed.branch === baseRef) {
    return { cause: 'on-the-base-branch', detail: `it is on the base branch ${quoted(baseRef)}` };
  }
  if (branch !== undefined && observed.branch !== branch) {
    const on = observed.branch === undefined ? 'a detached HEAD' : `the branch ${quoted(observed.branch)}`;
    return { cause: 'other-branch', detail: `the claim names the branch ${quoted(branch)}, and the worktree is on ${on}` };
  }
  return undefined;
}

/** Rule 7: a HEAD that does not hold the base commit of the task. The message names `baseRef` when it is present. */
export function baseBreach(holdsBase: boolean, baseCommit: string, baseRef: string | undefined): ScopeBreach | undefined {
  if (holdsBase) return undefined;
  const of = baseRef === undefined ? '' : ` of ${quoted(baseRef)}`;
  return { cause: 'base-not-held', detail: `its HEAD does not hold the base commit ${baseCommit}${of}` };
}

/**
 * The completion-row half of rule 9: the completion row of another task names the canonical path `claimed`.
 * `completedTrees` holds the tree of the completion row of each task. The row of the task itself does not count.
 */
export function completionSharerBreach(
  taskId: string,
  claimed: string,
  completedTrees: ReadonlyMap<string, string>,
): ScopeBreach | undefined {
  for (const [other, tree] of completedTrees) {
    if (other !== taskId && tree === claimed) {
      return { cause: 'shared-worktree', detail: `the completion of task ${quoted(other)} names it too` };
    }
  }
  return undefined;
}

/** The claim half of rule 9: another claim of the batch names the same path. The claim of the task itself does not count. */
function claimSharerBreach(
  taskId: string,
  claimed: string,
  claims: ReadonlyMap<string, ClaimedTree>,
): ScopeBreach | undefined {
  for (const [other, tree] of claims) {
    if (other !== taskId && tree.path === claimed) {
      return { cause: 'shared-worktree', detail: `the claim of task ${quoted(other)} names it too` };
    }
  }
  return undefined;
}

/** Rule 8: a claimed worktree whose status lists a path. */
function dirtyBreach(dirtyPaths: readonly string[]): ScopeBreach | undefined {
  return dirtyPaths.length > 0
    ? { cause: 'uncommitted-changes', detail: `git status lists ${dirtyPaths.map(quoted).join(', ')}` }
    : undefined;
}

/** The first of the nine rules that the claimed worktree of the task fails, or undefined when it fails none. */
function firstBreach(
  taskId: string,
  claimed: ClaimedTree,
  terms: ScopeTerms,
  claims: ReadonlyMap<string, ClaimedTree>,
  completedTrees: ReadonlyMap<string, string>,
): ScopeBreach | undefined {
  const { observed } = claimed;
  if (observed.kind !== 'tree') return unobservedBreach(observed);
  return (
    worktreeBreach(claimed.path, claimed.branch, observed, terms) ??
    baseBreach(observed.holdsBase, terms.baseCommit, terms.baseRef) ??
    dirtyBreach(observed.dirtyPaths) ??
    claimSharerBreach(taskId, claimed.path, claims) ??
    completionSharerBreach(taskId, claimed.path, completedTrees)
  );
}

/** The recovery that the message of one cause names. */
function recoveryOf(cause: ScopeCause, terms: ScopeTerms): string {
  switch (cause) {
    case 'uncommitted-changes':
      return (
        'Commit the listed files of the task in its worktree. Remove a listed file that a gate run left, ' +
        'and do not commit it. Then claim the task in a new batch.'
      );
    case 'unobservable':
      return 'Make the worktree readable to git, then claim the task in a new batch.';
    default:
      return (
        `Fork a worktree of its own from ${quoted(terms.baseRef)} at ${terms.baseCommit}, do the work of the ` +
        'task there, then claim the task in a new batch.'
      );
  }
}

/**
 * Judges the claimed worktree of one completed claim with the nine rules, in order. It is undefined when settle did not observe the claim.
 * `claims` holds the claimed worktree of each observed claim of the batch, by task, the claim of this task too.
 * `completedTrees` holds the tree of the completion row of each task that the stream shows complete.
 * The message names the claimed path, the cause, what the observation shows and the recovery.
 */
export function claimScopeOf(
  taskId: string,
  terms: ScopeTerms,
  claims: ReadonlyMap<string, ClaimedTree>,
  completedTrees: ReadonlyMap<string, string>,
): ClaimScope | undefined {
  const claimed = claims.get(taskId);
  if (claimed === undefined) return undefined;
  const breach = firstBreach(taskId, claimed, terms, claims, completedTrees);
  if (breach === undefined) return { kind: 'in-scope' };
  return {
    kind: 'out-of-scope',
    cause: breach.cause,
    message:
      `the claimed worktree ${quoted(claimed.path)} of task ${quoted(taskId)} is out of the scope of the capsule ` +
      `(${breach.cause}): ${breach.detail}. ${recoveryOf(breach.cause, terms)}`,
  };
}
