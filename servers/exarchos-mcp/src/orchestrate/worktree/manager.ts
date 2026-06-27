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
  canonicalWorktreeId,
  defaultRealpath,
  type RealpathResolver,
} from './pure/path-containment.js';
import {
  probeWorktrees,
  defaultProcessTableSource,
  type ProcessTableSource,
} from './pure/probe.js';
import { defaultSleep, type SleepFn } from './git-retry.js';
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

/** Default bounded-wait budget (ms) for {@link WorktreeManager.waitForMergeTerminal}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** Default poll interval (ms) between bounded-wait re-folds. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 200;

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

/**
 * Whether a prune candidate is covered by an unpaired in-flight merge lease
 * (DR-12, no double-free). Pure over a folded `inFlightMerges` map so it is
 * shared by both the classification pass (over the planning fold) AND the
 * under-lock re-verification inside `executeDeletion` (over the fold INSIDE the
 * `decide` closure — "re-verified under its claim").
 *
 * A lease covers the candidate when EITHER:
 *   - the lease is attributed to this exact worktree (`merge.worktreeId === worktreeId`); or
 *   - the lease targets the candidate's resolved integration ref
 *     (`merge.integrationRef === integrationRef`) — the serializer leaves
 *     `worktreeId` null, so the integration-ref match is what catches a
 *     `serialize_merge` racing the GC for the same branch.
 *
 * Both arms are conservative (fail-closed): a held lease keeps the worktree, so
 * the GC never deletes a worktree whose branch a live merge is mid-applying.
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
  /**
   * Ground-truth process-table source used by the on-demand orphan probe
   * ({@link WorktreeManager.probeAndReclaim}, DR-5). Injected so the probe is
   * testable with a fake table and zero OS access; defaults to the real
   * {@link defaultProcessTableSource} (`/proc` on Linux, empty/fail-closed
   * elsewhere). NOTE: distinct from {@link processSource} — that is the per-PID
   * create-time probe for reservation liveness; this enumerates the FULL table
   * for cwd-occupancy + protected-ancestry subtraction.
   */
  readonly processTableSource?: ProcessTableSource;
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

/** The live-process identity of a reservation owner (PID + create-time). */
export interface ReservationOwner {
  /** PID of the owning process. */
  readonly ownerPid: number;
  /** The owning process's opaque create-time fingerprint (equality-compared). */
  readonly ownerStartedAt: string;
}

/** Outcome of a {@link WorktreeManager.reserve} call. */
export interface ReserveResult {
  /**
   * True when this call holds the reservation afterwards — it either claimed a
   * free/dead/own worktree or re-affirmed an existing same-owner reservation.
   * `false` ⇒ the worktree is already `reserved` by a DIFFERENT live owner and
   * the claim was rejected (exclusive ownership upheld).
   */
  readonly reserved: boolean;
  /**
   * The live owner already holding the worktree, present ONLY when
   * `reserved === false`. Lets the caller report who blocked the claim.
   */
  readonly conflict?: ReservationOwner;
}

/** Outcome of a {@link WorktreeManager.release} call. */
export interface ReleaseResult {
  /** True when this call appended a `worktree.released` (the claim is now free). */
  readonly released: boolean;
  /**
   * True when the release was REJECTED because the worktree is currently
   * `reserved` by a different live owner — a stale/foreign caller must never
   * release another live process's reservation. `released` is then `false`.
   */
  readonly rejectedForeignOwner: boolean;
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

/** Outcome of a {@link WorktreeManager.probeAndReclaim} pass (DR-5 + orphan emitter). */
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
  private readonly processTableSource: ProcessTableSource;

  constructor(deps: WorktreeManagerDeps) {
    this.eventStore = deps.eventStore;
    this.processSource = deps.processSource ?? defaultProcessSource;
    this.gitProbe = deps.gitProbe ?? defaultGitWorktreeProbe;
    this.featureIdResolver = deps.featureIdResolver ?? unattachedFeatureIdResolver;
    this.realpath = deps.realpath ?? defaultRealpath;
    this.gitRunner = deps.gitRunner ?? defaultGitRunner;
    this.processTableSource = deps.processTableSource ?? defaultProcessTableSource;
  }

  /**
   * Canonical, separator-stable `worktreeId` for an on-disk worktree path — the
   * SINGLE keying derivation shared by adopt, the registry re-check, and (via
   * the same {@link canonicalWorktreeId} helper) the `worktrees@v1` reducer's
   * remove-event correlation. Routes the manager's injected {@link realpath} so
   * adopt and the reducer agree on the key, and applies {@link toPosix} AFTER
   * realpath+resolve so `git worktree list --porcelain`'s forward-slash output
   * and Node's native backslashes fold to one key on Windows (#1620). No-op on
   * POSIX.
   */
  private canonicalId(p: string): string {
    return canonicalWorktreeId(p, this.realpath);
  }

  /**
   * Reserve a worktree for a live process, UPHOLDING exclusive ownership.
   *
   * Routed through `decide` over `worktrees@v1` (like reconcile / adopt) so the
   * reservation is a load → fold → validate → append under optimistic concurrency
   * control — NOT a blind append. Folding first closes the double-reserve race:
   * if the worktree is already `reserved` by a DIFFERENT owner whose liveness is
   * not provably `dead` (i.e. `alive` OR an unprovable `unknown`), the claim is
   * REJECTED (emits nothing) and {@link ReserveResult.reserved} is `false`. Two
   * concurrent reserves therefore resolve to exactly one winner: the loser's
   * commit fails OCC, re-folds against the now-reserved state, and rejects.
   *
   * A free / `adopted` / `released` / `orphan` worktree, a worktree whose owner
   * is provably `dead`, or a same-owner re-affirmation all proceed and emit
   * `worktree.reserved`. The `operationId` is minted per attempt and drives the
   * decide idempotency key (`worktrees:worktrees@v1:<operationId>`).
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
            conflict = liveOwner; // already held by a different live owner → reject.
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
        // alwaysEnforceConsistency=false: a rejected claim returns zero events
        // and must not throw on an unrelated concurrent append; the emit path
        // still commits under expectedSequence OCC (the double-reserve guard).
        { operationId, alwaysEnforceConsistency: false },
      );
      reserved = result.kind !== 'no-op';
    });
    return conflict !== undefined ? { reserved: false, conflict } : { reserved };
  }

  /**
   * Release a worktree, REFUSING to free another live process's reservation.
   *
   * Routed through `decide` over `worktrees@v1` so the release folds the current
   * state first: if the worktree is `reserved` by a live owner that is NOT the
   * caller (`owner`), the release is REJECTED (emits nothing) and
   * {@link ReleaseResult.rejectedForeignOwner} is `true` — a stale caller can no
   * longer relinquish someone else's live claim. A release with no caller
   * identity cannot match a live owner, so it too is refused while a live foreign
   * owner holds the worktree (reaping a dead owner is `reconcile`'s job).
   *
   * Otherwise (free / not-`reserved` / dead-owner / same-owner) it appends
   * `worktree.released`, folding the current entry for `path` / `featureId`
   * provenance (owner fields cleared). An unknown `worktreeId` still emits a
   * well-formed released event (path defaults to the id, featureId to `null`) —
   * a safe idempotent no-op when nothing is held.
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
            rejectedForeignOwner = true; // live foreign reservation → never release.
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
   * If `entry` is `reserved` by a live owner (liveness `alive` OR unprovable
   * `unknown`) that is NOT `caller`, return that owner; otherwise `null`. The
   * single ownership-conflict predicate shared by `reserve` (reject a foreign
   * live claim) and `release` (refuse to free a foreign live claim). A provably
   * `dead` owner, a non-`reserved` entry, or a same-owner caller all return
   * `null` (no live foreign owner blocks the operation). Pure over the injected
   * {@link ProcessSource}.
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
      return null; // provably dead owner → no live claim to protect.
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
      worktreeId: this.canonicalId(wt.path),
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
      let classification = classifyPruneCandidate(facts);
      // No double-free (DR-12): a worktree (or its integration branch) that
      // holds an unpaired in-flight merge lease is never deletion-eligible while
      // the merge runs — override an otherwise-deletable classification to a
      // scannable `in-flight-merge` skip. The under-lock re-verify in
      // `executeDeletion` enforces the same guard against a lease that appears
      // AFTER this planning fold, so the report and the commit gate agree.
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
          orphansOptedIn,
          branchCache,
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
   * Read-only listing of the live serialized-merge set (DR-4): fold the
   * `worktrees` stream and return every {@link InFlightMerge} — an open
   * `worktree.merge_requested` with no paired `worktree.merge_executed`. Backs
   * the `ps` view action's in-flight column. Appends nothing and runs NO process
   * scan — it is a pure fold of the event log.
   */
  async listInFlightMerges(): Promise<readonly InFlightMerge[]> {
    const projection = await this.loadProjection();
    return Object.values(projection.inFlightMerges);
  }

  /**
   * On-demand orphan / stale-reservation probe + emit — the deferred orphan
   * emitter (DR-5). Folds the `worktrees@v1` projection, runs the ground-truth
   * {@link probeWorktrees} process probe over every governed worktree, and emits
   * exactly ONE terminal lifecycle event per finding:
   *
   *   - recorded owner provably DEAD and NOT occupied by a live process →
   *     `worktree.released` (heal the stale reservation, exactly as `reconcile`
   *     does — but cross-checked against ground-truth cwd occupancy).
   *   - recorded owner provably DEAD but the worktree IS still occupied by a
   *     live, non-ancestry process → `worktree.orphan_detected` (the recorded
   *     owner is gone yet work may be live; flag as orphan, do NOT free).
   *
   * A live / unprovable (`unknown`) owner, and any unreserved entry, emit
   * NOTHING — the probe never reclaims what it cannot prove gone. `selfPid` (and
   * its FULL parent-PID ancestry) is excluded from occupancy so the
   * orchestrator's own drifted cwd never marks a worktree in-use. This is the
   * ONLY write path on the otherwise read-only `ps`/`wait` view surface, and it
   * runs only when the caller passes `--probe`. Idempotent across runs: once
   * released/orphaned the entry is no longer `reserved`, so a re-probe finds no
   * dead owner and emits nothing.
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
    // Findings come back in target order; zip with `entries` by index so the
    // canonical `worktreeId` (the projection key) — not just the probe's `path`
    // — is what we stamp on the emitted event.
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
      if (finding === undefined) continue;
      if (finding.releasable) {
        // Owner provably dead AND no live occupant → free the stale reservation.
        await this.appendLifecycle('worktree.released', entry);
        released.push(entry.worktreeId);
      } else if (finding.ownerLiveness === 'dead' && finding.inUse) {
        // Owner provably dead BUT a live foreign process occupies it → orphan.
        await this.appendLifecycle('worktree.orphan_detected', entry);
        orphaned.push(entry.worktreeId);
      }
    }
    return { released, orphaned, probed: entries.length };
  }

  /**
   * Append one terminal lifecycle event (`worktree.released` /
   * `worktree.orphan_detected`) for `entry`, clearing the owner fields. Keyed by
   * `<eventType>:<operationId>` for idempotency (matching the rest of the
   * worktree family); the `worktrees@v1` reducer flips the entry's state and
   * nulls the owner on fold. A plain keyed append — no OCC pin — because the
   * probe already established the owner is provably dead (no live claim to race).
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
   * Caller-bounded poll until the serialized merge on `integrationRef` reaches
   * its terminal `worktree.merge_executed` (DR-4). Folds `worktrees@v1` each
   * iteration: when `inFlightMerges[integrationRef]` is clear the wait RESOLVES;
   * otherwise it sleeps `pollIntervalMs` via the INJECTED {@link SleepFn} seam
   * (shared with `git-retry.ts`) and re-folds, until the explicit `timeoutMs`
   * deadline — then returns `{ resolved: false }` with the still-live holder so
   * the caller can surface a STRUCTURED timeout. Pure read: appends NOTHING and
   * creates NO background interval/timer (the only timer is the injected sleep's
   * own, which production wires to `setTimeout` and tests replace). NEVER hangs.
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
   * Gather the injected facts the pure ladder classifies over, for one entry.
   * Every fact is read here (state, ownership liveness, dirty, integration ref,
   * merge ancestry, backing gitdir, origin) — the ladder computes none of them.
   */
  private async gatherFacts(
    entry: WorktreeEntry,
    branchCache: Map<string, string | null>,
  ): Promise<PruneCandidate> {
    // Treat BOTH a live owner (`alive`) AND an unprovable one (`unknown` — the
    // owner could not be probed) as in-use, so a probe failure NEVER lets the
    // ladder reclaim a possibly-live reservation. Only a provably `dead` owner
    // (or a non-reserved entry) is not in-use.
    const inUse = reservationLiveness(entry, this.processSource) !== 'dead';
    // Backing presence is computed BEFORE dirtiness so `isDirty` can fail closed
    // ONLY when the backing repo is present (see its doc): an orphan's `git
    // status` fails because the backing is gone, which is the orphan rung's job,
    // not a "dirty" skip.
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

  /**
   * `git status --porcelain --untracked-files=all` non-empty ⇒ dirty
   * (untracked-aware).
   *
   * **Fail-closed on a probe failure WHEN THE BACKING REPO IS PRESENT.** A
   * non-zero git status with a live backing repo means cleanliness could NOT be
   * verified (a locked index, a transient git error, a broken-but-present repo),
   * so we return `true` (treat as dirty, skip) — NEVER `false`. Reading a probe
   * failure as "clean" was a data-loss hole: it let the ladder reach
   * `delete-eligible` and wipe uncommitted work.
   *
   * When the backing repo is GONE (`backingPresent === false`), `git status`
   * cannot run by definition (the worktree is an orphan); that is the ORPHAN
   * rung's responsibility (handler-gated `--prune-orphans --yes` deletion), so we
   * must NOT pre-empt it with a `dirty` skip — return `false` and let the ladder
   * thread to the orphan rung. The orphan opt-in is itself the explicit
   * "content is unverifiable" acknowledgment.
   */
  private isDirty(worktreePath: string, backingPresent: boolean): boolean {
    const { status, stdout } = this.gitRunner.run(
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath,
    );
    if (status !== 0) {
      // Cannot prove CLEAN: fail closed (dirty) only when a backing repo exists;
      // an orphan's unverifiability is handled by the orphan rung instead.
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
    const targetId = this.canonicalId(worktreePath);
    return parseWorktreeListPorcelain(stdout).some(
      (wt) => this.canonicalId(wt.path) === targetId,
    );
  }

  // ─── Two-event deletion (INV-13) ────────────────────────────────────────────

  /**
   * Delete one eligible worktree through the INV-13 two-event split. NEVER
   * `git reset --hard`s; the only mutating git command is `git worktree remove`.
   *
   *   - **Plan / reserve / re-verify UNDER the stream lock → commit intent.** A
   *     `decide` over `worktrees@v1` re-folds the CURRENT state and emits
   *     `worktree.remove.requested` ONLY while the entry is still present, in a
   *     deletion-eligible state (`released` / `orphan`), AND still passes the
   *     FULL safety ladder when re-classified against fresh disk + ownership
   *     facts. The state re-check alone is not enough: a `released` worktree that
   *     went dirty / unmerged / back in-use AFTER the planning classification
   *     would still be `released`, so we re-gather facts and re-run
   *     {@link classifyPruneCandidate} here — a now-ineligible candidate aborts
   *     (emits nothing), never committing the delete intent. A concurrent
   *     reconcile / prune that flipped state re-folds to a no-op too.
   *   - **Idempotent side-effect OUTSIDE the lock.** Run `git worktree remove`
   *     only when the worktree is still registered; an already-absent worktree
   *     downgrades to `removed: false` (idempotent success), and a remove that
   *     fails while the worktree is STILL registered surfaces as a real error.
   *   - **Commit outcome.** Emit `worktree.remove.executed` (idempotency keyed on
   *     `operationId`, stamped with the canonical `worktreeId`) — the
   *     `worktrees@v1` reducer drops the entry on it.
   *
   * Returns `attempted: false` only when the under-lock re-verify aborts (the
   * candidate was no longer eligible at commit time).
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

    // ── Phase A: durable intent, re-verifying eligibility under the lock. ──
    let kind: DecideResult['kind'] = 'no-op';
    await withStateRetry(async () => {
      const result = await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        async (state) => {
          const entry = state.worktrees[worktreeId];
          // Gone (already removed) OR no longer deletion-eligible by state
          // (re-reserved / re-adopted under us) ⇒ abort: emit nothing.
          if (entry === undefined) return [];
          if (entry.state !== 'released' && entry.state !== 'orphan') return [];
          // TOCTOU close: re-run the FULL ladder against CURRENT facts (dirty /
          // merge ancestry / ownership liveness), not just the projection state.
          // A worktree that became dirty / unmerged / in-use between the planning
          // pass and now is no longer safe — abort rather than commit the delete.
          const facts = await this.gatherFacts(entry, branchCache);
          // No double-free (DR-12), re-verified UNDER the claim: a merge lease
          // that landed on this worktree (or its integration branch) AFTER the
          // planning fold is visible in THIS in-closure fold of `inFlightMerges`,
          // so a `serialize_merge` that won the slot concurrently aborts the
          // delete intent — the GC never removes a worktree mid-merge.
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
              // Stamp the canonical `worktreeId` so the reducer drops the entry
              // by the stored key on replay — no realpath() at fold time (INV-1).
              data: { operationId, worktreePath, worktreeId },
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
    await this.appendRemoveExecuted(operationId, worktreePath, removed, worktreeId);
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
    for (const { operationId, worktreePath, worktreeId } of orphaned) {
      if (handled.has(operationId)) continue; // one executed per operationId
      handled.add(operationId);
      const removed = this.removeWorktreeIfRegistered(repoRoot, worktreePath);
      // Carry the stamped `worktreeId` from the original requested event (when
      // present) onto the completing executed event so replay still drops by id.
      await this.appendRemoveExecuted(
        operationId,
        worktreePath,
        removed,
        worktreeId ?? undefined,
      );
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

  /**
   * Append `worktree.remove.executed` (idempotency keyed on `operationId`).
   * Stamps the canonical `worktreeId` when known (always for a fresh deletion;
   * carried over from the orphaned `requested` event on crash recovery, where it
   * may be absent for a legacy pre-stamp event) so the reducer drops the entry
   * by the stored key without a realpath() at fold time (INV-1).
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
   * Scan the worktrees stream for `worktree.remove.requested` events with no
   * paired `worktree.remove.executed` (operationId-correlated) — the crashed
   * deletions to resume, in stream order.
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
      // `worktreeId` is present on post-stamp requested events, null on legacy.
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
