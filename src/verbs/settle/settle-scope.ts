/**
 * The scope rules of `settle`. They judge the claimed worktree of one completed claim against the scope that the capsule pins.
 *
 * Nine rules run in order, and the first rule that fails gives the cause of the finding.
 * The rules read the observation that settle made with git before any gate, and the terms of the task.
 * They also read the other claims of the batch and the completed trees of the stream.
 * They spawn nothing and read no file, so the commit applies them again to the rows of its transaction.
 *
 * `completionTreeOf` gives the tree of one completion row in lexical form, so the fold and the rules compare one form.
 */

import * as path from 'node:path';

import type { CapsuleScope } from '../../contract/capsule/exarchos-capsule.js';
import { normalizedPath, type ClaimedTreeObservation } from '../../utils/git-tree.js';
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

/** The pinned terms that the rules judge one claimed worktree against: the scope of the capsule, and the base of the task. */
export interface ScopeTerms {
  readonly scope: CapsuleScope;
  readonly baseRef: string;
  readonly baseCommit: string;
}

/** The cause of an out-of-scope claimed worktree. Each cause names one rule, in the order of the rules. */
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

/** The first rule that a claimed worktree fails: its cause, and what the observation shows. */
interface ScopeBreach {
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
 * The task of another claim of the batch that names the same path, or else the task of another completion row that names it.
 * The claim and the completion row of the task itself do not count.
 */
function sharerOf(
  taskId: string,
  claimed: string,
  claims: ReadonlyMap<string, ClaimedTree>,
  completedTrees: ReadonlyMap<string, string>,
): { readonly taskId: string; readonly by: 'claim' | 'completion' } | undefined {
  for (const [other, tree] of claims) {
    if (other !== taskId && tree.path === claimed) return { taskId: other, by: 'claim' };
  }
  for (const [other, tree] of completedTrees) {
    if (other !== taskId && tree === claimed) return { taskId: other, by: 'completion' };
  }
  return undefined;
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
  const { scope, baseRef, baseCommit } = terms;
  if (observed.kind === 'unobservable') {
    return { cause: 'unobservable', detail: `git did not answer: ${observed.cause}` };
  }
  if (observed.kind === 'no-work-tree') {
    return { cause: 'not-a-worktree-root', detail: 'the path is outside any git work tree' };
  }
  if (observed.toplevel !== claimed.path) {
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
  if (observed.branch === baseRef) {
    return { cause: 'on-the-base-branch', detail: `it is on the base branch ${quoted(baseRef)}` };
  }
  if (claimed.branch !== undefined && observed.branch !== claimed.branch) {
    const on = observed.branch === undefined ? 'a detached HEAD' : `the branch ${quoted(observed.branch)}`;
    return { cause: 'other-branch', detail: `the claim names the branch ${quoted(claimed.branch)}, and the worktree is on ${on}` };
  }
  if (!observed.holdsBase) {
    return { cause: 'base-not-held', detail: `its HEAD does not hold the base commit ${baseCommit} of ${quoted(baseRef)}` };
  }
  if (observed.dirtyPaths.length > 0) {
    return { cause: 'uncommitted-changes', detail: `git status lists ${observed.dirtyPaths.map(quoted).join(', ')}` };
  }
  const sharer = sharerOf(taskId, claimed.path, claims, completedTrees);
  if (sharer !== undefined) {
    const names = sharer.by === 'claim' ? 'the claim of task' : 'the completion of task';
    return { cause: 'shared-worktree', detail: `${names} ${quoted(sharer.taskId)} names it too` };
  }
  return undefined;
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
