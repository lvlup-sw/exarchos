/**
 * The scope of one `prepare` call: the repository of `repoRoot`, the commit of the base, and the config digest of the checkout.
 *
 * The caller names the repository with an absolute `repoRoot`, so prepare reads nothing from the server directory.
 * Git gives the root of the work tree as the checkout, and the common dir as the repository.
 * The base commit must hold the landed commit of each completed blocker of the batch.
 * A capsule that custody cannot return is not compared with the repository of the call.
 *
 * Each refusal here occurs before any effect. The module imports nothing from `src/verbs/settle`, so settle can import the config digest.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import type { CapsuleScope } from '../../contract/capsule/exarchos-capsule.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import {
  isAncestor,
  observeRepository,
  resolveCommit,
  type AncestryRead,
  type CommitRead,
  type RepositoryObservation,
} from '../../utils/git-tree.js';
import { capsuleOfRecord, latestPreparedRecordOf } from './prepared-record.js';
import type { PrepareRefusal } from './types.js';

/**
 * The rule of an absolute `repoRoot`: a slash, or a drive letter and a separator.
 * The action schema of prepare and the handler apply the same rule, because a direct handler call skips the schema.
 */
export const ABSOLUTE_REPO_ROOT = /^(?:\/|[A-Za-z]:[\\/])/;

/** The names of the config files whose bytes the config digest covers, in digest order. */
const CONFIG_FILE_NAMES: readonly string[] = ['.exarchos.yml', '.exarchos.yaml'];

/** The error codes of a read that mean that the file is absent. */
const ABSENT_FILE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The three git reads of prepare: the repository of a directory, the commit of a ref, and the ancestry of two commits.
 * Production uses {@link GIT_SCOPE}. A test passes its own reads, as it passes its own catalog.
 */
export interface ScopeGit {
  readonly observe: (dir: string) => Promise<RepositoryObservation>;
  readonly commitOf: (checkout: string, ref: string) => Promise<CommitRead>;
  readonly isAncestor: (checkout: string, ancestor: string, descendant: string) => Promise<AncestryRead>;
}

/** The git reads of production, each from the shared git observation. */
export const GIT_SCOPE: ScopeGit = { observe: observeRepository, commitOf: resolveCommit, isAncestor };

/** The rows of one stream read, as the handler reads them. */
type StreamRows = readonly { readonly type: string; readonly sequence: number; readonly data?: unknown }[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the absolute `repoRoot` of a call, or the message of an `INVALID_INPUT` refusal.
 * A relative path is refused, because git resolves it against the server directory.
 */
export function readRepoRoot(
  raw: Record<string, unknown>,
): { readonly ok: true; readonly repoRoot: string } | { readonly ok: false; readonly message: string } {
  const repoRoot = raw.repoRoot;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return {
      ok: false,
      message:
        'repoRoot is required: the absolute path of the worktree where the integration branch is checked out. ' +
        'prepare pins the repository of that path and reads no server directory.',
    };
  }
  if (!ABSOLUTE_REPO_ROOT.test(repoRoot)) {
    return {
      ok: false,
      message:
        `repoRoot ${JSON.stringify(repoRoot)} is not an absolute path. Git resolves a relative path against the ` +
        'server directory, so pass the absolute path of the worktree where the integration branch is checked out.',
    };
  }
  return { ok: true, repoRoot };
}

/** The error code of a failed file read, or the message when the error has no code. */
function errorCodeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}

/**
 * One entry of the config digest. A file that the checkout holds gives the sha256 of its bytes.
 * An absent file gives no digest. A file that cannot be read gives no digest and the code of the read error.
 */
async function configEntryOf(checkout: string, name: string): Promise<Record<string, string | null>> {
  try {
    const bytes = await readFile(path.join(checkout, name));
    return { name, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    const code = errorCodeOf(error);
    return ABSENT_FILE_CODES.has(code) ? { name, digest: null } : { name, digest: null, unreadable: code };
  }
}

/**
 * The digest of the config files at a checkout: the content digest of one entry for each name of {@link CONFIG_FILE_NAMES}, in that order.
 * The two config readers read both names, so an edit of either file changes the digest. A checkout with no config file gives the digest of two absent entries.
 */
export async function configDigestAt(checkout: string): Promise<string> {
  const entries: Record<string, string | null>[] = [];
  for (const name of CONFIG_FILE_NAMES) entries.push(await configEntryOf(checkout, name));
  return contentDigest(entries);
}

/**
 * The landed commit of one task on a base, from raw row data, because a parse of the completion row drops `commit`.
 * It is the `mergeSha` of the latest `merge.executed` row of the task whose `targetBranch` is the base.
 * Else it is the `commit` of the latest completion row of the task. A task with neither has no known commit.
 */
function landedCommitOf(rows: StreamRows, taskId: string, baseRef: string): string | undefined {
  let merged: string | undefined;
  let completed: string | undefined;
  for (const row of rows) {
    const data = row.data;
    if (!isRecord(data) || data.taskId !== taskId) continue;
    if (row.type === 'merge.executed' && data.targetBranch === baseRef && typeof data.mergeSha === 'string' && data.mergeSha.length > 0) {
      merged = data.mergeSha;
    } else if (row.type === 'task.completed' && typeof data.commit === 'string' && data.commit.length > 0) {
      completed = data.commit;
    }
  }
  return merged ?? completed;
}

/** What git observed for a call: the checkout and the repository of `repoRoot`, and the commit of the base in that checkout. */
export interface ObservedScope {
  readonly checkout: string;
  readonly repository: string;
  readonly baseCommit: string;
}

/** The input of {@link observeScope}. */
export interface ScopeInput {
  readonly streamId: string;
  readonly repoRoot: string;
  readonly baseRef: string;
  /** The completed blockers of each batch task, keyed by task id, as the partition gives them. */
  readonly completedBlockers: Readonly<Record<string, readonly string[]>>;
  /** The stream read of the call. The landed commits come from its rows. */
  readonly rows: StreamRows;
  readonly git: ScopeGit;
}

type ScopeOutcome =
  | { readonly ok: true; readonly observed: ObservedScope }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

function scopeUnresolved(message: string): ScopeOutcome {
  return { ok: false, refusal: { code: 'SCOPE_UNRESOLVED', message } };
}

function baseUnresolved(message: string): ScopeOutcome {
  return { ok: false, refusal: { code: 'BASE_UNRESOLVED', message } };
}

/** The tasks of the batch that wait on each completed blocker, keyed by the blocker, in sorted order. */
function waitersOf(completedBlockers: Readonly<Record<string, readonly string[]>>): Map<string, string[]> {
  const waiters = new Map<string, string[]>();
  for (const [taskId, blockers] of Object.entries(completedBlockers)) {
    for (const blocker of blockers) waiters.set(blocker, [...(waiters.get(blocker) ?? []), taskId]);
  }
  return new Map([...waiters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The refusal for a completed blocker whose landed commit the base does not hold. It names the blocker and both recoveries. */
function blockerNotOnBase(
  blocker: string,
  waiting: readonly string[],
  landed: string,
  baseRef: string,
  baseCommit: string,
  cause: string | undefined,
): ScopeOutcome {
  const tasks = waiting.map((taskId) => `'${taskId}'`).join(', ');
  return baseUnresolved(
    `task '${blocker}' is complete, and its landed commit ${landed} is not on '${baseRef}' at ${baseCommit}` +
      `${cause === undefined ? '' : ` (${cause})`}. ${tasks} wait on it and would fork from a base without its work, ` +
      `so nothing was compiled or recorded. Land '${blocker}' on '${baseRef}', then prepare again. If '${blocker}' ` +
      'landed by a squash or a rebase outside serialize_merge, record that landing with a merge.executed row whose ' +
      `taskId is '${blocker}', whose targetBranch is '${baseRef}' and whose mergeSha is the landed commit, then prepare again.`,
  );
}

/**
 * Observes the scope of a call before any effect, in three steps.
 * First git finds the repository of `repoRoot`. A directory outside a git work tree refuses `SCOPE_UNRESOLVED`.
 * Then the base resolves to a commit in the checkout. A base with no commit refuses `BASE_UNRESOLVED`.
 *
 * Last, the base commit must hold the landed commit of each completed blocker. A blocker with no known commit is not checked.
 */
export async function observeScope(input: ScopeInput): Promise<ScopeOutcome> {
  const { streamId, repoRoot, baseRef, git } = input;
  const located = await git.observe(repoRoot);
  if (located.kind === 'no-work-tree') {
    return scopeUnresolved(
      `repoRoot '${repoRoot}' is not inside a git work tree, so prepare cannot pin the repository of the batch, and ` +
        `nothing was compiled or recorded. Pass as repoRoot the worktree where '${baseRef}' is checked out, then prepare again.`,
    );
  }
  if (located.kind === 'unobservable') {
    return scopeUnresolved(
      `git could not observe repoRoot '${repoRoot}' (${located.cause}), so prepare cannot pin the repository of the ` +
        'batch, and nothing was compiled or recorded. Check that git runs in that directory, then prepare again.',
    );
  }
  const { toplevel: checkout, repository } = located;

  const base = await git.commitOf(checkout, baseRef);
  if (base.kind === 'absent') {
    return baseUnresolved(
      `'${streamId}' records the integration branch '${baseRef}', and the repository of '${checkout}' holds no commit ` +
        'of it, so no task in the batch has a commit to fork from, and nothing was compiled or recorded. Create ' +
        `'${baseRef}' in that repository, or pass as repoRoot a worktree of the repository that holds it, then prepare again.`,
    );
  }
  if (base.kind === 'unobservable') {
    return baseUnresolved(
      `git could not resolve the integration branch '${baseRef}' of '${streamId}' in '${checkout}' (${base.cause}), ` +
        'so nothing was compiled or recorded. Check that git runs in that directory, then prepare again.',
    );
  }
  const baseCommit = base.commit;

  for (const [blocker, waiting] of waitersOf(input.completedBlockers)) {
    const landed = landedCommitOf(input.rows, blocker, baseRef);
    if (landed === undefined) continue;
    const ancestry = await git.isAncestor(checkout, landed, baseCommit);
    if (ancestry.kind === 'ancestor') continue;
    const cause = ancestry.kind === 'unobservable' ? ancestry.cause : undefined;
    return blockerNotOnBase(blocker, waiting, landed, baseRef, baseCommit, cause);
  }
  return { ok: true, observed: { checkout, repository, baseCommit } };
}

/** The input of {@link otherRepositoryRefusal}. */
export interface RepositoryCheckInput {
  readonly streamId: string;
  readonly repoRoot: string;
  /** The repository that git observed for `repoRoot`. */
  readonly repository: string;
  /** The stream read of the call. The latest prepared record comes from its rows. */
  readonly rows: StreamRows;
  /** The store of the revision reads, so a seam that counts reads sees this read too. */
  readonly bundles: RunBundleStore;
}

/**
 * The refusal for a call in another repository than the latest capsule of the workflow, or `undefined`.
 * The handler calls it only on a call that compiles, so a replay reads no bundle.
 * A workflow with no prepared record, a capsule with no scope, and a capsule that custody cannot return are not compared.
 */
export async function otherRepositoryRefusal(input: RepositoryCheckInput): Promise<PrepareRefusal | undefined> {
  const latest = latestPreparedRecordOf(input.rows);
  if (latest === undefined) return undefined;
  let pinned: CapsuleScope | undefined;
  try {
    pinned = (await capsuleOfRecord(latest.record, input.bundles))?.capsule.settlementContract.scope;
  } catch {
    return undefined;
  }
  if (pinned === undefined || pinned.repository === input.repository) return undefined;
  return {
    code: 'SCOPE_UNRESOLVED',
    message:
      `the latest capsule of '${input.streamId}' (v${latest.record.capsuleVersion}) pins the repository ` +
      `'${pinned.repository}', and repoRoot '${input.repoRoot}' is in the repository '${input.repository}'. A workflow ` +
      'continues in the repository that its capsules pin, so nothing was compiled or recorded. Run prepare with a ' +
      `repoRoot in a checkout of '${pinned.repository}'. If that repository moved or this is a new clone, put the ` +
      `clone back at '${pinned.checkout}', or start a new workflow for the rest of the work.`,
  };
}
