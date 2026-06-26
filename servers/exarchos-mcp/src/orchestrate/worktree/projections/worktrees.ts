/**
 * `worktrees@v1` projection reducer (WLM foundation, DR-1).
 *
 * Folds the worktree-lifecycle event family on the dedicated singleton
 * `worktrees` stream into a {@link WorktreesProjection} — a map of
 * {@link WorktreeEntry} records keyed by `worktreeId` (the canonical,
 * symlink-resolved worktree path). This is the single canonical left-fold that
 * derives the live set of governed worktrees from the event log alone (INV-1).
 *
 * ## Fold rules
 *
 *   - `worktree.adopted`        → upsert, state `adopted`,  owner cleared
 *   - `worktree.reserved`       → upsert, state `reserved`, owner set from event
 *   - `worktree.released`       → upsert, state `released`, owner cleared
 *   - `worktree.orphan_detected`→ upsert, state `orphan`,   owner cleared
 *   - `worktree.remove.executed`→ DROP the entry from the map (absence is the
 *                                 terminal state — there is NO `removed` state)
 *
 * `worktree.remove.requested` is durable intent only and is a no-op here; the
 * entry is dropped on `worktree.remove.executed`. Every lifecycle event carries
 * the full payload (`worktreeId`, `path`, `featureId`, owner fields), so each
 * upsert is self-describing and the fold reproduces state from the log alone.
 *
 * ## Owner discipline
 *
 * Per the {@link WorktreeEntry} contract, `ownerStartedAt` (and, for symmetry,
 * `ownerPid`) is non-null ONLY while the entry is `reserved` — a reservation is
 * the sole state that records a live holding process. Every other transition
 * clears the owner fields to `null`.
 *
 * ## Remove correlation
 *
 * The remove pair carries `worktreePath` (an absolute path), not `worktreeId`.
 * Because `worktreeId` IS the canonical (symlink-resolved) path, we canonicalize
 * the remove event's `worktreePath` through the injected {@link RealpathResolver}
 * and drop the entry under that key. The resolver is injected (defaulting to
 * {@link defaultRealpath}) so the canonicalization is deterministic and
 * unit-testable with a simulated symlink map — mirroring the Task-001
 * `isPathWithin` primitive.
 *
 * ## Purity contract
 *
 * Per DR-1, `apply` is deterministic (over its injected resolver),
 * side-effect-free, and never mutates its `state` argument — every transition
 * constructs a fresh {@link WorktreesProjection} via structural sharing.
 * Unhandled / malformed events return the input `state` by identity (no
 * `projectionSequence` bump), preserving change-detection semantics. Enforced by
 * `assertReducerImmutable` in the co-located test.
 */
import type { ProjectionReducer } from '../../../projections/types.js';
import type { WorkflowEvent } from '../../../event-store/schemas.js';
import {
  canonicalWorktreeId,
  defaultRealpath,
  type RealpathResolver,
} from '../pure/path-containment.js';

// ─── Projection state types ─────────────────────────────────────────────────

/** Lifecycle state of a governed worktree. There is no `removed` state — a
 * removed worktree is absent from the projection map (absence is terminal). */
export type WorktreeState = 'adopted' | 'reserved' | 'released' | 'orphan';

/**
 * A single governed worktree's projected state.
 *
 * Keyed in {@link WorktreesProjection.worktrees} by `worktreeId` (= the
 * canonical, symlink-resolved worktree path).
 */
export interface WorktreeEntry {
  /** Canonical (symlink-resolved) worktree path — the stable identity / map key. */
  readonly worktreeId: string;
  /** Absolute filesystem path to the worktree (as reported by the emitter). */
  readonly path: string;
  /** Owning feature id, or `null` when unattached. */
  readonly featureId: string | null;
  /** Latest observed lifecycle state (latest event wins). */
  readonly state: WorktreeState;
  /** PID of the holding process — non-null only while `state === 'reserved'`. */
  readonly ownerPid: number | null;
  /** Holder process start time (ISO 8601) — non-null only while `state === 'reserved'`. */
  readonly ownerStartedAt: string | null;
}

/**
 * The full projected state: a map of {@link WorktreeEntry} keyed by
 * `worktreeId`, plus the monotone `projectionSequence` stale-snapshot detector
 * (bumped only on handled, state-changing events — matching the sibling
 * `task-store@v1` convention).
 */
export interface WorktreesProjection {
  readonly projectionSequence: number;
  readonly worktrees: Readonly<Record<string, WorktreeEntry>>;
}

/** Shared initial seed. Safe to share across folds because `apply` is pure. */
export const initialWorktreesProjection: WorktreesProjection = {
  projectionSequence: 0,
  worktrees: {},
};

// ─── Typed field extractors over the opaque event payload ───────────────────
//
// The event-store base schema types `data` as `Record<string, unknown> | undefined`;
// these do the runtime checks the type system cannot. Mirrors the pattern in
// the sibling `taskstore` / `merge-orchestrator` reducers.

function extractString(
  data: WorkflowEvent['data'],
  key: string,
): string | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function extractNumber(
  data: WorkflowEvent['data'],
  key: string,
): number | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** `featureId` is `string | null` on the wire — coalesce missing/invalid to `null`. */
function extractFeatureId(data: WorkflowEvent['data']): string | null {
  return extractString(data, 'featureId') ?? null;
}

// ─── Upsert helper ──────────────────────────────────────────────────────────

/**
 * Build the {@link WorktreeEntry} for a lifecycle event and upsert it under its
 * `worktreeId`. Returns `state` by identity when the event is missing a usable
 * `worktreeId` (lax replay tolerance, DR-1). Owner fields are populated only for
 * the `reserved` state; every other state clears them to `null`.
 */
function upsertLifecycle(
  state: WorktreesProjection,
  event: WorkflowEvent,
  next: WorktreeState,
): WorktreesProjection {
  const worktreeId = extractString(event.data, 'worktreeId');
  if (!worktreeId) return state;
  // `path` defaults to the worktreeId (the canonical path) when absent.
  const entryPath = extractString(event.data, 'path') ?? worktreeId;
  const reserved = next === 'reserved';
  const entry: WorktreeEntry = {
    worktreeId,
    path: entryPath,
    featureId: extractFeatureId(event.data),
    state: next,
    ownerPid: reserved ? (extractNumber(event.data, 'ownerPid') ?? null) : null,
    ownerStartedAt: reserved
      ? (extractString(event.data, 'ownerStartedAt') ?? null)
      : null,
  };
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: { ...state.worktrees, [worktreeId]: entry },
  };
}

/**
 * Drop the entry targeted by a `worktree.remove.executed` event. The event
 * carries `worktreePath`; we canonicalize it through `realpath` to recover the
 * `worktreeId` key. Returns `state` by identity when the path is missing or no
 * entry is keyed under the canonical id (idempotent — a remove for an
 * already-absent worktree is a no-op).
 */
function dropRemoved(
  state: WorktreesProjection,
  event: WorkflowEvent,
  realpath: RealpathResolver,
): WorktreesProjection {
  const worktreePath = extractString(event.data, 'worktreePath');
  if (!worktreePath) return state;
  // Canonicalize through the SAME `toPosix(realpath(resolve(...)))` form the
  // emitter (`WorktreeManager.adopt`) keys its entries under, so a remove event
  // folds onto the adopted entry's key on Windows too (#1620), not a
  // backslash-vs-forward-slash sibling that would miss.
  const worktreeId = canonicalWorktreeId(worktreePath, realpath);
  if (!Object.prototype.hasOwnProperty.call(state.worktrees, worktreeId)) {
    return state;
  }
  const nextWorktrees: Record<string, WorktreeEntry> = {};
  for (const [key, value] of Object.entries(state.worktrees)) {
    if (key !== worktreeId) nextWorktrees[key] = value;
  }
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: nextWorktrees,
  };
}

// ─── Reducer factory + default instance ─────────────────────────────────────

/**
 * Construct a `worktrees@v1` reducer with an injectable {@link RealpathResolver}
 * for the remove-correlation canonicalization. Production code uses the default
 * (`defaultRealpath`); tests inject a pure symlink-map resolver so the fold is
 * deterministic and filesystem-free.
 */
export function createWorktreesReducer(
  realpath: RealpathResolver = defaultRealpath,
): ProjectionReducer<WorktreesProjection, WorkflowEvent> {
  return {
    id: 'worktrees@v1',
    version: 1,
    // Folds the singleton `worktrees` stream — consumed by the per-stream
    // `aggregateStream` / `decide` primitives, not the cross-stream `readProjection`.
    scope: 'stream' as const,
    initial: initialWorktreesProjection,
    apply(state: WorktreesProjection, event: WorkflowEvent): WorktreesProjection {
      switch (event.type) {
        case 'worktree.adopted':
          return upsertLifecycle(state, event, 'adopted');
        case 'worktree.reserved':
          return upsertLifecycle(state, event, 'reserved');
        case 'worktree.released':
          return upsertLifecycle(state, event, 'released');
        case 'worktree.orphan_detected':
          return upsertLifecycle(state, event, 'orphan');
        case 'worktree.remove.executed':
          return dropRemoved(state, event, realpath);
        default:
          // Unknown / intent-only event (e.g. `worktree.remove.requested`) —
          // return identity to preserve structural-sharing semantics.
          return state;
      }
    },
  };
}

/**
 * Process-wide `worktrees@v1` reducer (default-resolver instance). Registered
 * with `defaultRegistry` by the sibling `./index.ts` barrel at module load
 * (DR-1 — concrete projections self-register).
 */
export const worktreesReducer = createWorktreesReducer();
