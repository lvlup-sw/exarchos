/**
 * The in-process worktree-lifecycle facade. `WorktreeManager` turns worktree
 * ownership intentions into events on the singleton `worktrees` stream. It
 * holds no state: ownership lives only in the event log, and the
 * `worktrees@v1` projection folds the live set.
 *
 * Adoption keys off the event stream and `git worktree list --porcelain`, not a
 * harness callback, so it works for any harness and for a hand-made worktree.
 * A released worktree can be pruned, but it is never recycled.
 *
 * Each write goes through the shared `EventStore`, so the per-stream lock of the
 * appender serializes the writes. The side-effect import of
 * `./projections/index.js` registers the `worktrees@v1` reducer once per process.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { EventStore } from '../../events/store.js';
import type { EventInput, DecideResult } from '../../events/atomic-appender.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { spawnCommandSync } from '../../utils/process.js';
import { removeWorktreeForce } from '../../vcs/mutation-owner.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from './pure/process-identity.js';
import {
  canonicalWorktreeId,
  defaultRealpath,
  type RealpathResolver,
} from './pure/path-containment.js';
import {
  probeWorktrees,
  defaultProcessTableSource,
  type ProcessTableSource,
} from './pure/probe.js';
import {
  defaultSleep,
  defaultJitter,
  withIndexLockRetry,
  isIndexLockError,
  MAX_INDEX_LOCK_RETRIES,
  type SleepFn,
  type JitterFn,
} from './git-retry.js';
import { reservationLiveness, selectDeadReservations } from './pure/ownership.js';
import {
  classifyPruneCandidate,
  type PruneCandidate,
  type PruneClassification,
  type PruneSkipReason,
} from './pure/prune-ladder.js';
import type {
  WorktreeEntry,
  WorktreesProjection,
  InFlightMerge,
  InFlightPrune,
} from './projections/worktrees.js';
import './projections/index.js';

/** The dedicated singleton stream that carries the worktree-lifecycle family. */
export const WORKTREES_STREAM = 'worktrees';

/** Reducer id used to fold {@link WORKTREES_STREAM} into the live worktree set. */
export const WORKTREES_REDUCER = 'worktrees@v1';

/** Default bounded-wait budget (ms) for {@link WorktreeManager.waitForMergeTerminal}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** Default poll interval (ms) between bounded-wait re-folds. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 200;

/** One on-disk worktree, as reported by `git worktree list --porcelain`. */
export interface OnDiskWorktree {
  /** Absolute worktree path emitted by git (already symlink-resolved by git). */
  readonly path: string;
  /** HEAD commit sha, or `null` for a bare/empty entry. */
  readonly head: string | null;
  /** Short branch name (`refs/heads/x` → `x`), or `null` when detached/bare. */
  readonly branch: string | null;
  /** True when the worktree is in detached-HEAD state. */
  readonly detached: boolean;
  /** True for the `bare` main entry. */
  readonly bare: boolean;
}

/**
 * The stale-after-push verdict for one worktree.
 *
 * `mutable` is `false` when HEAD does not resolve, or when the worktree is
 * behind its upstream. Behind means that the tracking ref holds commits that
 * HEAD does not have, so a commit there can drop the newly pushed files. A
 * worktree with no upstream is mutable.
 */
export interface HeadVerification {
  /** Fresh HEAD sha re-read at verify time, or `null` when unresolved. */
  readonly head: string | null;
  /** Upstream tip sha compared against, or `null` when no tracking ref. */
  readonly upstream: string | null;
  /** Whether the worktree is safe to mutate (upstream contained in HEAD). */
  readonly mutable: boolean;
  readonly reason:
    | 'up-to-date'
    | 'no-upstream'
    | 'stale-after-push'
    | 'head-unresolved';
}

/**
 * Read-only probe over real git. Tests inject a fake. The default is
 * {@link defaultGitWorktreeProbe}.
 */
export interface GitWorktreeProbe {
  /** Enumerate on-disk worktrees of `repoRoot` (empty on any git failure). */
  listWorktrees(repoRoot: string): OnDiskWorktree[];
  /** Re-verify a worktree's HEAD/ancestry against its upstream (freshly read). */
  verifyHead(worktreePath: string): HeadVerification;
}

/**
 * Derives the `featureId` of the owning workflow for an on-disk worktree, or
 * `null` when the worktree is unattached. It is injected, so the manager holds
 * no harness knowledge.
 */
export type FeatureIdResolver = (worktree: OnDiskWorktree) => string | null;

/** Default resolver: no harness assumption — every worktree is unattached. */
export const unattachedFeatureIdResolver: FeatureIdResolver = () => null;

/**
 * Parse `git worktree list --porcelain` into {@link OnDiskWorktree} records.
 *
 * Blank lines separate records. Each record starts with `worktree <path>`, then
 * attribute lines: `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, and
 * `bare`. Other lines, such as `locked` and `prunable`, are ignored. The parser
 * is pure and accepts CRLF.
 */
export function parseWorktreeListPorcelain(stdout: string): OnDiskWorktree[] {
  const out: OnDiskWorktree[] = [];
  let cur:
    | {
        path: string;
        head: string | null;
        branch: string | null;
        detached: boolean;
        bare: boolean;
      }
    | null = null;
  const flush = (): void => {
    if (cur !== null) out.push({ ...cur });
    cur = null;
  };
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
      };
    } else if (cur === null) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      const sha = line.slice('HEAD '.length).trim();
      cur.head = sha.length > 0 ? sha : null;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      cur.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref;
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    }
  }
  flush();
  return out;
}

/**
 * Run `git <args>` from `cwd` through {@link spawnCommandSync}, not through
 * `execFileSync` of a resolved `.cmd` shim. It does not throw: a failure is a
 * non-zero `status`. When git does not start, `stderr` falls back to the spawn
 * error message, so a failure always has a message.
 */
function gitCapture(
  args: readonly string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnCommandSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = result.stderr ?? '';
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: stderr || (result.error?.message ?? ''),
  };
}

/** Resolve a ref to its sha in `worktreePath`, or `null` when it does not exist. */
function gitRevParse(worktreePath: string, ref: string): string | null {
  const { status, stdout } = gitCapture(
    ['rev-parse', '--verify', '--quiet', ref],
    worktreePath,
  );
  if (status !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * The default real-git probe. `verifyHead` reads HEAD again at verify time, not
 * from the porcelain snapshot. A worktree is mutable when it has no upstream, or
 * when HEAD contains the upstream tip.
 */
export const defaultGitWorktreeProbe: GitWorktreeProbe = {
  listWorktrees(repoRoot: string): OnDiskWorktree[] {
    const { status, stdout } = gitCapture(
      ['worktree', 'list', '--porcelain'],
      repoRoot,
    );
    if (status !== 0) return [];
    return parseWorktreeListPorcelain(stdout);
  },
  verifyHead(worktreePath: string): HeadVerification {
    const head = gitRevParse(worktreePath, 'HEAD');
    if (head === null) {
      return { head: null, upstream: null, mutable: false, reason: 'head-unresolved' };
    }
    const upstream = gitRevParse(worktreePath, '@{upstream}');
    if (upstream === null) {
      return { head, upstream: null, mutable: true, reason: 'no-upstream' };
    }
    if (upstream === head) {
      return { head, upstream, mutable: true, reason: 'up-to-date' };
    }
    const upstreamContained =
      gitCapture(['merge-base', '--is-ancestor', upstream, 'HEAD'], worktreePath)
        .status === 0;
    return upstreamContained
      ? { head, upstream, mutable: true, reason: 'up-to-date' }
      : { head, upstream, mutable: false, reason: 'stale-after-push' };
  },
};

/**
 * An injectable seam over `git`. Each prune git operation, including the
 * `git worktree remove` deletion, goes through this runner. A test can record
 * the argument vectors and assert that no path runs `git reset --hard`. It does
 * not throw: a failure is a non-zero `status`.
 */
export interface GitRunner {
  run(
    args: readonly string[],
    cwd: string,
  ): { status: number; stdout: string; stderr?: string };
}

/** Default real git runner over the portable {@link spawnCommandSync} helper. */
export const defaultGitRunner: GitRunner = {
  run(
    args: readonly string[],
    cwd: string,
  ): { status: number; stdout: string; stderr: string } {
    return gitCapture(args, cwd);
  },
};

/** Per-worktree outcome of an {@link WorktreeManager.adopt} pass. */
export interface WorktreeAdoptionReport {
  /** Canonical (symlink-resolved) worktree path — the projection key. */
  readonly worktreeId: string;
  /** Absolute worktree path as reported on disk. */
  readonly path: string;
  /** Owning feature id, or `null` (hand-made / unattached). */
  readonly featureId: string | null;
  /** True when THIS pass appended a `worktree.adopted` event (was untracked). */
  readonly newlyAdopted: boolean;
  /** Stale-after-push HEAD/ancestry verdict — gate mutation on `mutable`. */
  readonly verification: HeadVerification;
}

/** Outcome of an {@link WorktreeManager.adopt} pass. */
export interface AdoptResult {
  /** Every on-disk worktree observed, with its adoption + mutability verdict. */
  readonly worktrees: readonly WorktreeAdoptionReport[];
  /** The `worktreeId`s for which a `worktree.adopted` event was appended. */
  readonly adopted: readonly string[];
}

/** Arguments for {@link WorktreeManager.prune}. */
export interface PruneOptions {
  /** Repo root the on-disk worktree set is enumerated from (adopt-gate + probe). */
  readonly repoRoot: string;
  /**
   * Delete the eligible candidates. When omitted or `false`, the pass is a dry
   * run: it reports, deletes nothing, and runs no crash recovery.
   */
  readonly apply?: boolean;
  /**
   * Opt in to deleting `orphan-unverifiable` candidates, whose backing repo is
   * gone. It takes effect only with {@link yes} on an `apply` run.
   */
  readonly pruneOrphans?: boolean | undefined;
  /** Explicit confirmation required alongside {@link pruneOrphans} for orphans. */
  readonly yes?: boolean | undefined;
}

/** Per-candidate line of a {@link PruneResult}. */
export interface PruneCandidateReport {
  /** Canonical (symlink-resolved) worktree path — the projection key. */
  readonly worktreeId: string;
  /** Absolute worktree path. */
  readonly path: string;
  /** Owning feature id, or `null` when unattached. */
  readonly featureId: string | null;
  /** Folded `worktrees@v1` lifecycle state at classification time. */
  readonly state: WorktreeEntry['state'];
  /** The ladder verdict for this candidate. */
  readonly classification: PruneClassification;
  /** Best-effort on-disk bytes reclaimable IF deleted (0 when not reclaimable). */
  readonly reclaimableBytes: number;
  /** True when this pass committed the delete intent for the worktree. Always false on a dry run. */
  readonly deleted: boolean;
}

/** Outcome of a {@link WorktreeManager.prune} pass. */
export interface PruneResult {
  /** True when nothing was deleted because no explicit `apply` flag was passed. */
  readonly dryRun: boolean;
  /** Every governed worktree, with its ladder verdict and reclaimable bytes. */
  readonly candidates: readonly PruneCandidateReport[];
  /** The `worktreeId`s actually deleted this pass (empty on dry-run). */
  readonly deleted: readonly string[];
  /** Total reclaimable bytes across the delete-eligible and orphan candidates. */
  readonly reclaimableBytes: number;
  /** Skip {@link PruneSkipReason} → the `worktreeId`s skipped for it (scannable). */
  readonly skipsByReason: Readonly<Partial<Record<PruneSkipReason, readonly string[]>>>;
}

/**
 * Whether the backing gitdir of the worktree resolves. A `.git` directory means
 * present. A `.git` file means present when its `gitdir:` target exists.
 * Anything else means that the backing is gone. It does not throw.
 */
function probeBackingGitdir(worktreePath: string): boolean {
  const dotGit = path.join(worktreePath, '.git');
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return false;
  }
  if (st.isDirectory()) return true;
  if (!st.isFile()) return false;
  let content: string;
  try {
    content = readFileSync(dotGit, 'utf8');
  } catch {
    return false;
  }
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match || match[1] === undefined) return false;
  const target = match[1].trim();
  const resolved = path.isAbsolute(target)
    ? target
    : path.resolve(worktreePath, target);
  try {
    statSync(resolved);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort recursive byte size of `dir`. Unreadable entries and symlinks count as 0. */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += dirSizeBytes(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    } catch {
    }
  }
  return total;
}

/** Read a string field off an event payload (`null` when absent / non-string). */
function eventStringField(event: WorkflowEvent, key: string): string | null {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Whether an unpaired in-flight merge lease covers a prune candidate. The
 * planning pass and the re-verify inside `executeDeletion` both call it.
 *
 * A lease covers the candidate when its `worktreeId` matches, or when its
 * `integrationRef` matches the integration ref of the candidate. The serializer
 * leaves `worktreeId` null, so the ref match catches a `serialize_merge` that
 * races the prune. A held lease keeps the worktree.
 */
function mergeLeaseHeld(
  worktreeId: string,
  integrationRef: string | null,
  inFlightMerges: Readonly<Record<string, InFlightMerge>>,
): boolean {
  for (const merge of Object.values(inFlightMerges)) {
    if (merge.worktreeId !== null && merge.worktreeId === worktreeId) return true;
    if (integrationRef !== null && merge.integrationRef === integrationRef) return true;
  }
  return false;
}

/** Constructor dependencies for {@link WorktreeManager}. */
export interface WorktreeManagerDeps {
  /** The shared event store — the manager's ONLY persistence path. */
  readonly eventStore: EventStore;
  /** Per-PID source for the owner liveness probe. Defaults to {@link defaultProcessSource}. */
  readonly processSource?: ProcessSource;
  /** Real-git probe for `adopt`. Defaults to {@link defaultGitWorktreeProbe}. */
  readonly gitProbe?: GitWorktreeProbe;
  /**
   * Derives the owning `featureId` of an adopted worktree. Defaults to
   * {@link unattachedFeatureIdResolver}.
   */
  readonly featureIdResolver?: FeatureIdResolver;
  /**
   * Symlink-resolving canonicalizer for `worktreeId`. Defaults to
   * {@link defaultRealpath}, which the `worktrees@v1` reducer also uses, so
   * both agree on the key.
   */
  readonly realpath?: RealpathResolver;
  /** Git runner for each prune probe and the deletion. Defaults to {@link defaultGitRunner}. */
  readonly gitRunner?: GitRunner;
  /**
   * Full process-table source for {@link WorktreeManager.probeAndReclaim}, used
   * for cwd occupancy. Defaults to {@link defaultProcessTableSource}, which reads
   * `/proc` on Linux. On other platforms, each owner reads as `'unknown'`, so the
   * probe releases nothing.
   */
  readonly processTableSource?: ProcessTableSource;
  /**
   * Sleep seam for the `index.lock` retry backoff on the prune remove path.
   * Defaults to {@link defaultSleep}.
   */
  readonly sleep?: SleepFn;
  /** Signed-jitter source in `[-1, 1]` for the retry backoff. Defaults to {@link defaultJitter}. */
  readonly jitter?: JitterFn;
  /**
   * Retries after the first attempt for the `index.lock` retry around the prune
   * `git worktree remove`. Defaults to {@link MAX_INDEX_LOCK_RETRIES}.
   */
  readonly maxIndexLockRetries?: number;
}

/** Arguments for {@link WorktreeManager.reserve}. */
export interface ReserveInput {
  /** Canonical (symlink-resolved) worktree path — the stable identity. */
  readonly worktreeId: string;
  /** Absolute filesystem path to the worktree. */
  readonly path: string;
  /** Owning feature id, or `null` when unattached. */
  readonly featureId: string | null;
  /** PID of the reserving (live) process. */
  readonly ownerPid: number;
  /**
   * The create-time fingerprint of the reserving process, compared for
   * equality. It is `null`, never `''`, when the platform cannot resolve it. A
   * `null` create-time cannot match a live process, so the reservation is
   * reclaimable.
   */
  readonly ownerStartedAt: string | null;
}

/** The live-process identity of a reservation owner (PID + create-time). */
export interface ReservationOwner {
  /** PID of the owning process. */
  readonly ownerPid: number;
  /**
   * The create-time fingerprint of the owner, compared for equality. It is
   * `null`, never `''`, when the platform cannot resolve it.
   */
  readonly ownerStartedAt: string | null;
}

/** Outcome of a {@link WorktreeManager.reserve} call. */
export interface ReserveResult {
  /**
   * True when this call holds the reservation afterwards. `false` means that a
   * different live owner holds the worktree, and the claim was rejected.
   */
  readonly reserved: boolean;
  /** The live owner that blocked the claim. Present only when `reserved` is `false`. */
  readonly conflict?: ReservationOwner;
}

/** Outcome of a {@link WorktreeManager.release} call. */
export interface ReleaseResult {
  /** True when this call appended a `worktree.released` (the claim is now free). */
  readonly released: boolean;
  /**
   * True when a different live owner holds the worktree, so the release was
   * rejected. `released` is then `false`.
   */
  readonly rejectedForeignOwner: boolean;
}

/** Outcome of a {@link WorktreeManager.reconcile} pass. */
export interface ReconcileResult {
  /**
   * The `worktreeId`s that this pass released. It is empty when nothing needed
   * healing, and for the loser of a concurrent reconcile.
   */
  readonly released: readonly string[];
}

/** Outcome of a {@link WorktreeManager.probeAndReclaim} pass. */
export interface ProbeReclaimResult {
  /** `worktreeId`s for which a `worktree.released` was emitted (owner dead, not in use). */
  readonly released: readonly string[];
  /** `worktreeId`s for which a `worktree.orphan_detected` was emitted (owner dead, still in use). */
  readonly orphaned: readonly string[];
  /** Total governed worktrees the probe classified this pass. */
  readonly probed: number;
}

/** Outcome of a {@link WorktreeManager.waitForMergeTerminal} bounded poll. */
export type WaitForMergeTerminalResult =
  | { readonly resolved: true; readonly waitedMs: number }
  | { readonly resolved: false; readonly holder: InFlightMerge; readonly waitedMs: number };

/**
 * Outcome of a {@link WorktreeManager.waitForPruneIdle} bounded poll. On a
 * timeout, it carries the prune passes that are still in flight.
 */
export type WaitForPruneIdleResult =
  | { readonly resolved: true; readonly waitedMs: number }
  | { readonly resolved: false; readonly holders: readonly InFlightPrune[]; readonly waitedMs: number };

/**
 * The in-process worktree-lifecycle facade. Construct one per
 * {@link EventStore}. It is cheap and holds no mutable state.
 */
export class WorktreeManager {
  private readonly eventStore: EventStore;
  private readonly processSource: ProcessSource;
  private readonly gitProbe: GitWorktreeProbe;
  private readonly featureIdResolver: FeatureIdResolver;
  private readonly realpath: RealpathResolver;
  private readonly gitRunner: GitRunner;
  private readonly processTableSource: ProcessTableSource;
  private readonly sleep: SleepFn;
  private readonly jitter: JitterFn;
  private readonly maxIndexLockRetries: number;

  constructor(deps: WorktreeManagerDeps) {
    this.eventStore = deps.eventStore;
    this.processSource = deps.processSource ?? defaultProcessSource;
    this.gitProbe = deps.gitProbe ?? defaultGitWorktreeProbe;
    this.featureIdResolver = deps.featureIdResolver ?? unattachedFeatureIdResolver;
    this.realpath = deps.realpath ?? defaultRealpath;
    this.gitRunner = deps.gitRunner ?? defaultGitRunner;
    this.processTableSource = deps.processTableSource ?? defaultProcessTableSource;
    this.sleep = deps.sleep ?? defaultSleep;
    this.jitter = deps.jitter ?? defaultJitter;
    this.maxIndexLockRetries = deps.maxIndexLockRetries ?? MAX_INDEX_LOCK_RETRIES;
  }

  /**
   * The canonical `worktreeId` for a worktree path, from
   * {@link canonicalWorktreeId} with the injected realpath. Adopt, the registry
   * check, and the `worktrees@v1` reducer share this key. Forward slashes and
   * backslashes fold to one key on Windows.
   */
  private canonicalId(p: string): string {
    return canonicalWorktreeId(p, this.realpath);
  }

  /**
   * Reserve a worktree for a live process, with exclusive ownership.
   *
   * A `decide` over `worktrees@v1` folds the state before it appends. If a
   * different owner that is not provably dead holds the worktree, the claim is
   * rejected and emits nothing. Two concurrent reserves give one winner: the
   * loser fails the concurrency check, folds again, and rejects. A rejected
   * claim returns zero events, so `alwaysEnforceConsistency` is off.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const appender = this.eventStore.getAppender();
    let reserved = false;
    let conflict: ReservationOwner | undefined;
    await withStateRetry(async () => {
      reserved = false;
      conflict = undefined;
      const operationId = randomUUID();
      const result = await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        (state) => {
          const entry = state.worktrees[input.worktreeId];
          const liveOwner = this.liveForeignOwner(entry, {
            ownerPid: input.ownerPid,
            ownerStartedAt: input.ownerStartedAt,
          });
          if (liveOwner !== null) {
            conflict = liveOwner;
            return [];
          }
          return [
            {
              type: 'worktree.reserved',
              data: {
                worktreeId: input.worktreeId,
                path: input.path,
                featureId: input.featureId,
                ownerPid: input.ownerPid,
                ownerStartedAt: input.ownerStartedAt,
                operationId,
              },
            },
          ];
        },
        { operationId, alwaysEnforceConsistency: false },
      );
      reserved = result.kind !== 'no-op';
    });
    return conflict !== undefined ? { reserved: false, conflict } : { reserved };
  }

  /**
   * Release a worktree, but never the reservation of another live process.
   *
   * If a live owner other than `owner` holds the worktree, the release is
   * rejected and emits nothing. A release without `owner` is also rejected
   * while a live owner holds the worktree. Otherwise, it appends
   * `worktree.released` with the `path` and `featureId` of the current entry.
   * An unknown `worktreeId` still emits a well-formed event.
   */
  async release(worktreeId: string, owner?: ReservationOwner): Promise<ReleaseResult> {
    const appender = this.eventStore.getAppender();
    let released = false;
    let rejectedForeignOwner = false;
    await withStateRetry(async () => {
      released = false;
      rejectedForeignOwner = false;
      const operationId = randomUUID();
      const result = await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        (state) => {
          const entry = state.worktrees[worktreeId];
          if (this.liveForeignOwner(entry, owner) !== null) {
            rejectedForeignOwner = true;
            return [];
          }
          return [
            {
              type: 'worktree.released',
              data: {
                worktreeId,
                path: entry?.path ?? worktreeId,
                featureId: entry?.featureId ?? null,
                ownerPid: null,
                ownerStartedAt: null,
                operationId,
              },
            },
          ];
        },
        { operationId, alwaysEnforceConsistency: false },
      );
      released = result.kind !== 'no-op';
    });
    return { released, rejectedForeignOwner };
  }

  /**
   * The owner that blocks `caller`: the owner of a `reserved` entry that is
   * alive or unknown, and is not `caller`. It returns `null` for a provably dead
   * owner, an entry that is not reserved, or the same owner. `reserve` and
   * `release` share it.
   */
  private liveForeignOwner(
    entry: WorktreeEntry | undefined,
    caller: ReservationOwner | undefined,
  ): ReservationOwner | null {
    if (
      entry === undefined ||
      entry.state !== 'reserved' ||
      entry.ownerPid === null ||
      entry.ownerStartedAt === null
    ) {
      return null;
    }
    if (reservationLiveness(entry, this.processSource) === 'dead') {
      return null;
    }
    const sameOwner =
      caller !== undefined &&
      entry.ownerPid === caller.ownerPid &&
      entry.ownerStartedAt === caller.ownerStartedAt;
    return sameOwner
      ? null
      : { ownerPid: entry.ownerPid, ownerStartedAt: entry.ownerStartedAt };
  }

  /**
   * The heal fold. It appends one `worktree.released` for each `reserved` entry
   * whose owner {@link selectDeadReservations} finds dead.
   *
   * It runs `decide` under `withStateRetry`. A reconcile that loses the
   * concurrency race folds again and emits nothing, so a dead worktree is
   * released at most once. A pass with nothing to heal returns zero events, so
   * `alwaysEnforceConsistency` is off.
   */
  async reconcile(): Promise<ReconcileResult> {
    const appender = this.eventStore.getAppender();
    let released: string[] = [];
    await withStateRetry(async () => {
      released = [];
      const operationId = randomUUID();
      await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        (state) => {
          const dead = selectDeadReservations(
            Object.values(state.worktrees),
            this.processSource,
          );
          released = dead.map((entry) => entry.worktreeId);
          return dead.map((entry) => ({
            type: 'worktree.released',
            data: {
              worktreeId: entry.worktreeId,
              path: entry.path,
              featureId: entry.featureId,
              ownerPid: null,
              ownerStartedAt: null,
              operationId: randomUUID(),
            },
          }));
        },
        { operationId, alwaysEnforceConsistency: false },
      );
    });
    return { released };
  }

  /**
   * Adopt each on-disk worktree of `repoRoot` that has no tracking entry, as
   * `worktree.adopted`. The manager creates nothing.
   *
   * A tracked worktree, including a released one, gets no new event. Each
   * worktree gets a fresh {@link GitWorktreeProbe.verifyHead} verdict, so a
   * worktree behind a pushed tip reports `mutable: false`. The fold runs under
   * `decide`, so a concurrent adopt that loses emits nothing.
   */
  async adopt(repoRoot: string): Promise<AdoptResult> {
    const onDisk = this.gitProbe.listWorktrees(repoRoot);
    const probed = onDisk.map((wt) => ({
      worktreeId: this.canonicalId(wt.path),
      path: wt.path,
      featureId: this.featureIdResolver(wt),
      verification: this.gitProbe.verifyHead(wt.path),
    }));

    const appender = this.eventStore.getAppender();
    let adopted: string[] = [];
    await withStateRetry(async () => {
      adopted = [];
      const operationId = randomUUID();
      await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        (state) => {
          const events: EventInput[] = [];
          for (const r of probed) {
            if (
              Object.prototype.hasOwnProperty.call(state.worktrees, r.worktreeId)
            ) {
              continue;
            }
            adopted.push(r.worktreeId);
            events.push({
              type: 'worktree.adopted',
              data: {
                worktreeId: r.worktreeId,
                path: r.path,
                featureId: r.featureId,
                ownerPid: null,
                ownerStartedAt: null,
                operationId: randomUUID(),
              },
            });
          }
          return events;
        },
        { operationId, alwaysEnforceConsistency: false },
      );
    });

    const adoptedSet = new Set(adopted);
    return {
      worktrees: probed.map((r) => ({
        worktreeId: r.worktreeId,
        path: r.path,
        featureId: r.featureId,
        newlyAdopted: adoptedSet.has(r.worktreeId),
        verification: r.verification,
      })),
      adopted,
    };
  }

  /**
   * Prune governed worktrees inside a liveness pair. It appends
   * `prune.executing_started` before {@link runPruneLadder}, and
   * `prune.executed` in a `finally`, so a throw still closes the pair. On a
   * throw, the terminal reports zero deletions. The projection folds the pair
   * into `inFlightPrunes`.
   */
  async prune(options: PruneOptions): Promise<PruneResult> {
    const operationId = randomUUID();
    await this.appendPruneStarted(operationId, options.repoRoot);
    let result: PruneResult | undefined;
    try {
      result = await this.runPruneLadder(options);
      return result;
    } finally {
      await this.appendPruneExecuted(operationId, result?.deleted.length ?? 0);
    }
  }

  /**
   * Append `prune.executing_started` with this process as the holder, so a long
   * prune pass is visible as in flight. `holderStartedAt` is `null`, never `''`,
   * when the platform cannot resolve the create-time. The `instanceId` is the
   * per-pass `operationId`.
   */
  private async appendPruneStarted(
    operationId: string,
    repoRoot: string,
  ): Promise<void> {
    const holderPid = process.pid;
    const probe = this.processSource.getStartTime(holderPid);
    const holderStartedAt =
      probe.status === 'present' && probe.startedAt.length > 0
        ? probe.startedAt
        : null;
    await withStateRetry(() =>
      this.eventStore.append(
        WORKTREES_STREAM,
        {
          type: 'prune.executing_started',
          data: { operationId, repoRoot, holderPid, holderStartedAt, instanceId: operationId },
        },
        { idempotencyKey: `prune.executing_started:${operationId}` },
      ),
    );
  }

  /**
   * Append the paired terminal `prune.executed`, which clears the in-flight
   * prune marker. {@link prune} calls it from a `finally`.
   */
  private async appendPruneExecuted(
    operationId: string,
    deletedCount: number,
  ): Promise<void> {
    await withStateRetry(() =>
      this.eventStore.append(
        WORKTREES_STREAM,
        {
          type: 'prune.executed',
          data: { operationId, deletedCount, instanceId: operationId },
        },
        { idempotencyKey: `prune.executed:${operationId}` },
      ),
    );
  }

  /**
   * Prune governed worktrees through the fail-closed safety ladder:
   *
   * 1. Adopt first, so each on-disk worktree has a state before classification.
   * 2. On `apply` only, finish each crashed deletion. A dry run has no side effects.
   * 3. Classify each candidate with {@link classifyPruneCandidate}. A held
   *    merge lease turns an eligible candidate into an `in-flight-merge` skip.
   * 4. On `apply`, delete each eligible candidate with {@link executeDeletion}.
   *    An orphan needs both `pruneOrphans` and `yes`.
   */
  private async runPruneLadder(options: PruneOptions): Promise<PruneResult> {
    const { repoRoot } = options;
    const apply = options.apply === true;
    const orphansOptedIn = options.pruneOrphans === true && options.yes === true;

    await this.adopt(repoRoot);

    if (apply) {
      await this.recoverOrphanedRemovals(repoRoot);
    }

    const projection = await this.loadProjection();
    const candidates = Object.values(projection.worktrees);
    const branchCache = new Map<string, string | null>();

    const reports: PruneCandidateReport[] = [];
    for (const entry of candidates) {
      const facts = await this.gatherFacts(entry, branchCache);
      let classification = classifyPruneCandidate(facts);
      if (
        (classification.action === 'delete-eligible' ||
          classification.action === 'orphan-unverifiable') &&
        mergeLeaseHeld(entry.worktreeId, facts.integrationRef, projection.inFlightMerges)
      ) {
        classification = { action: 'skip', reason: 'in-flight-merge' };
      }
      const reclaimable =
        classification.action === 'delete-eligible' ||
        classification.action === 'orphan-unverifiable'
          ? dirSizeBytes(entry.path)
          : 0;
      reports.push({
        worktreeId: entry.worktreeId,
        path: entry.path,
        featureId: entry.featureId,
        state: entry.state,
        classification,
        reclaimableBytes: reclaimable,
        deleted: false,
      });
    }

    const deleted: string[] = [];
    if (apply) {
      for (let i = 0; i < reports.length; i += 1) {
        const report = reports[i];
        if (report === undefined) continue;
        const eligible =
          report.classification.action === 'delete-eligible' ||
          (report.classification.action === 'orphan-unverifiable' && orphansOptedIn);
        if (!eligible) continue;
        const { attempted } = await this.executeDeletion(
          repoRoot,
          report.worktreeId,
          report.path,
          orphansOptedIn,
          branchCache,
        );
        if (attempted) {
          reports[i] = { ...report, deleted: true };
          deleted.push(report.worktreeId);
        }
      }
    }

    const skipsByReason: Partial<Record<PruneSkipReason, string[]>> = {};
    for (const report of reports) {
      if (report.classification.action === 'skip') {
        const reason = report.classification.reason;
        (skipsByReason[reason] ??= []).push(report.worktreeId);
      }
    }

    return {
      dryRun: !apply,
      candidates: reports,
      deleted,
      reclaimableBytes: reports.reduce((sum, r) => sum + r.reclaimableBytes, 0),
      skipsByReason,
    };
  }

  /**
   * The governed worktree set, folded from the `worktrees` stream. It is a pure
   * read with no git or process probe. The order is the projection insertion
   * order, which is stable for one stream.
   */
  async list(): Promise<readonly WorktreeEntry[]> {
    const projection = await this.loadProjection();
    return Object.values(projection.worktrees);
  }

  /**
   * The live serialized merges: each open `worktree.merge_requested` with no
   * paired `worktree.merge_executed`. It is a pure fold of the event log.
   */
  async listInFlightMerges(): Promise<readonly InFlightMerge[]> {
    const projection = await this.loadProjection();
    return Object.values(projection.inFlightMerges);
  }

  /**
   * The entries with a launcher child in flight, marked by a present `launch`
   * field. That is a `launch.executing_started` with no paired `launch.executed`.
   * It is a pure fold of the event log.
   */
  async listInFlightLaunches(): Promise<readonly WorktreeEntry[]> {
    const projection = await this.loadProjection();
    return Object.values(projection.worktrees).filter(
      (entry) => entry.launch !== undefined,
    );
  }

  /**
   * The live prune passes: each open `prune.executing_started` with no paired
   * `prune.executed`. It is a pure fold of the event log.
   */
  async listInFlightPrunes(): Promise<readonly InFlightPrune[]> {
    const projection = await this.loadProjection();
    return Object.values(projection.inFlightPrunes);
  }

  /**
   * Run {@link probeWorktrees} over each governed worktree, and emit one event
   * per finding. A dead owner with no live occupant gives `worktree.released`.
   * A dead owner with a live occupant gives `worktree.orphan_detected`.
   *
   * `selfPid` and its parent ancestry do not count as occupants. An entry
   * counts only after its event lands. A failed append skips the entry, and the
   * next probe retries it.
   */
  async probeAndReclaim(selfPid: number = process.pid): Promise<ProbeReclaimResult> {
    const projection = await this.loadProjection();
    const entries = Object.values(projection.worktrees);
    const targets = entries.map((entry) => ({
      worktreePath: entry.path,
      owner:
        entry.state === 'reserved' &&
        entry.ownerPid !== null &&
        entry.ownerStartedAt !== null
          ? { ownerPid: entry.ownerPid, ownerStartedAt: entry.ownerStartedAt }
          : null,
    }));
    const findings = probeWorktrees(
      { targets, selfPid },
      this.processTableSource,
      this.realpath,
    );

    const released: string[] = [];
    const orphaned: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const finding = findings[i];
      if (entry === undefined || finding === undefined) continue;
      try {
        if (finding.releasable) {
          await this.appendLifecycle('worktree.released', entry);
          released.push(entry.worktreeId);
        } else if (finding.ownerLiveness === 'dead' && finding.inUse) {
          await this.appendLifecycle('worktree.orphan_detected', entry);
          orphaned.push(entry.worktreeId);
        }
      } catch {
        continue;
      }
    }
    return { released, orphaned, probed: entries.length };
  }

  /**
   * Append `worktree.released` or `worktree.orphan_detected` for `entry`, with
   * the owner fields cleared. It is a plain keyed append without a concurrency
   * pin, because the probe already proved that the owner is dead.
   */
  private async appendLifecycle(
    type: 'worktree.released' | 'worktree.orphan_detected',
    entry: WorktreeEntry,
  ): Promise<void> {
    const operationId = randomUUID();
    await withStateRetry(() =>
      this.eventStore.append(
        WORKTREES_STREAM,
        {
          type,
          data: {
            worktreeId: entry.worktreeId,
            path: entry.path,
            featureId: entry.featureId,
            ownerPid: null,
            ownerStartedAt: null,
            operationId,
          },
        },
        { idempotencyKey: `${type}:${operationId}` },
      ),
    );
  }

  /**
   * Poll until the serialized merge on `integrationRef` is terminal, up to
   * `timeoutMs`. Each pass folds `worktrees@v1`, then sleeps through the
   * injected {@link SleepFn}. On a timeout, it returns `{ resolved: false }`
   * with the live holder. It appends nothing and starts no background timer.
   */
  async waitForMergeTerminal(
    integrationRef: string,
    opts: {
      readonly timeoutMs?: number;
      readonly sleep?: SleepFn;
      readonly now?: () => number;
      readonly pollIntervalMs?: number;
    } = {},
  ): Promise<WaitForMergeTerminalResult> {
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const start = now();
    const deadline = start + timeoutMs;
    while (true) {
      const projection = await this.loadProjection();
      const holder = projection.inFlightMerges[integrationRef];
      if (holder === undefined) {
        return { resolved: true, waitedMs: now() - start };
      }
      if (now() >= deadline) {
        return { resolved: false, holder, waitedMs: now() - start };
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Poll until no prune pass is in flight, up to `timeoutMs`. Each pass folds
   * `worktrees@v1`, then sleeps through the injected {@link SleepFn}. On a
   * timeout, it returns `{ resolved: false }` with the live holders. It appends
   * nothing and starts no background timer.
   */
  async waitForPruneIdle(
    opts: {
      readonly timeoutMs?: number;
      readonly sleep?: SleepFn;
      readonly now?: () => number;
      readonly pollIntervalMs?: number;
    } = {},
  ): Promise<WaitForPruneIdleResult> {
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const start = now();
    const deadline = start + timeoutMs;
    while (true) {
      const projection = await this.loadProjection();
      const holders = Object.values(projection.inFlightPrunes);
      if (holders.length === 0) {
        return { resolved: true, waitedMs: now() - start };
      }
      if (now() >= deadline) {
        return { resolved: false, holders, waitedMs: now() - start };
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Gather the facts that the pure ladder classifies, for one entry. An owner
   * that is alive or unknown counts as in use, so a probe failure never lets the
   * ladder reclaim it. Backing presence comes first, because {@link isDirty}
   * fails closed only when the backing repo exists.
   */
  private async gatherFacts(
    entry: WorktreeEntry,
    branchCache: Map<string, string | null>,
  ): Promise<PruneCandidate> {
    const inUse = reservationLiveness(entry, this.processSource) !== 'dead';
    const backingGitdirPresent = probeBackingGitdir(entry.path);
    const dirty = this.isDirty(entry.path, backingGitdirPresent);
    const integrationRef = await this.resolveIntegrationRef(
      entry,
      backingGitdirPresent,
      branchCache,
    );
    const headAncestorOfIntegration =
      integrationRef !== null
        ? this.headAncestorOf(entry.path, integrationRef)
        : null;
    const originReachable = this.originReachable(entry.path);
    return {
      state: entry.state,
      inUse,
      dirty,
      integrationRef,
      headAncestorOfIntegration,
      backingGitdirPresent,
      originReachable,
    };
  }

  /**
   * Resolve the integration ref for the merge check: the
   * `synthesis.integrationBranch` of the workflow of the entry. It returns `null`
   * for an unattached worktree, a workflow without a branch, or a branch that
   * does not resolve in a present backing repo. The ladder then fails closed.
   * With no backing repo, the branch passes through unchecked, so the candidate
   * reaches the orphan rung.
   */
  private async resolveIntegrationRef(
    entry: WorktreeEntry,
    backingGitdirPresent: boolean,
    branchCache: Map<string, string | null>,
  ): Promise<string | null> {
    if (entry.featureId === null) return null;
    let branch = branchCache.get(entry.featureId);
    if (branch === undefined) {
      branch = await this.lookupIntegrationBranch(entry.featureId);
      branchCache.set(entry.featureId, branch);
    }
    if (branch === null || branch.length === 0) return null;
    if (!backingGitdirPresent) return branch;
    return this.refResolvable(entry.path, branch) ? branch : null;
  }

  /**
   * Load a workflow's `synthesis.integrationBranch` from the event store (the
   * SQLite source of truth, via {@link resolveWorkflowState}). Returns `null`
   * when the workflow is unknown, errors, or has no integration branch set.
   */
  private async lookupIntegrationBranch(featureId: string): Promise<string | null> {
    const resolved = await resolveWorkflowState({
      featureId,
      eventStore: this.eventStore,
    });
    if ('error' in resolved) return null;
    const synthesis = (
      resolved.state as { synthesis?: { integrationBranch?: unknown } }
    ).synthesis;
    const branch = synthesis?.integrationBranch;
    return typeof branch === 'string' && branch.length > 0 ? branch : null;
  }

  /**
   * Whether `git status --porcelain --untracked-files=all` shows changes.
   *
   * When the probe fails and the backing repo exists, it returns `true`,
   * because cleanliness is not proven. A failure read as clean lets the ladder
   * delete uncommitted work. When the backing repo is gone, it returns `false`,
   * so the candidate reaches the orphan rung.
   */
  private isDirty(worktreePath: string, backingPresent: boolean): boolean {
    const { status, stdout } = this.gitRunner.run(
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath,
    );
    if (status !== 0) {
      return backingPresent;
    }
    return stdout.trim().length > 0;
  }

  /** Whether `ref` resolves to a commit in the worktree (`git rev-parse --verify`). */
  private refResolvable(worktreePath: string, ref: string): boolean {
    return (
      this.gitRunner.run(['rev-parse', '--verify', '--quiet', ref], worktreePath)
        .status === 0
    );
  }

  /**
   * `git merge-base --is-ancestor HEAD <ref>`: `true` on exit 0, `false` on exit
   * 1, and `null` on any other exit, for example an orphan with no backing repo.
   */
  private headAncestorOf(worktreePath: string, ref: string): boolean | null {
    const { status } = this.gitRunner.run(
      ['merge-base', '--is-ancestor', 'HEAD', ref],
      worktreePath,
    );
    if (status === 0) return true;
    if (status === 1) return false;
    return null;
  }

  /** Whether `origin` is reachable from the worktree (`git ls-remote origin`). */
  private originReachable(worktreePath: string): boolean {
    return this.gitRunner.run(['ls-remote', 'origin'], worktreePath).status === 0;
  }

  /** Whether `worktreePath` is still registered in `git worktree list` (canonical compare). */
  private isWorktreeRegistered(repoRoot: string, worktreePath: string): boolean {
    const { status, stdout } = this.gitRunner.run(
      ['worktree', 'list', '--porcelain'],
      repoRoot,
    );
    if (status !== 0) return false;
    const targetId = this.canonicalId(worktreePath);
    return parseWorktreeListPorcelain(stdout).some(
      (wt) => this.canonicalId(wt.path) === targetId,
    );
  }

  /**
   * Delete one eligible worktree through a two-event split. The only mutating
   * git command is `git worktree remove`, never `git reset --hard`.
   *
   * 1. A `decide` folds the current state and runs the full ladder again on
   *    fresh facts. It emits `worktree.remove.requested` only when the entry is
   *    still eligible and no merge lease covers it.
   * 2. Outside the lock, remove the worktree if it is still registered.
   * 3. Append `worktree.remove.executed`, which drops the entry from the projection.
   *
   * Returns `attempted: false` only when the re-verify aborts.
   */
  private async executeDeletion(
    repoRoot: string,
    worktreeId: string,
    worktreePath: string,
    orphansOptedIn: boolean,
    branchCache: Map<string, string | null>,
  ): Promise<{ attempted: boolean; removed: boolean }> {
    const appender = this.eventStore.getAppender();
    const operationId = randomUUID();

    let kind: DecideResult['kind'] = 'no-op';
    await withStateRetry(async () => {
      const result = await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        async (state) => {
          const entry = state.worktrees[worktreeId];
          if (entry === undefined) return [];
          if (entry.state !== 'released' && entry.state !== 'orphan') return [];
          const facts = await this.gatherFacts(entry, branchCache);
          if (mergeLeaseHeld(worktreeId, facts.integrationRef, state.inFlightMerges)) {
            return [];
          }
          const classification = classifyPruneCandidate(facts);
          const stillEligible =
            classification.action === 'delete-eligible' ||
            (classification.action === 'orphan-unverifiable' && orphansOptedIn);
          if (!stillEligible) return [];
          return [
            {
              type: 'worktree.remove.requested',
              data: { operationId, worktreePath, worktreeId },
            },
          ];
        },
        { operationId, alwaysEnforceConsistency: false },
      );
      kind = result.kind;
    });
    if (kind === 'no-op') return { attempted: false, removed: false };

    const removed = await this.removeWorktreeIfRegistered(repoRoot, worktreePath);

    await this.appendRemoveExecuted(operationId, worktreePath, removed, worktreeId);
    return { attempted: true, removed };
  }

  /**
   * Finish each crashed deletion: a `worktree.remove.requested` with no paired
   * `worktree.remove.executed`. It runs the same idempotent remove, then appends
   * the missing terminal under the original `operationId` and `worktreeId`.
   */
  private async recoverOrphanedRemovals(repoRoot: string): Promise<void> {
    const orphaned = await this.listOrphanedRemovals();
    const handled = new Set<string>();
    for (const { operationId, worktreePath, worktreeId } of orphaned) {
      if (handled.has(operationId)) continue;
      handled.add(operationId);
      const removed = await this.removeWorktreeIfRegistered(repoRoot, worktreePath);
      await this.appendRemoveExecuted(
        operationId,
        worktreePath,
        removed,
        worktreeId ?? undefined,
      );
    }
  }

  /**
   * Run `git worktree remove --force` when the worktree is still registered.
   * Returns `true` when this call removed it, and `false` when it is already
   * absent. Throws when the remove fails and the worktree is still registered.
   *
   * Under burst dispatch, two processes can race for `.git/index.lock`.
   * {@link withIndexLockRetry} retries that contention with backoff and jitter.
   * The runner does not throw, so the callback throws a lock-shaped error for
   * the wrapper.
   */
  private async removeWorktreeIfRegistered(
    repoRoot: string,
    worktreePath: string,
  ): Promise<boolean> {
    if (!this.isWorktreeRegistered(repoRoot, worktreePath)) return false;
    const ok = await withIndexLockRetry(
      () => {
        const result = removeWorktreeForce(
          (argv) => this.gitRunner.run(argv, repoRoot),
          worktreePath,
        );
        if (result.status !== 0 && isIndexLockError(result)) {
          throw new Error(
            result.stderr && result.stderr.length > 0
              ? result.stderr
              : result.stdout,
          );
        }
        return result.status === 0;
      },
      {
        sleep: this.sleep,
        jitter: this.jitter,
        maxRetries: this.maxIndexLockRetries,
      },
    );
    if (ok) return true;
    if (this.isWorktreeRegistered(repoRoot, worktreePath)) {
      throw new Error(
        `git worktree remove failed for ${worktreePath} (still registered)`,
      );
    }
    return false;
  }

  /**
   * Append `worktree.remove.executed`, keyed on `operationId`. It stamps the
   * canonical `worktreeId` when known, so the reducer drops the entry by the
   * stored key without a realpath call at fold time. A recovered deletion from
   * an older requested event can lack the id.
   */
  private async appendRemoveExecuted(
    operationId: string,
    worktreePath: string,
    removed: boolean,
    worktreeId?: string,
  ): Promise<void> {
    const data: Record<string, unknown> = { operationId, worktreePath, removed };
    if (worktreeId !== undefined) data.worktreeId = worktreeId;
    await withStateRetry(() =>
      this.eventStore.append(
        WORKTREES_STREAM,
        {
          type: 'worktree.remove.executed',
          data,
        },
        { idempotencyKey: `worktree.remove.executed:${operationId}` },
      ),
    );
  }

  /**
   * The crashed deletions to resume, in stream order: each
   * `worktree.remove.requested` with no `worktree.remove.executed` for its
   * `operationId`. An older requested event can lack `worktreeId`.
   */
  private async listOrphanedRemovals(): Promise<
    Array<{ operationId: string; worktreePath: string; worktreeId: string | null }>
  > {
    const events = await this.eventStore.query(WORKTREES_STREAM);
    const executedOps = new Set<string>();
    for (const event of events) {
      if (event.type !== 'worktree.remove.executed') continue;
      const op = eventStringField(event, 'operationId');
      if (op !== null) executedOps.add(op);
    }
    const orphaned: Array<{
      operationId: string;
      worktreePath: string;
      worktreeId: string | null;
    }> = [];
    for (const event of events) {
      if (event.type !== 'worktree.remove.requested') continue;
      const operationId = eventStringField(event, 'operationId');
      const worktreePath = eventStringField(event, 'worktreePath');
      if (operationId === null || worktreePath === null) continue;
      if (executedOps.has(operationId)) continue;
      const worktreeId = eventStringField(event, 'worktreeId');
      orphaned.push({ operationId, worktreePath, worktreeId });
    }
    return orphaned;
  }

  /** Read-only fold of the `worktrees` stream through `worktrees@v1`. */
  private async loadProjection(): Promise<WorktreesProjection> {
    const { aggregate } = await this.eventStore
      .getAppender()
      .aggregateStream<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
      );
    return aggregate;
  }
}
