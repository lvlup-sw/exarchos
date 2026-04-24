/**
 * `exarchos_workflow.rehydrate` handler — happy path (T031, DR-5) with
 * emission of `workflow.rehydrated` on success (T032, DR-4).
 *
 * Loads the latest `rehydration@v1` snapshot for the given featureId, tails
 * any events written after the snapshot's sequence, folds them through the
 * rehydration reducer, and returns the canonical {@link RehydrationDocument}.
 * On successful hydrate, appends a `workflow.rehydrated` event to the stream
 * carrying `{ projectionSequence, deliveryPath, tokenEstimate }` per the
 * registered schema in `event-store/schemas.ts` (T008). Envelope wrapping
 * (DR-7) happens at the composite boundary — this handler returns a raw
 * {@link ToolResult} matching the sibling-handler convention established by
 * `handleInit` / `handleGet` (positional `(input, stateDir, eventStore)`
 * siblings; this handler bundles `stateDir` and `eventStore` into a `ctx`
 * object because it has no other positional concerns).
 *
 * Scope boundaries still in place after T032:
 *   - Does NOT register the `rehydrate` action in the `exarchos_workflow`
 *     enum — that is T033.
 *   - Does NOT write a fresh snapshot when cadence fires — that is T034/T037.
 *   - Failure paths (snapshot corrupt, reducer throw) do not yet emit
 *     `workflow.projection_degraded` — that is T043.
 */
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type {
  WorkflowEvent,
  WorkflowRehydrated,
} from '../event-store/schemas.js';
import { readLatestSnapshot } from '../projections/store.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import type { RehydrationDocument } from '../projections/rehydration/schema.js';
import type { ProjectionReducer } from '../projections/types.js';

/** Input shape for the rehydrate handler. */
export interface RehydrateArgs {
  readonly featureId: string;
  /**
   * Transport mode for the rehydration document, recorded on the emitted
   * `workflow.rehydrated` event (`WorkflowRehydratedData.deliveryPath`).
   *
   * Narrowed to the enum registered in `event-store/schemas.ts`:
   *   - `"direct"`  — document returned by value (in-process / MCP direct).
   *   - `"ndjson"`  — streamed line-by-line over a transport boundary.
   *   - `"snapshot"` — materialized from a snapshot file (cold reload).
   *
   * Defaults to `"direct"` when omitted so that in-process callers (tests,
   * CLI hosts that embed the handler directly) always produce a schema-valid
   * event without plumbing a mode through every call site.
   */
  readonly deliveryPath?: WorkflowRehydrated['deliveryPath'];
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

  // T032 — on successful hydrate, record an observability event with the
  // canonical payload from `WorkflowRehydratedData` (T008):
  //   { projectionSequence, deliveryPath, tokenEstimate }
  // Emission happens AFTER the fold so a failing hydrate (reducer throw,
  // snapshot corrupt — future T043) never double-counts. We deliberately do
  // not pass featureId / timestamp inside `data`: streamId is the outer
  // envelope key and timestamp is stamped by `EventStore.append`.
  const deliveryPath: WorkflowRehydrated['deliveryPath'] =
    args.deliveryPath ?? 'direct';

  // Rough GPT-style approximation (~4 chars / token) on the serialized
  // document. Kept inline — this is the sole consumer and a shared helper
  // would add indirection for a one-line heuristic. Integer-rounded to
  // satisfy `z.number().int().nonnegative()` on the schema.
  const tokenEstimate = Math.ceil(JSON.stringify(document).length / 4);

  const rehydratedData: WorkflowRehydrated = {
    projectionSequence: document.projectionSequence,
    deliveryPath,
    tokenEstimate,
  };

  await eventStore.append(featureId, {
    type: 'workflow.rehydrated',
    data: rehydratedData,
  });

  // The composite `envelopeWrap` (workflow/composite.ts) layers `next_actions`,
  // `_meta`, and `_perf` on top of this ToolResult at the tool boundary.
  return {
    success: true,
    data: document,
  };
}
