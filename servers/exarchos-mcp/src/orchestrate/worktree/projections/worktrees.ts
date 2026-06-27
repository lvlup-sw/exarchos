/**
 * `worktrees@v1` projection reducer (WLM foundation, DR-1).
 *
 * Folds the worktree-lifecycle event family on the dedicated singleton
 * `worktrees` stream into a {@link WorktreesProjection} — a map of
 * {@link WorktreeEntry} records keyed by `worktreeId` (the canonical,
 * symlink-resolved worktree path) PLUS an `inFlightMerges` map keyed by
 * `integrationRef`. This is the single canonical left-fold that derives the live
 * set of governed worktrees AND the live set of in-flight serialized merges from
 * the event log alone (INV-1).
 *
 * ## Fold rules
 *
 *   - `worktree.adopted`        → upsert, state `adopted`,  owner cleared
 *   - `worktree.reserved`       → upsert, state `reserved`, owner set from event
 *   - `worktree.released`       → upsert, state `released`, owner cleared
 *   - `worktree.orphan_detected`→ upsert, state `orphan`,   owner cleared
 *   - `worktree.remove.executed`→ DROP the entry from the map (absence is the
 *                                 terminal state — there is NO `removed` state)
 *   - `worktree.merge_requested`→ upsert an {@link InFlightMerge} under its
 *                                 `integrationRef` (the CLAIM half of the lease)
 *   - `worktree.merge_executed` → CLEAR the in-flight merge for that
 *                                 `integrationRef` (the RELEASE half)
 *
 * `worktree.remove.requested` is durable intent only and is a no-op here; the
 * entry is dropped on `worktree.remove.executed`. Every lifecycle event carries
 * the full payload (`worktreeId`, `path`, `featureId`, owner fields), so each
 * upsert is self-describing and the fold reproduces state from the log alone.
 *
 * ## In-flight merges (DR-4)
 *
 * The serialized-merge lease pair rides the SAME singleton `worktrees` stream as
 * the lifecycle family but folds into a SEPARATE `inFlightMerges` map keyed by
 * `integrationRef`, NOT by `worktreeId`. An integration-branch merge typically
 * maps to NO adopted worktree entry (the integration branch is the main
 * worktree), so it must have a home keyed by the branch it targets. The CLAIM
 * (`worktree.merge_requested`) records which live process holds the right to
 * merge `sourceBranch` into `integrationRef`; the RELEASE
 * (`worktree.merge_executed`) clears it. The `ps` / `wait` read paths read
 * `inFlightMerges` to surface and block on live merges. Per-branch serialization
 * means at most one in-flight merge exists per `integrationRef` at a time.
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
 * The remove pair carries the already-canonical `worktreeId` (stamped by the
 * emitting {@link WorktreeManager}); the reducer drops the entry under that
 * STORED key with NO filesystem call, so the fold is deterministic from the
 * event log alone — the same log re-folds identically after the worktree is gone
 * or on a host with a different symlink topology (INV-1 cold rebuild).
 *
 * For backward compatibility a legacy remove event that carries only
 * `worktreePath` (no `worktreeId`) is handled via a fallback: canonicalize the
 * `worktreePath` through the injected {@link RealpathResolver} (defaulting to
 * {@link defaultRealpath}). That fallback is the ONLY path that touches the
 * filesystem, and only for pre-stamp events — mirroring the Task-001
 * `isPathWithin` primitive's injectable resolver for deterministic tests.
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
 * A single in-flight serialized merge — the CLAIM half of the
 * `worktree.merge_requested` / `worktree.merge_executed` lease pair (DR-4).
 *
 * Keyed in {@link WorktreesProjection.inFlightMerges} by `integrationRef` (the
 * per-branch serialization key), NOT by `worktreeId`: an integration-branch
 * merge typically maps to no adopted worktree entry. `holderPid` /
 * `holderStartedAt` identify the live process holding the merge lease (liveness
 * ground truth for orphan reclamation); `worktreeId` is the optional canonical
 * `worktrees@v1` key when the merge is attributable to a specific worktree.
 */
export interface InFlightMerge {
  /** Integration ref the merge targets — the map key / per-branch serialization key. */
  readonly integrationRef: string;
  /** Idempotency key / lease correlator — the sole per-merge discriminator. */
  readonly operationId: string;
  /** Branch being merged into `integrationRef`. */
  readonly sourceBranch: string;
  /** PID of the live process holding the merge lease, or `null` when absent. */
  readonly holderPid: number | null;
  /** Lease-holder process start time (ISO 8601), or `null` — disambiguates PID reuse. */
  readonly holderStartedAt: string | null;
  /** Canonical `worktrees@v1` key when attributable to a tracked worktree, else `null`. */
  readonly worktreeId: string | null;
}

/**
 * The full projected state: a map of {@link WorktreeEntry} keyed by
 * `worktreeId`, a map of {@link InFlightMerge} keyed by `integrationRef`, plus
 * the monotone `projectionSequence` stale-snapshot detector (bumped only on
 * handled, state-changing events — matching the sibling `task-store@v1`
 * convention).
 */
export interface WorktreesProjection {
  readonly projectionSequence: number;
  readonly worktrees: Readonly<Record<string, WorktreeEntry>>;
  /** Live serialized merges keyed by `integrationRef` (DR-4). */
  readonly inFlightMerges: Readonly<Record<string, InFlightMerge>>;
}

/** Shared initial seed. Safe to share across folds because `apply` is pure. */
export const initialWorktreesProjection: WorktreesProjection = {
  projectionSequence: 0,
  worktrees: {},
  inFlightMerges: {},
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
    // Lifecycle events never touch the merge map — structural-share it through.
    inFlightMerges: state.inFlightMerges,
  };
}

/**
 * Drop the entry targeted by a `worktree.remove.executed` event.
 *
 * Prefers the STORED canonical `worktreeId` the emitter stamped onto the event
 * (no filesystem access — the deterministic, cold-rebuildable path). Only when
 * that is absent (a legacy pre-stamp event) does it fall back to canonicalizing
 * the event's `worktreePath` through `realpath`. Returns `state` by identity
 * when neither key is present or no entry is keyed under the resolved id
 * (idempotent — a remove for an already-absent worktree is a no-op).
 */
function dropRemoved(
  state: WorktreesProjection,
  event: WorkflowEvent,
  realpath: RealpathResolver,
): WorktreesProjection {
  // Stamped canonical key wins — drop by it with NO realpath() call so the fold
  // is deterministic from the log alone, even after the worktree is gone (INV-1).
  const storedId = extractString(event.data, 'worktreeId');
  let worktreeId: string;
  if (storedId) {
    worktreeId = storedId;
  } else {
    const worktreePath = extractString(event.data, 'worktreePath');
    if (!worktreePath) return state;
    // Legacy fallback (pre-stamp events only): canonicalize through the SAME
    // `toPosix(realpath(resolve(...)))` form the emitter keys its entries under,
    // so a remove event folds onto the adopted entry's key on Windows too
    // (#1620), not a backslash-vs-forward-slash sibling that would miss.
    worktreeId = canonicalWorktreeId(worktreePath, realpath);
  }
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
    // Removal never touches the merge map — structural-share it through.
    inFlightMerges: state.inFlightMerges,
  };
}

// ─── In-flight merge fold helpers (DR-4) ────────────────────────────────────

/**
 * Upsert the {@link InFlightMerge} for a `worktree.merge_requested` event under
 * its `integrationRef`. Returns `state` by identity when the event is missing a
 * usable `integrationRef`, `operationId`, or `sourceBranch` (lax replay
 * tolerance, mirroring {@link upsertLifecycle}). The worktree-entry map is left
 * untouched — a merge claim folds ONLY into `inFlightMerges`.
 */
function upsertInFlightMerge(
  state: WorktreesProjection,
  event: WorkflowEvent,
): WorktreesProjection {
  const integrationRef = extractString(event.data, 'integrationRef');
  const operationId = extractString(event.data, 'operationId');
  const sourceBranch = extractString(event.data, 'sourceBranch');
  if (!integrationRef || !operationId || !sourceBranch) return state;
  const merge: InFlightMerge = {
    integrationRef,
    operationId,
    sourceBranch,
    holderPid: extractNumber(event.data, 'holderPid') ?? null,
    holderStartedAt: extractString(event.data, 'holderStartedAt') ?? null,
    worktreeId: extractString(event.data, 'worktreeId') ?? null,
  };
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: state.worktrees,
    inFlightMerges: { ...state.inFlightMerges, [integrationRef]: merge },
  };
}

/**
 * Clear the in-flight merge targeted by a `worktree.merge_executed` event.
 *
 * Removes the entry keyed under the event's `integrationRef`. Returns `state` by
 * identity when no `integrationRef` is present, no entry is keyed under it
 * (idempotent — a release for an already-cleared merge is a no-op), or the
 * stored claim's `operationId` does not match this release's `operationId`. The
 * `operationId` guard correlates the RELEASE to the exact CLAIM it terminates
 * (the documented correlation, even for dead-holder recovery releases) so a
 * stale release can never clobber a newer concurrent claim under the same
 * `integrationRef`.
 */
function clearInFlightMerge(
  state: WorktreesProjection,
  event: WorkflowEvent,
): WorktreesProjection {
  const integrationRef = extractString(event.data, 'integrationRef');
  if (!integrationRef) return state;
  if (!Object.prototype.hasOwnProperty.call(state.inFlightMerges, integrationRef)) {
    return state;
  }
  const operationId = extractString(event.data, 'operationId');
  const existing = state.inFlightMerges[integrationRef];
  if (operationId && existing.operationId !== operationId) return state;
  const nextInFlight: Record<string, InFlightMerge> = {};
  for (const [key, value] of Object.entries(state.inFlightMerges)) {
    if (key !== integrationRef) nextInFlight[key] = value;
  }
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: state.worktrees,
    inFlightMerges: nextInFlight,
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
        case 'worktree.merge_requested':
          return upsertInFlightMerge(state, event);
        case 'worktree.merge_executed':
          return clearInFlightMerge(state, event);
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
