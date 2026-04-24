/**
 * `exarchos_workflow.rehydrate` handler — happy path (T031, DR-5).
 *
 * Loads the latest `rehydration@v1` snapshot for the given featureId, tails
 * any events written after the snapshot's sequence, folds them through the
 * rehydration reducer, and returns the canonical {@link RehydrationDocument}.
 * Envelope wrapping (DR-7) happens at the composite boundary — this handler
 * returns a raw {@link ToolResult} matching the sibling-handler convention
 * established by `handleInit` / `handleGet` (positional `(input, stateDir,
 * eventStore)` siblings; this handler bundles `stateDir` and `eventStore`
 * into a `ctx` object because it has no other positional concerns).
 *
 * Scope boundaries kept intentionally narrow for T031:
 *   - Does NOT emit `workflow.rehydrated` — that is T032.
 *   - Does NOT register the `rehydrate` action in the `exarchos_workflow`
 *     enum — that is T033.
 *   - Does NOT write a fresh snapshot when cadence fires — that is T034/T037.
 *   - `deliveryPath` is accepted on the args but unused until T032 wires it
 *     onto the `workflow.rehydrated` event payload.
 */
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { readLatestSnapshot } from '../projections/store.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import type { RehydrationDocument } from '../projections/rehydration/schema.js';
import type { ProjectionReducer } from '../projections/types.js';

/** Input shape for the rehydrate handler. */
export interface RehydrateArgs {
  readonly featureId: string;
  /**
   * Optional caller-supplied path where the rehydration document should be
   * delivered. Accepted by T031 for call-site compatibility but unused until
   * T032 threads it onto the emitted `workflow.rehydrated` event.
   */
  readonly deliveryPath?: string;
}

/** Resolved context supplied by the composite dispatcher. */
export interface RehydrateContext {
  readonly eventStore: EventStore;
  readonly stateDir: string;
}

/** Stable projection-identity pair used for snapshot lookup and future writes. */
const REHYDRATION_PROJECTION_ID = 'rehydration@v1';
const REHYDRATION_PROJECTION_VERSION = '1';

/**
 * Hydrate a projection's state by preferring the latest snapshot and folding
 * the tail of events that were written after the snapshot's sequence.
 *
 * This is the canonical warm-cache hydrate path (DR-1, DR-5). The handler
 * below delegates to it; T034 (checkpoint materialization) and T043
 * (degraded-mode fallback) will reuse this helper so the three call sites
 * share one control-flow and one trust-boundary cast on `snapshot.state`.
 *
 * Contract:
 *   - When no snapshot exists for `(streamId, projectionId, projectionVersion)`,
 *     starts from `reducer.initial` and folds the entire stream (cold-cache
 *     parity with `rebuildProjection` but via the handler's event-store
 *     query path).
 *   - When a snapshot exists, starts from `snapshot.state` and folds events
 *     strictly after `snapshot.sequence`.
 *   - The `snapshot.state` field is typed `unknown` at the snapshot-schema
 *     trust boundary; we narrow it to `State` via a single cast here rather
 *     than re-validating the shape on every hydrate call (the reducer's
 *     purity contract plus schema validation at snapshot *write* time are
 *     the integrity guarantees).
 *
 * Pure of side effects beyond the single `eventStore.query` call and one
 * synchronous snapshot sidecar read — no writes.
 */
export async function hydrateFromSnapshotThenTail<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
  stateDir: string,
  projectionId: string,
  projectionVersion: string,
): Promise<State> {
  const snapshot = readLatestSnapshot(
    stateDir,
    streamId,
    projectionId,
    projectionVersion,
  );

  const sinceSequence = snapshot?.sequence ?? 0;
  const tailEvents = await eventStore.query(streamId, { sinceSequence });

  const initialState: State =
    snapshot !== undefined
      ? (snapshot.state as State)
      : reducer.initial;

  let state = initialState;
  // Cast the tail through the reducer's Event type at the call boundary —
  // the event store yields `WorkflowEvent`, which is the type every registered
  // reducer narrows against. Keeping the cast here means each reducer's
  // `apply` signature drives inference inside the fold.
  for (const ev of tailEvents as unknown as Event[]) {
    state = reducer.apply(state, ev);
  }
  return state;
}

/**
 * Rehydrate a workflow's canonical document for the given featureId.
 *
 * Empty-stream behaviour: when no snapshot and no events exist for the
 * featureId, the handler returns `reducer.initial` with `projectionSequence:
 * 0` and `success: true`. An empty stream is a legal state (the feature has
 * not been started yet) and returning initial keeps this tool usable as a
 * cold probe without callers wrapping it in try/catch. Downstream T032/T043
 * layer on event emission and envelope affordances.
 */
export async function handleRehydrate(
  args: RehydrateArgs,
  ctx: RehydrateContext,
): Promise<ToolResult> {
  const { featureId } = args;
  const { eventStore, stateDir } = ctx;

  const document = await hydrateFromSnapshotThenTail<
    RehydrationDocument,
    WorkflowEvent
  >(
    rehydrationReducer,
    eventStore,
    featureId,
    stateDir,
    REHYDRATION_PROJECTION_ID,
    REHYDRATION_PROJECTION_VERSION,
  );

  // The composite `envelopeWrap` (workflow/composite.ts) layers `next_actions`,
  // `_meta`, and `_perf` on top of this ToolResult at the tool boundary.
  return {
    success: true,
    data: document,
  };
}
