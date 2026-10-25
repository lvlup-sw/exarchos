/**
 * Helpers for tests that settle a capsule that pins a scope.
 *
 * `inScopeObserver` replaces the git observation of settle. For any path, it gives a work tree of the pinned
 * repository at that path. So a claim on a path that does not exist passes the scope rules of settle.
 */
import * as path from 'node:path';

import type { CapsuleScope } from '../../src/contract/capsule/exarchos-capsule.js';
import { canonicalPath, type TreeObserver } from '../../src/utils/git-tree.js';

/**
 * An observer that finds each path in scope. The tree is the root of a work tree of `scope.repository` at the path,
 * on the branch `task/<last segment of the path>`. Its head is the base commit, so it holds the base, and its status is empty.
 * The tree is never the checkout or the primary worktree when the claim names neither.
 */
export function inScopeObserver(scope: Pick<CapsuleScope, 'repository'>): TreeObserver {
  return async (dir, baseCommit) => {
    const toplevel = canonicalPath(dir);
    return {
      kind: 'tree',
      toplevel,
      repository: scope.repository,
      branch: `task/${path.posix.basename(toplevel)}`,
      head: baseCommit,
      holdsBase: true,
      dirtyPaths: [],
    };
  };
}
