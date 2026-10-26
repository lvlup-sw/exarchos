/**
 * Helpers for tests that settle a capsule that pins a scope.
 *
 * `inScopeObserver` replaces the git observation of settle. For any path, it gives a work tree of the pinned
 * repository at that path. So a claim on a path that does not exist passes the scope rules of settle.
 * `scopeOfCheckout` and `withScope` give a hand-built capsule the scope terms that a compiler which pins the scope writes.
 * The scope names a temp checkout, and its digest is the digest of the config files there, so settle runs its segments.
 */
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../src/contract/capsule/exarchos-capsule.js';
import { canonicalPath, type TreeObserver } from '../../src/utils/git-tree.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';

/** The base commit that a hand-built capsule pins for each task: a full SHA-1 object name. */
const SCOPED_BASE_COMMIT = 'c'.repeat(40);

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

/**
 * The scope of a checkout directory, which the helper makes when it is absent. The checkout is the canonical path of the directory.
 * The repository is the `.git` directory under it, so the checkout is also the primary worktree of the scope.
 * The config digest is the digest of the config files of the checkout at the time of the call.
 */
export async function scopeOfCheckout(dir: string): Promise<CapsuleScope> {
  await mkdir(dir, { recursive: true });
  const checkout = canonicalPath(dir);
  return { repository: `${checkout}/.git`, checkout, configDigest: await configDigestAt(checkout) };
}

/**
 * A hand-built capsule with the scope terms of a compiler that pins the scope. The settlement contract gets the scope,
 * and the terms of each task get a base commit. A task whose terms hold a base commit keeps it.
 */
export function withScope(capsule: ExarchosCapsuleV1, scope: CapsuleScope): ExarchosCapsuleV1 {
  const terms = capsule.settlementContract.taskVerification;
  return {
    ...capsule,
    settlementContract: {
      ...capsule.settlementContract,
      ...(terms === undefined
        ? {}
        : {
            taskVerification: Object.fromEntries(
              Object.entries(terms).map(([taskId, term]) => [taskId, { ...term, baseCommit: term.baseCommit ?? SCOPED_BASE_COMMIT }]),
            ),
          }),
      scope,
    },
  };
}
