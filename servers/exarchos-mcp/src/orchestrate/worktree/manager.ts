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
 *
 * `adopt` (Task 005) and `prune` (Task 007) are deliberately NOT here yet — they
 * append to this same facade later. The module is structured so those methods
 * drop in beside these three without churn; this slice does NOT touch
 * `setup-worktree.ts` / `worktree-baseref.ts` / `dispatch-guard.ts`.
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
import type { EventStore } from '../../event-store/store.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from './pure/process-identity.js';
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

  constructor(deps: WorktreeManagerDeps) {
    this.eventStore = deps.eventStore;
    this.processSource = deps.processSource ?? defaultProcessSource;
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
