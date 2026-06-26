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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { EventStore } from '../../event-store/store.js';
import type { EventInput, DecideResult } from '../../event-store/atomic-appender.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { spawnCommandSync } from '../../utils/process.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from './pure/process-identity.js';
import {
  defaultRealpath,
  type RealpathResolver,
} from './pure/path-containment.js';
import { isReservationOwnerAlive, selectDeadReservations } from './pure/ownership.js';
import {
  classifyPruneCandidate,
  type PruneCandidate,
  type PruneClassification,
  type PruneSkipReason,
} from './pure/prune-ladder.js';
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

// ─── Low-level git runner (prune fact-gathering + deletion, Task 007) ────────

/**
 * Minimal injectable seam over `git`. Every prune git operation (the dirty
 * probe, ref-resolvability, merge-ancestry, origin reachability, the worktree
 * registration check, AND the `git worktree remove` deletion) routes through
 * this one runner. Injected so a test can record the exact argument vectors and
 * assert the recovery/deletion path NEVER shells `git reset --hard` (the data-
 * loss footgun this WLM slice exists to eliminate); the default is the real,
 * portable git spawn ({@link spawnCommandSync}, #1623). Never throws — a git
 * failure surfaces as a non-zero `status`.
 */
export interface GitRunner {
  run(args: readonly string[], cwd: string): { status: number; stdout: string };
}

/** Default real git runner over the portable {@link spawnCommandSync} helper. */
export const defaultGitRunner: GitRunner = {
  run(args: readonly string[], cwd: string): { status: number; stdout: string } {
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

// ─── Prune (GC) types (Task 007, DR-6) ──────────────────────────────────────

/** Arguments for {@link WorktreeManager.prune}. */
export interface PruneOptions {
  /** Repo root the on-disk worktree set is enumerated from (adopt-gate + probe). */
  readonly repoRoot: string;
  /**
   * The explicit non-dry-run flag. Omitted / `false` ⇒ DRY-RUN (the default):
   * report candidates + reclaimable bytes + grouped skip reasons, delete
   * NOTHING and run no crash-recovery side-effects. `true` ⇒ delete every
   * delete-eligible candidate (and, gated, opted-in orphans).
   */
  readonly apply?: boolean;
  /**
   * Opt in to deleting `orphan-unverifiable` candidates (backing repo gone, so
   * content is unverifiable). Effective ONLY together with {@link yes} on an
   * `apply` run — `--prune-orphans --yes`.
   */
  readonly pruneOrphans?: boolean;
  /** Explicit confirmation required alongside {@link pruneOrphans} for orphans. */
  readonly yes?: boolean;
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
  /** True when THIS pass actually deleted the worktree (always false on dry-run). */
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
  /** Total reclaimable bytes across delete-eligible (+opted-in orphan) candidates. */
  readonly reclaimableBytes: number;
  /** Skip {@link PruneSkipReason} → the `worktreeId`s skipped for it (scannable). */
  readonly skipsByReason: Readonly<Partial<Record<PruneSkipReason, readonly string[]>>>;
}

/**
 * Whether the worktree's backing `.git` gitdir pointer resolves (orphan probe).
 *
 *   - `.git` is a directory   → an embedded / main repo: backing present.
 *   - `.git` is a file        → a linked worktree pointer (`gitdir: <path>`):
 *                               present iff the pointed-to admin dir stats.
 *   - `.git` missing / other  → backing gone (orphan).
 *
 * Pure filesystem stat; never throws.
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
  if (!match) return false;
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

/** Best-effort recursive byte size of `dir` (0 on any error; symlinks skipped). */
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
      // Unreadable entry — skip; reclaimable bytes is best-effort.
    }
  }
  return total;
}

/** Read a string field off an event payload (`null` when absent / non-string). */
function eventStringField(event: WorkflowEvent, key: string): string | null {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : null;
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
  /**
   * Low-level git runner used by `prune` for every git probe + the deletion.
   * Injected so a test can record argument vectors (e.g. assert the recovery
   * path never `git reset --hard`s); defaults to {@link defaultGitRunner}.
   */
  readonly gitRunner?: GitRunner;
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
  private readonly gitRunner: GitRunner;

  constructor(deps: WorktreeManagerDeps) {
    this.eventStore = deps.eventStore;
    this.processSource = deps.processSource ?? defaultProcessSource;
    this.gitProbe = deps.gitProbe ?? defaultGitWorktreeProbe;
    this.featureIdResolver = deps.featureIdResolver ?? unattachedFeatureIdResolver;
    this.realpath = deps.realpath ?? defaultRealpath;
    this.gitRunner = deps.gitRunner ?? defaultGitRunner;
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
   * Prune (GC) governed worktrees through the fail-closed safety ladder (DR-6).
   *
   * The flow that closes the Claude Code #55724 data-loss hole (parallel agents
   * losing uncommitted work to a naive recency GC):
   *
   *   0. **Adopt-gate** — `adopt(repoRoot)` FIRST, so every on-disk worktree has
   *      a `worktrees@v1` state before the ladder runs. An unadopted active
   *      worktree therefore enters the ladder as `adopted` (skipped), never as
   *      "no record" that a careless GC might reclaim.
   *   1. **Crash-recovery (apply only)** — finish any `worktree.remove.requested`
   *      with no paired `worktree.remove.executed` (a crash mid-deletion) via the
   *      idempotent precheck, reusing the original `operationId` so the audit
   *      pair stays 1:1 and the entry is dropped exactly once.
   *   2. **Classify** every candidate by GATHERING injected facts (state,
   *      ownership liveness, untracked-aware dirty, per-worktree integration ref,
   *      merge ancestry, backing-gitdir presence, origin reachability) and
   *      calling the pure {@link classifyPruneCandidate}. Eligibility is
   *      STATE-BASED (`released` / `orphan` only) — never mtime.
   *   3. **Report or delete.** Dry-run (the DEFAULT) reports candidates +
   *      reclaimable bytes + grouped skip reasons and deletes nothing. An `apply`
   *      run deletes each delete-eligible candidate (and, only under
   *      `pruneOrphans && yes`, each orphan) through the INV-13 two-event split:
   *      `worktree.remove.requested` (durable intent, re-verifying eligibility
   *      UNDER the stream lock) → `git worktree remove` → `worktree.remove.executed`.
   *      It NEVER `git reset --hard`s.
   */
  async prune(options: PruneOptions): Promise<PruneResult> {
    const { repoRoot } = options;
    const apply = options.apply === true;
    const orphansOptedIn = options.pruneOrphans === true && options.yes === true;

    // ── Step 0: adopt-gate — track every on-disk worktree before classifying. ──
    await this.adopt(repoRoot);

    // ── Step 1 (apply only): finish crashed deletions before re-classifying. ──
    // Recovery emits events (a side effect), so a DRY-RUN stays side-effect-free.
    if (apply) {
      await this.recoverOrphanedRemovals(repoRoot);
    }

    // ── Step 2: classify every candidate over the pure ladder. ────────────────
    // Reload AFTER recovery so any resumed-and-dropped entry is gone.
    const projection = await this.loadProjection();
    const candidates = Object.values(projection.worktrees);
    // Per-feature integration-branch lookups are stable within one pass — cache.
    const branchCache = new Map<string, string | null>();

    const reports: PruneCandidateReport[] = [];
    for (const entry of candidates) {
      const facts = await this.gatherFacts(entry, branchCache);
      const classification = classifyPruneCandidate(facts);
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

    // ── Step 3: delete (apply only) — two-event split per eligible candidate. ──
    const deleted: string[] = [];
    if (apply) {
      for (let i = 0; i < reports.length; i += 1) {
        const report = reports[i];
        const eligible =
          report.classification.action === 'delete-eligible' ||
          (report.classification.action === 'orphan-unverifiable' && orphansOptedIn);
        if (!eligible) continue;
        const { attempted } = await this.executeDeletion(
          repoRoot,
          report.worktreeId,
          report.path,
        );
        if (attempted) {
          reports[i] = { ...report, deleted: true };
          deleted.push(report.worktreeId);
        }
      }
    }

    // Group skips by reason so the report is scannable (the dry-run contract).
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
   * Read-only listing of the governed worktree set: fold the `worktrees`
   * stream through `worktrees@v1` and return every live {@link WorktreeEntry}.
   *
   * Pure read — appends nothing and runs no git/process probe — so it backs
   * the `worktrees` view action with zero side effects. The order mirrors the
   * projection's insertion order (`Object.values`), which is stable for a given
   * stream so two reads of the same log return the same sequence.
   */
  async list(): Promise<readonly WorktreeEntry[]> {
    const projection = await this.loadProjection();
    return Object.values(projection.worktrees);
  }

  /**
   * Gather the injected facts the pure ladder classifies over, for one entry.
   * Every fact is read here (state, ownership liveness, dirty, integration ref,
   * merge ancestry, backing gitdir, origin) — the ladder computes none of them.
   */
  private async gatherFacts(
    entry: WorktreeEntry,
    branchCache: Map<string, string | null>,
  ): Promise<PruneCandidate> {
    const inUse = isReservationOwnerAlive(entry, this.processSource);
    const dirty = this.isDirty(entry.path);
    const backingGitdirPresent = probeBackingGitdir(entry.path);
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
   * Resolve the integration ref this candidate's HEAD is merge-checked against,
   * PER-WORKTREE: the entry's `featureId` → that workflow's
   * `synthesis.integrationBranch`. Returns `null` (the ladder fail-closes) when:
   *
   *   - the worktree is unattached (`featureId` is `null`); OR
   *   - the workflow has no resolvable `synthesis.integrationBranch`; OR
   *   - the backing repo is present but the branch does NOT resolve as a ref in
   *     the worktree — merge state is then unverifiable, so we fail closed
   *     (rung 5) rather than letting an uncomputable merge-base reach the
   *     delete-eligible rung.
   *
   * When the backing repo is GONE (orphan) the branch name is passed through
   * unchecked: merge-base cannot run, so {@link headAncestorOf} returns `null`,
   * and the candidate threads to the orphan rung (handler-gated deletion) rather
   * than fail-closing at rung 5.
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

  // ─── Real-git fact probes (over the injected GitRunner) ─────────────────────

  /** `git status --porcelain --untracked-files=all` non-empty ⇒ dirty (untracked-aware). */
  private isDirty(worktreePath: string): boolean {
    const { status, stdout } = this.gitRunner.run(
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath,
    );
    if (status !== 0) return false; // cannot prove dirty (e.g. broken backing)
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
   * `git merge-base --is-ancestor HEAD <ref>`: `true` (HEAD merged, exit 0),
   * `false` (unmerged, exit 1), or `null` when the probe could not run (any
   * other exit — e.g. an orphan with no backing repo).
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
    const targetId = this.realpath(path.resolve(worktreePath));
    return parseWorktreeListPorcelain(stdout).some(
      (wt) => this.realpath(path.resolve(wt.path)) === targetId,
    );
  }

  // ─── Two-event deletion (INV-13) ────────────────────────────────────────────

  /**
   * Delete one eligible worktree through the INV-13 two-event split. NEVER
   * `git reset --hard`s; the only mutating git command is `git worktree remove`.
   *
   *   - **Plan / reserve / re-verify UNDER the stream lock → commit intent.** A
   *     `decide` over `worktrees@v1` re-folds the CURRENT state and emits
   *     `worktree.remove.requested` ONLY while the entry is still present and in
   *     a deletion-eligible state (`released` / `orphan`). A concurrent reconcile
   *     / prune that flipped the state out from under us re-folds to a no-op, so
   *     we never double-free or delete a re-reserved worktree.
   *   - **Idempotent side-effect OUTSIDE the lock.** Run `git worktree remove`
   *     only when the worktree is still registered; an already-absent worktree
   *     downgrades to `removed: false` (idempotent success), and a remove that
   *     fails while the worktree is STILL registered surfaces as a real error.
   *   - **Commit outcome.** Emit `worktree.remove.executed` (idempotency keyed on
   *     `operationId`) — the `worktrees@v1` reducer drops the entry on it.
   *
   * Returns `attempted: false` only when the under-lock re-verify aborts (the
   * candidate was no longer eligible at commit time).
   */
  private async executeDeletion(
    repoRoot: string,
    worktreeId: string,
    worktreePath: string,
  ): Promise<{ attempted: boolean; removed: boolean }> {
    const appender = this.eventStore.getAppender();
    const operationId = randomUUID();

    // ── Phase A: durable intent, re-verifying eligibility under the lock. ──
    let kind: DecideResult['kind'] = 'no-op';
    await withStateRetry(async () => {
      const result = await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        (state) => {
          const entry = state.worktrees[worktreeId];
          // Gone (already removed) OR no longer deletion-eligible by state
          // (re-reserved / re-adopted under us) ⇒ abort: emit nothing.
          if (entry === undefined) return [];
          if (entry.state !== 'released' && entry.state !== 'orphan') return [];
          return [
            {
              type: 'worktree.remove.requested',
              data: { operationId, worktreePath },
            },
          ];
        },
        // alwaysEnforceConsistency=false: an abort (no-op) must not throw a
        // spurious ConcurrencyError when an unrelated append raced the stream;
        // the emit path still commits under expectedSequence OCC.
        { operationId, alwaysEnforceConsistency: false },
      );
      kind = result.kind;
    });
    if (kind === 'no-op') return { attempted: false, removed: false };

    // ── Phase B: idempotent side-effect OUTSIDE the lock. ──
    const removed = this.removeWorktreeIfRegistered(repoRoot, worktreePath);

    // ── Phase C: record the outcome (drops the entry on the reducer). ──
    await this.appendRemoveExecuted(operationId, worktreePath, removed);
    return { attempted: true, removed };
  }

  /**
   * Finish any crashed deletion: a `worktree.remove.requested` on the worktrees
   * stream with no paired `worktree.remove.executed`. For each, run the same
   * idempotent precheck + `git worktree remove` and emit the missing
   * `worktree.remove.executed` REUSING the original `operationId`, so the audit
   * pair stays 1:1 and the entry is dropped exactly once across the crash.
   */
  private async recoverOrphanedRemovals(repoRoot: string): Promise<void> {
    const orphaned = await this.listOrphanedRemovals();
    const handled = new Set<string>();
    for (const { operationId, worktreePath } of orphaned) {
      if (handled.has(operationId)) continue; // one executed per operationId
      handled.add(operationId);
      const removed = this.removeWorktreeIfRegistered(repoRoot, worktreePath);
      await this.appendRemoveExecuted(operationId, worktreePath, removed);
    }
  }

  /**
   * `git worktree remove --force` when still registered; idempotent otherwise.
   * Returns whether THIS call removed it (`false` = already absent, an
   * idempotent success). Throws only when the remove fails AND the worktree is
   * still registered (a real failure that must not be masked as success).
   */
  private removeWorktreeIfRegistered(
    repoRoot: string,
    worktreePath: string,
  ): boolean {
    if (!this.isWorktreeRegistered(repoRoot, worktreePath)) return false;
    const ok =
      this.gitRunner.run(
        ['worktree', 'remove', '--force', worktreePath],
        repoRoot,
      ).status === 0;
    if (ok) return true;
    if (this.isWorktreeRegistered(repoRoot, worktreePath)) {
      throw new Error(
        `git worktree remove failed for ${worktreePath} (still registered)`,
      );
    }
    return false; // raced absent between precheck and remove — idempotent miss.
  }

  /** Append `worktree.remove.executed` (idempotency keyed on `operationId`). */
  private async appendRemoveExecuted(
    operationId: string,
    worktreePath: string,
    removed: boolean,
  ): Promise<void> {
    await withStateRetry(() =>
      this.eventStore.append(
        WORKTREES_STREAM,
        {
          type: 'worktree.remove.executed',
          data: { operationId, worktreePath, removed },
        },
        { idempotencyKey: `worktree.remove.executed:${operationId}` },
      ),
    );
  }

  /**
   * Scan the worktrees stream for `worktree.remove.requested` events with no
   * paired `worktree.remove.executed` (operationId-correlated) — the crashed
   * deletions to resume, in stream order.
   */
  private async listOrphanedRemovals(): Promise<
    Array<{ operationId: string; worktreePath: string }>
  > {
    const events = await this.eventStore.query(WORKTREES_STREAM);
    const executedOps = new Set<string>();
    for (const event of events) {
      if (event.type !== 'worktree.remove.executed') continue;
      const op = eventStringField(event, 'operationId');
      if (op !== null) executedOps.add(op);
    }
    const orphaned: Array<{ operationId: string; worktreePath: string }> = [];
    for (const event of events) {
      if (event.type !== 'worktree.remove.requested') continue;
      const operationId = eventStringField(event, 'operationId');
      const worktreePath = eventStringField(event, 'worktreePath');
      if (operationId === null || worktreePath === null) continue;
      if (executedOps.has(operationId)) continue;
      orphaned.push({ operationId, worktreePath });
    }
    return orphaned;
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
