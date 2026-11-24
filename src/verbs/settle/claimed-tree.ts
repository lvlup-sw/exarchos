/**
 * The constrained observations of a claimed task tree for `task_complete` and the settle fallback.
 * Each one locates the checkout with no process, checks its storage, and reads through the closed constrained reader.
 * The reader has a pinned Git path, an isolated environment and closed argument vectors. It runs no status and no checkout filter.
 *
 * The head and the branch come from the constrained worktree listing. The closed listings give the paths that differ from the head.
 * A checkout that the storage policy refuses, or a read that fails, is unobservable.
 */
import { realpath } from 'node:fs/promises';

import {
  canonicalPath,
  observationalReader,
  type AncestryRead,
  type ClaimedTreeObservation,
  type ConstrainedGitReads,
  type TreeObservation,
} from '../../utils/git-tree.js';
import { decideRelation, listObservedWorktrees, locateObservational, type ObservationalCheckout } from '../../utils/git-observer.js';
import { closedListingChanges } from '../gates/gate-runner.js';

/** The most dirty paths that one observation of a claimed tree keeps. */
const DIRTY_PATH_LIMIT = 5;

/** The prefix of the full name of a branch. The branch of a tree observation has no such prefix. */
const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * How a claimed tree judges its base. `immutable` refuses a tree with no commit and an undecided ancestry as unobservable.
 * `mutable` reads both as a tree that does not hold the base, as the plain reads of older compilers did.
 */
export type ClaimedTreePolicy = 'immutable' | 'mutable';

/** A located checkout with its tree observation, or the observation that ends the read. */
type LocatedTree =
  | { readonly kind: 'located'; readonly located: ObservationalCheckout; readonly tree: Extract<TreeObservation, { readonly kind: 'tree' }> }
  | { readonly kind: 'ended'; readonly observation: Exclude<TreeObservation, { readonly kind: 'tree' }> };

/** The message of a caught failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Locate the checkout that holds `dir` and read its head and branch from the constrained worktree listing.
 * A directory that no checkout holds gives `no-work-tree` with its canonical path. A detached checkout gives no branch, and an unborn one gives no head.
 * A bare, prunable or unregistered checkout is unobservable.
 */
async function locateTree(dir: string, reader: () => Promise<ConstrainedGitReads>): Promise<LocatedTree> {
  const observation = await locateObservational(dir, reader);
  if (observation.kind === 'absent') return { kind: 'ended', observation: { kind: 'no-work-tree', path: canonicalPath(dir) } };
  if (observation.kind === 'unreadable') return { kind: 'ended', observation: { kind: 'unobservable', cause: observation.reason } };
  const { located } = observation;
  try {
    const matching = [];
    for (const record of await listObservedWorktrees(located)) {
      if (await realpath(record.path).catch(() => undefined) === located.checkout) matching.push(record);
    }
    const record = matching[0];
    if (matching.length !== 1 || record === undefined || record.bare || record.prunable) {
      return { kind: 'ended', observation: { kind: 'unobservable', cause: 'The checkout is not one registered checkout.' } };
    }
    const branch = record.branch === undefined ? undefined
      : record.branch.startsWith(BRANCH_REF_PREFIX) ? record.branch.slice(BRANCH_REF_PREFIX.length) : record.branch;
    return {
      kind: 'located',
      located,
      tree: {
        kind: 'tree',
        toplevel: canonicalPath(located.checkout),
        repository: canonicalPath(located.repository),
        ...(branch === undefined ? {} : { branch }),
        ...(record.head === undefined ? {} : { head: record.head }),
      },
    };
  } catch (error) {
    return { kind: 'ended', observation: { kind: 'unobservable', cause: messageOf(error) } };
  }
}

/** Observe the tree that holds `dir` through the constrained reader. */
export async function observeConstrainedTree(dir: string, reader = observationalReader()): Promise<TreeObservation> {
  const located = await locateTree(dir, reader);
  return located.kind === 'located' ? located.tree : located.observation;
}

/**
 * Ask the constrained reader whether `ancestor` is an ancestor of `descendant` in the checkout that holds `dir`.
 * Both must be full commit object IDs. A shallow boundary that leaves the answer undecided, and a failed read, give `unobservable`.
 */
export async function constrainedAncestry(dir: string, ancestor: string, descendant: string, reader = observationalReader()): Promise<AncestryRead> {
  const observation = await locateObservational(dir, reader);
  if (observation.kind === 'absent') return { kind: 'unobservable', cause: 'No checkout holds the directory.' };
  if (observation.kind === 'unreadable') return { kind: 'unobservable', cause: observation.reason };
  const relation = await decideRelation(observation.located, 'ancestry', ancestor, descendant);
  if (relation.kind === 'related') return { kind: 'ancestor' };
  if (relation.kind === 'unrelated') return { kind: 'not-ancestor' };
  return { kind: 'unobservable', cause: relation.reason };
}

/**
 * Observe a claimed tree through the constrained reader: the tree, whether its head holds `baseCommit`, and the first paths that differ from the head.
 * With `repository`, a tree of another repository gets neither the ancestry read nor the listings.
 * A tree with no commit is unobservable, because the closed listings compare the checkout with its head.
 */
export async function observeConstrainedClaimedTree(
  dir: string,
  baseCommit: string,
  repository: string | undefined,
  policy: ClaimedTreePolicy,
  reader = observationalReader(),
): Promise<ClaimedTreeObservation> {
  const found = await locateTree(dir, reader);
  if (found.kind === 'ended') return found.observation;
  const { located, tree } = found;
  if (repository !== undefined && tree.repository !== repository) return { ...tree, holdsBase: false, dirtyPaths: [] };
  if (tree.head === undefined) return { kind: 'unobservable', cause: 'The task checkout has no commit' };
  const relation = await decideRelation(located, 'ancestry', baseCommit, tree.head);
  if (policy === 'immutable' && relation.kind === 'unreadable') return { kind: 'unobservable', cause: relation.reason };
  const changes = await closedListingChanges(located.reads, located.gitDir, located.checkout, tree.head);
  if (changes === undefined) return { kind: 'unobservable', cause: 'The closed listings of the task checkout are unreadable' };
  return {
    ...tree,
    holdsBase: relation.kind === 'related',
    dirtyPaths: changes.slice(0, DIRTY_PATH_LIMIT).map(change => change.path),
  };
}
