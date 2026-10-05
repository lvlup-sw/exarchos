/**
 * The `worktrees@v1` projection reducer.
 *
 * It folds the events of the singleton `worktrees` stream into three maps:
 * worktree entries by `worktreeId`, in-flight merges by `integrationRef`, and
 * in-flight prunes by `operationId`. The fold reads only the event log, except
 * for the `realpath` fallback of an old remove event.
 *
 * A lifecycle event upserts an entry with its state. `worktree.remove.executed`
 * drops the entry, because a removed worktree has no state. Each start event
 * (`worktree.merge_requested`, `launch.executing_started`,
 * `prune.executing_started`) records a claim, and its paired terminal event
 * clears the claim. `apply` never changes its `state` argument. An unknown or
 * malformed event returns `state` by identity, with no `projectionSequence` bump.
 */
import type { ProjectionReducer } from '../../../projections/types.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import {
  canonicalWorktreeId,
  defaultRealpath,
  type RealpathResolver,
} from '../pure/path-containment.js';

/**
 * Lifecycle state of a governed worktree. There is no `removed` state. A
 * removed worktree is absent from the projection map.
 */
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
  /**
   * The launcher liveness marker. `launch.executing_started` sets it, and the
   * paired `launch.executed` removes it. A lifecycle event keeps it unchanged,
   * because the launch is independent of the reservation.
   */
  readonly launch?: LaunchInFlight;
}

/**
 * The liveness data of a running launcher child process, on its
 * {@link WorktreeEntry}. A reconciler can check that `holderPid` with the same
 * `holderStartedAt` is alive. A `null` field means the emitter did not capture it.
 */
export interface LaunchInFlight {
  /** PID of the launcher/supervisor process holding the launch, or `null`. */
  readonly holderPid: number | null;
  /** Supervisor process start time (ISO 8601) — disambiguates PID reuse, or `null`. */
  readonly holderStartedAt: string | null;
}

/**
 * An in-flight serialized merge: the claim of the `worktree.merge_requested`
 * and `worktree.merge_executed` pair. The key is `integrationRef`, not
 * `worktreeId`, because an integration branch merge usually has no worktree
 * entry. `ps` and `wait` read these claims to show and wait for live merges.
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
 * An in-flight `prune_worktrees` pass: the claim of the
 * `prune.executing_started` and `prune.executed` pair. The key is the
 * `operationId` of the pass. `ps` and `wait` can see a long pass until its
 * terminal event clears the claim.
 */
export interface InFlightPrune {
  /** Correlation key — the map key / sole per-pass discriminator. */
  readonly operationId: string;
  /** Repo root the prune pass governs. */
  readonly repoRoot: string;
  /** PID of the live process running the pass, or `null` when absent. */
  readonly holderPid: number | null;
  /** Holder process start time (ISO 8601), or `null` — disambiguates PID reuse. */
  readonly holderStartedAt: string | null;
}

/**
 * The full projected state. `projectionSequence` detects a stale snapshot. It
 * increases only on a handled event that changes the state.
 */
export interface WorktreesProjection {
  readonly projectionSequence: number;
  readonly worktrees: Readonly<Record<string, WorktreeEntry>>;
  /** Live serialized merges keyed by `integrationRef`. */
  readonly inFlightMerges: Readonly<Record<string, InFlightMerge>>;
  /** Live `prune_worktrees` passes keyed by `operationId`. */
  readonly inFlightPrunes: Readonly<Record<string, InFlightPrune>>;
}

/** Shared initial seed. Safe to share across folds because `apply` is pure. */
export const initialWorktreesProjection: WorktreesProjection = {
  projectionSequence: 0,
  worktrees: {},
  inFlightMerges: {},
  inFlightPrunes: {},
};

/** Returns a non-empty string field of the event data, or `undefined`. */
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

/**
 * Upserts the {@link WorktreeEntry} for a lifecycle event under its
 * `worktreeId`. Without a `worktreeId`, it returns `state` by identity.
 *
 * Only the `reserved` state takes the owner fields from the event, because only
 * a reservation has a live holder. Every other state sets them to `null`.
 * `path` defaults to `worktreeId`. The entry keeps any launch marker, so only
 * `launch.executed` can clear it.
 */
function upsertLifecycle(
  state: WorktreesProjection,
  event: WorkflowEvent,
  next: WorktreeState,
): WorktreesProjection {
  const worktreeId = extractString(event.data, 'worktreeId');
  if (!worktreeId) return state;
  const entryPath = extractString(event.data, 'path') ?? worktreeId;
  const reserved = next === 'reserved';
  const carriedLaunch = state.worktrees[worktreeId]?.launch;
  const entry: WorktreeEntry = {
    worktreeId,
    path: entryPath,
    featureId: extractFeatureId(event.data),
    state: next,
    ownerPid: reserved ? (extractNumber(event.data, 'ownerPid') ?? null) : null,
    ownerStartedAt: reserved
      ? (extractString(event.data, 'ownerStartedAt') ?? null)
      : null,
    ...(carriedLaunch !== undefined ? { launch: carriedLaunch } : {}),
  };
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: { ...state.worktrees, [worktreeId]: entry },
    inFlightMerges: state.inFlightMerges,
    inFlightPrunes: state.inFlightPrunes,
  };
}

/**
 * Drops the entry of a `worktree.remove.executed` event.
 *
 * The function uses the `worktreeId` in the event, with no file system call.
 * Thus a rebuild from the log gives the same result after the worktree is gone.
 * An old event without `worktreeId` falls back to `canonicalWorktreeId` over
 * its `worktreePath`. That is the key form of the emitter, so the key also
 * matches on Windows. This fallback is the only file system call in the
 * reducer. A remove for an absent entry returns `state` by identity.
 */
function dropRemoved(
  state: WorktreesProjection,
  event: WorkflowEvent,
  realpath: RealpathResolver,
): WorktreesProjection {
  const storedId = extractString(event.data, 'worktreeId');
  let worktreeId: string;
  if (storedId) {
    worktreeId = storedId;
  } else {
    const worktreePath = extractString(event.data, 'worktreePath');
    if (!worktreePath) return state;
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
    inFlightMerges: state.inFlightMerges,
    inFlightPrunes: state.inFlightPrunes,
  };
}

/**
 * Upserts the {@link InFlightMerge} of a `worktree.merge_requested` event
 * under its `integrationRef`. Without `integrationRef`, `operationId`, or
 * `sourceBranch`, it returns `state` by identity.
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
    inFlightPrunes: state.inFlightPrunes,
  };
}

/**
 * Clears the in-flight merge of a `worktree.merge_executed` event.
 *
 * Only a release with the same `operationId` as the claim clears it. A
 * release without an `operationId` clears nothing. Thus a stale release cannot
 * remove a newer claim on the same `integrationRef`. A release for an absent
 * claim returns `state` by identity.
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
  if (!operationId) return state;
  const existing = state.inFlightMerges[integrationRef];
  if (existing === undefined || existing.operationId !== operationId) return state;
  const nextInFlight: Record<string, InFlightMerge> = {};
  for (const [key, value] of Object.entries(state.inFlightMerges)) {
    if (key !== integrationRef) nextInFlight[key] = value;
  }
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: state.worktrees,
    inFlightMerges: nextInFlight,
    inFlightPrunes: state.inFlightPrunes,
  };
}

/**
 * Attaches the {@link LaunchInFlight} marker of a `launch.executing_started`
 * event to the entry with its `worktreeId`. For an absent entry, it returns
 * `state` by identity. The event has no `path` or `featureId` to build an entry.
 */
function markLaunchInFlight(
  state: WorktreesProjection,
  event: WorkflowEvent,
): WorktreesProjection {
  const worktreeId = extractString(event.data, 'worktreeId');
  if (!worktreeId) return state;
  const existing = state.worktrees[worktreeId];
  if (existing === undefined) return state;
  const launch: LaunchInFlight = {
    holderPid: extractNumber(event.data, 'holderPid') ?? null,
    holderStartedAt: extractString(event.data, 'holderStartedAt') ?? null,
  };
  const entry: WorktreeEntry = { ...existing, launch };
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: { ...state.worktrees, [worktreeId]: entry },
    inFlightMerges: state.inFlightMerges,
    inFlightPrunes: state.inFlightPrunes,
  };
}

/**
 * Removes the `launch` field of the entry for a `launch.executed` event. Other
 * fields stay the same. The field is removed, not set to `undefined`, so a
 * cleared entry equals an entry that never launched. Without a marker, the
 * function returns `state` by identity.
 */
function clearLaunchInFlight(
  state: WorktreesProjection,
  event: WorkflowEvent,
): WorktreesProjection {
  const worktreeId = extractString(event.data, 'worktreeId');
  if (!worktreeId) return state;
  const existing = state.worktrees[worktreeId];
  if (existing === undefined || existing.launch === undefined) return state;
  const { launch: _cleared, ...rest } = existing;
  const entry: WorktreeEntry = rest;
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: { ...state.worktrees, [worktreeId]: entry },
    inFlightMerges: state.inFlightMerges,
    inFlightPrunes: state.inFlightPrunes,
  };
}

/**
 * Upserts the {@link InFlightPrune} of a `prune.executing_started` event under
 * its `operationId`. Without `operationId` or `repoRoot`, it returns `state` by
 * identity.
 */
function markInFlightPrune(
  state: WorktreesProjection,
  event: WorkflowEvent,
): WorktreesProjection {
  const operationId = extractString(event.data, 'operationId');
  const repoRoot = extractString(event.data, 'repoRoot');
  if (!operationId || !repoRoot) return state;
  const prune: InFlightPrune = {
    operationId,
    repoRoot,
    holderPid: extractNumber(event.data, 'holderPid') ?? null,
    holderStartedAt: extractString(event.data, 'holderStartedAt') ?? null,
  };
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: state.worktrees,
    inFlightMerges: state.inFlightMerges,
    inFlightPrunes: { ...state.inFlightPrunes, [operationId]: prune },
  };
}

/**
 * Clears the in-flight prune of a `prune.executed` event. A terminal event for
 * an absent prune returns `state` by identity.
 */
function clearInFlightPrune(
  state: WorktreesProjection,
  event: WorkflowEvent,
): WorktreesProjection {
  const operationId = extractString(event.data, 'operationId');
  if (!operationId) return state;
  if (!Object.prototype.hasOwnProperty.call(state.inFlightPrunes, operationId)) {
    return state;
  }
  const nextInFlight: Record<string, InFlightPrune> = {};
  for (const [key, value] of Object.entries(state.inFlightPrunes)) {
    if (key !== operationId) nextInFlight[key] = value;
  }
  return {
    projectionSequence: state.projectionSequence + 1,
    worktrees: state.worktrees,
    inFlightMerges: state.inFlightMerges,
    inFlightPrunes: nextInFlight,
  };
}

/**
 * Creates a `worktrees@v1` reducer. The {@link RealpathResolver} serves the
 * fallback for an old remove event, and tests inject a resolver with no file
 * system access. The scope is `stream`, because the reducer folds the singleton
 * `worktrees` stream.
 */
export function createWorktreesReducer(
  realpath: RealpathResolver = defaultRealpath,
): ProjectionReducer<WorktreesProjection, WorkflowEvent> {
  return {
    id: 'worktrees@v1',
    version: 1,
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
        case 'launch.executing_started':
          return markLaunchInFlight(state, event);
        case 'launch.executed':
          return clearLaunchInFlight(state, event);
        case 'prune.executing_started':
          return markInFlightPrune(state, event);
        case 'prune.executed':
          return clearInFlightPrune(state, event);
        default:
          return state;
      }
    },
  };
}

/**
 * The process-wide `worktrees@v1` reducer with the default resolver. The
 * sibling `./index.ts` registers it with `defaultRegistry` at module load.
 */
export const worktreesReducer = createWorktreesReducer();
