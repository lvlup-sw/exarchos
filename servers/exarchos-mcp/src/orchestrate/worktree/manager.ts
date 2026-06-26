/**
 * In-process worktree-lifecycle facade (DR-3).
 *
 * `WorktreeManager` is the single in-process entry point that turns worktree
 * ownership *intentions* (reserve / release / reconcile) into events on the
 * dedicated singleton `worktrees` stream. It owns NO state of its own: ownership
 * lives exclusively in the event log (INV-1 / INV-7) — there is no advisory lock
 * file and no JSON ownership side file. The live set is always re-derivable by
 * folding the stream through the `worktrees@v1` projection.
 *
 * ## Entry points
 *
 *   - {@link WorktreeManager.reserve}   — claim a worktree for a live process
 *                                         (`worktree.reserved`).
 *   - {@link WorktreeManager.release}   — relinquish a claim (`worktree.released`).
 *   - {@link WorktreeManager.reconcile} — the heal fold: release every
 *                                         reservation whose owning process has
 *                                         died, exactly once.
 *   - {@link WorktreeManager.adopt}     — track every on-disk worktree the
 *                                         manager did NOT create (`worktree.adopted`),
 *                                         enumerated from the real
 *                                         `git worktree list --porcelain` probe and
 *                                         re-verified for stale-after-push before
 *                                         reporting it mutable (Task 005, DR-2).
 *
 * `prune` (Task 007) is deliberately NOT here yet — it appends to this same
 * facade later. The module is structured so it drops in beside these methods
 * without churn; this slice does NOT touch `setup-worktree.ts` /
 * `worktree-baseref.ts` / `dispatch-guard.ts`.
 *
 * ## Adoption (DR-2) — harness-neutral, no pool
 *
 * `adopt` keys off the `worktree.*` event stream ⊕ the `git worktree list
 * --porcelain` ground-truth probe — never a harness-specific creation callback
 * (INV-4/6). It works identically for a Claude Code `.claude/worktrees/agent-*`,
 * a Codex/Cursor worktree, or a hand-made `git worktree add`. A worktree the
 * manager did not create is folded into the log as `worktree.adopted`; a
 * `worktree.released` worktree is GC-eligible and is NEVER recycled into a warm
 * pool. `featureId` derivation is delegated to an injected
 * {@link FeatureIdResolver} (default: unattached → `null`) so the manager carries
 * no harness knowledge.
 *
 * ## Serialization & idempotency
 *
 * Every write goes through the shared {@link EventStore} / `AtomicAppender`, so
 * appends to the `worktrees` stream are serialized by the appender's
 * per-stream `StreamLockManager` — the manager opens NO second DB path.
 *
 *   - reserve / release append a single event keyed by the two-component
 *     `<eventType>:<operationId>` idempotency convention (matching
 *     `workflow/compensation.ts`), so a transient retry is a cache-hit, never a
 *     duplicate.
 *   - reconcile is a load → fold → decide → append over the `worktrees@v1`
 *     reducer via the `decide` primitive under `withStateRetry`: a concurrent
 *     reconcile that loses the optimistic-concurrency race re-folds against the
 *     now-`released` state and emits nothing, so two racing reconciles produce
 *     at most one `worktree.released` per dead reservation. Repeated reconcile is
 *     idempotent because a released entry is no longer `reserved` and is never
 *     re-selected.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { EventStore } from '../../event-store/store.js';
import type { EventInput } from '../../event-store/atomic-appender.js';
import { spawnCommandSync } from '../../utils/process.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from './pure/process-identity.js';
import {
  defaultRealpath,
  type RealpathResolver,
} from './pure/path-containment.js';
import { selectDeadReservations } from './pure/ownership.js';
import type {
  WorktreeEntry,
  WorktreesProjection,
} from './projections/worktrees.js';
// Side-effect import: registers the `worktrees@v1` reducer with the
// process-wide `defaultRegistry` so the appender's `aggregateStream` / `decide`
// primitives can resolve the fold by id (DR-1 self-registration). ES modules
// are specifier-cached, so this registers exactly once per process.
import './projections/index.js';

/** The dedicated singleton stream that carries the worktree-lifecycle family. */
export const WORKTREES_STREAM = 'worktrees';

/** Reducer id used to fold {@link WORKTREES_STREAM} into the live worktree set. */
export const WORKTREES_REDUCER = 'worktrees@v1';

// ─── Real git ground-truth probe (Task 005 owns it) ─────────────────────────

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
 * Verdict of the stale-after-push HEAD/ancestry re-verify for one worktree.
 *
 * `mutable` is `false` only when the worktree is **behind** its upstream — the
 * tracking ref holds commits the local HEAD lacks, so mutating (committing) in
 * the worktree could silently drop newly-pushed files (the "stale worktree after
 * external push" data-loss hazard). With no upstream there is nothing to diverge
 * from, so the worktree is reported mutable.
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
 * Read-only ground-truth probe over real git. Injected into the manager so the
 * adoption fold is testable, but the default is the REAL
 * `git worktree list --porcelain` enumeration + HEAD re-verify this task owns.
 */
export interface GitWorktreeProbe {
  /** Enumerate on-disk worktrees of `repoRoot` (empty on any git failure). */
  listWorktrees(repoRoot: string): OnDiskWorktree[];
  /** Re-verify a worktree's HEAD/ancestry against its upstream (freshly read). */
  verifyHead(worktreePath: string): HeadVerification;
}

/**
 * Derives the owning-workflow `featureId` for an on-disk worktree, or `null`
 * when it is hand-made / unattached. Injected so the manager carries NO
 * harness-specific knowledge (INV-4/6); the default treats every adopted
 * worktree as unattached.
 */
export type FeatureIdResolver = (worktree: OnDiskWorktree) => string | null;

/** Default resolver: no harness assumption — every worktree is unattached. */
export const unattachedFeatureIdResolver: FeatureIdResolver = () => null;

/**
 * Parse `git worktree list --porcelain` into {@link OnDiskWorktree} records.
 *
 * Records are blank-line separated; each starts with a `worktree <path>` line
 * followed by attribute lines (`HEAD <sha>`, `branch refs/heads/<name>`,
 * `detached`, `bare`, plus `locked`/`prunable` which are ignored). Pure and
 * CRLF-tolerant so it is table-testable without shelling git.
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
 * Run `git <args>` from `cwd` via the portable spawn helper (Windows-safe —
 * `git` is a real binary so {@link spawnCommandSync} is a thin pass-through; we
 * deliberately avoid `execFileSync` of a resolved `.cmd` shim, #1623). Never
 * throws — a git failure surfaces as a non-zero `status`.
 */
function gitCapture(
  args: readonly string[],
  cwd: string,
): { status: number; stdout: string } {
  const result = spawnCommandSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
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
 * The default real-git probe: `git worktree list --porcelain` enumeration plus a
 * HEAD/upstream re-verify. The HEAD is re-read **freshly** (not from the
 * porcelain snapshot) at verify time so the stale-after-push verdict reflects
 * ground truth right before mutation.
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
      // No tracking ref → nothing externally pushed we can observe → mutable.
      return { head, upstream: null, mutable: true, reason: 'no-upstream' };
    }
    if (upstream === head) {
      return { head, upstream, mutable: true, reason: 'up-to-date' };
    }
    // Safe only when the upstream tip is already contained in HEAD (HEAD is at
    // or ahead of upstream). Otherwise upstream holds commits HEAD lacks → the
    // worktree is stale-after-push and must be re-synced before mutation.
    const upstreamContained =
      gitCapture(['merge-base', '--is-ancestor', upstream, 'HEAD'], worktreePath)
        .status === 0;
    return upstreamContained
      ? { head, upstream, mutable: true, reason: 'up-to-date' }
      : { head, upstream, mutable: false, reason: 'stale-after-push' };
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

/** Constructor dependencies for {@link WorktreeManager}. */
export interface WorktreeManagerDeps {
  /** The shared event store — the manager's ONLY persistence path. */
  readonly eventStore: EventStore;
  /**
   * Process-table source used by the heal fold to probe owner liveness.
   * Injected so `reconcile` is testable with a platform-shimmed source;
   * defaults to the real OS source ({@link defaultProcessSource}).
   */
  readonly processSource?: ProcessSource;
  /**
   * Real-git ground-truth probe used by `adopt`. Injected for tests; defaults
   * to the real `git worktree list --porcelain` enumeration + HEAD re-verify
   * ({@link defaultGitWorktreeProbe}).
   */
  readonly gitProbe?: GitWorktreeProbe;
  /**
   * Derives the owning `featureId` for an adopted worktree. Injected so the
   * manager holds no harness knowledge; defaults to
   * {@link unattachedFeatureIdResolver} (every adopted worktree is unattached).
   */
  readonly featureIdResolver?: FeatureIdResolver;
  /**
   * Symlink-resolving canonicalizer used to derive `worktreeId` from a worktree
   * path. Injected for determinism in tests; defaults to {@link defaultRealpath}
   * (the same resolver the `worktrees@v1` reducer canonicalizes remove events
   * through, so adopt and the reducer agree on the key).
   */
  readonly realpath?: RealpathResolver;
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
  /** Reserving process's create-time fingerprint (opaque, compared for equality). */
  readonly ownerStartedAt: string;
}

/** Outcome of a {@link WorktreeManager.reconcile} pass. */
export interface ReconcileResult {
  /**
   * The `worktreeId`s released by this pass (provably-dead reservations
   * healed). Empty when nothing needed healing — including the loser of a
   * concurrent reconcile, which re-folds to a no-op.
   */
  readonly released: readonly string[];
}

/**
 * The in-process worktree-lifecycle facade. Construct one per
 * {@link EventStore}; it is cheap and holds no mutable state.
 */
export class WorktreeManager {
  private readonly eventStore: EventStore;
  private readonly processSource: ProcessSource;
  private readonly gitProbe: GitWorktreeProbe;
  private readonly featureIdResolver: FeatureIdResolver;
  private readonly realpath: RealpathResolver;

  constructor(deps: WorktreeManagerDeps) {
    this.eventStore = deps.eventStore;
    this.processSource = deps.processSource ?? defaultProcessSource;
    this.gitProbe = deps.gitProbe ?? defaultGitWorktreeProbe;
    this.featureIdResolver = deps.featureIdResolver ?? unattachedFeatureIdResolver;
    this.realpath = deps.realpath ?? defaultRealpath;
  }

  /**
   * Reserve a worktree for a live process: append `worktree.reserved` to the
   * `worktrees` stream. The `operationId` is minted per call (outside any retry)
   * so the two-component idempotency key `worktree.reserved:<operationId>` makes
   * a transient retry a cache-hit rather than a duplicate reservation.
   */
  async reserve(input: ReserveInput): Promise<void> {
    const operationId = randomUUID();
    await this.eventStore.append(
      WORKTREES_STREAM,
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
      { idempotencyKey: `worktree.reserved:${operationId}` },
    );
  }

  /**
   * Release a worktree: append `worktree.released` to the `worktrees` stream.
   *
   * The current entry is folded up first so the released event carries the
   * worktree's `path` / `featureId` provenance (owner fields are cleared, per
   * the reducer's contract). An unknown `worktreeId` still emits a well-formed
   * released event (path defaults to the id, featureId to `null`).
   */
  async release(worktreeId: string): Promise<void> {
    const entry = await this.lookupEntry(worktreeId);
    const operationId = randomUUID();
    await this.eventStore.append(
      WORKTREES_STREAM,
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
      { idempotencyKey: `worktree.released:${operationId}` },
    );
  }

  /**
   * The heal fold. Load `worktrees@v1`, select every `reserved` entry whose
   * owner is provably dead (PID absent OR create-time mismatch), and append
   * exactly one `worktree.released` per such entry.
   *
   * Implemented over the `decide` primitive under `withStateRetry`:
   *   - The fold runs against a fresh read of the stream; the pure
   *     {@link selectDeadReservations} decides which reservations are dead.
   *   - Optimistic-concurrency control on the append means a racing reconcile
   *     that loses re-folds against the now-`released` state and emits nothing —
   *     so two concurrent reconciles release a given dead worktree at most once.
   *   - A live owner is never selected; repeated reconcile is a no-op once an
   *     entry is `released` (it is no longer `reserved`).
   */
  async reconcile(): Promise<ReconcileResult> {
    const appender = this.eventStore.getAppender();
    // Captured from the *winning* decide attempt (the one that actually
    // commits). Reset on each attempt so a retried no-op reports nothing.
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
              // Provenance only — `decide` dedupes the whole batch under its
              // own per-call key; this records which heal minted the event.
              operationId: randomUUID(),
            },
          }));
        },
        // alwaysEnforceConsistency=false: a pass with nothing to heal returns
        // zero events on purpose. With the default-on empty-write tail re-read,
        // an unrelated concurrent append to `worktrees` would throw a spurious
        // ConcurrencyError on a no-op heal. The event-emitting path is
        // unaffected — it still commits under optimistic concurrency control.
        { operationId, alwaysEnforceConsistency: false },
      );
    });
    return { released };
  }

  /**
   * Adopt every on-disk worktree the manager did NOT create (DR-2).
   *
   * Enumerates `repoRoot`'s worktrees via the REAL `git worktree list
   * --porcelain` probe ⊕ the `worktrees@v1` fold: every on-disk worktree with no
   * tracking entry is folded into the log as `worktree.adopted` (state
   * `adopted`, owner fields cleared). Adoption is **harness-neutral** — it keys
   * off the event stream + git ground truth, never a creation callback — so it
   * works for a Claude Code `.claude/worktrees/agent-*`, a Codex/Cursor
   * worktree, or a hand-made `git worktree add`. The manager creates nothing.
   *
   * `featureId` comes from the injected {@link FeatureIdResolver} (default:
   * `null` / unattached). A worktree already tracked (including a
   * `worktree.released` one, which is GC-eligible — never recycled into a warm
   * pool) is left untouched: no new event, no state flip.
   *
   * **Stale-after-push re-verify (DR-12s).** Before reporting any worktree
   * mutable, each is re-verified via {@link GitWorktreeProbe.verifyHead} — a
   * fresh HEAD/upstream-ancestry read — so a worktree reused after an external
   * push (HEAD behind the pushed tip) is reported `mutable: false` and a caller
   * cannot silently drop newly-pushed files by committing into it.
   *
   * Implemented over the same `decide` + `withStateRetry` event-store path as
   * `reconcile` (no second DB path): the fold runs against a fresh read of the
   * stream and emits one `worktree.adopted` per untracked worktree under
   * optimistic concurrency control, so a concurrent adopt that loses re-folds
   * against the now-tracked state and emits nothing (idempotent).
   */
  async adopt(repoRoot: string): Promise<AdoptResult> {
    // Read-only ground truth up front (identity + featureId + stale verdict),
    // BEFORE the fold/append. `git worktree list --porcelain` emits canonical
    // paths, but we canonicalize again so `worktreeId` matches the reducer's key.
    const onDisk = this.gitProbe.listWorktrees(repoRoot);
    const probed = onDisk.map((wt) => ({
      worktreeId: this.realpath(path.resolve(wt.path)),
      path: wt.path,
      featureId: this.featureIdResolver(wt),
      verification: this.gitProbe.verifyHead(wt.path),
    }));

    const appender = this.eventStore.getAppender();
    // Captured from the winning decide attempt; reset per attempt so a retried
    // no-op (everything already tracked) reports nothing.
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
            // Already tracked (adopted / reserved / released / orphan) → adoption
            // is idempotent; a released entry is NOT recycled back into a pool.
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
        // alwaysEnforceConsistency=false: an adopt pass with nothing new to
        // track returns zero events on purpose, so an unrelated concurrent
        // append to `worktrees` must not throw a spurious ConcurrencyError.
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
   * Fold the `worktrees` stream and return the entry for `worktreeId`, or
   * `undefined` when no live entry is keyed under it. Read-only.
   */
  private async lookupEntry(
    worktreeId: string,
  ): Promise<WorktreeEntry | undefined> {
    const projection = await this.loadProjection();
    return projection.worktrees[worktreeId];
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
