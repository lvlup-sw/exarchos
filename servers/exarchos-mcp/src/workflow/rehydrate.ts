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

  // Step 1/2 — snapshot lookup. Missing/corrupt/version-skewed snapshots
  //   return `undefined` here; the reducer's `initial` then becomes the
  //   starting state for a full tail-replay at Step 4.
  const snapshot = readLatestSnapshot(
    stateDir,
    featureId,
    REHYDRATION_PROJECTION_ID,
    REHYDRATION_PROJECTION_VERSION,
  );

  // Step 3 — tail events strictly after the snapshot's sequence. The
  //   `sinceSequence` filter is inclusive-exclusive at the store boundary;
  //   empty streams return `[]` and the fold becomes identity over initial.
  const sinceSequence = snapshot?.sequence ?? 0;
  const tailEvents = await eventStore.query(featureId, { sinceSequence });

  // Step 4 — fold. Start from the snapshot state when present (validated
  //   shape at write time by `appendSnapshot`; at read time the sidecar
  //   Zod schema gatekeeps `snapshot.state` as `unknown`, so we narrow to
  //   `RehydrationDocument` via a single cast at the trust boundary).
  const initialState: RehydrationDocument =
    snapshot !== undefined
      ? (snapshot.state as RehydrationDocument)
      : rehydrationReducer.initial;

  let state = initialState;
  for (const ev of tailEvents as WorkflowEvent[]) {
    state = rehydrationReducer.apply(state, ev);
  }

  // Step 5 — return the canonical document. The composite `envelopeWrap`
  //   layers `next_actions` / `_meta` / `_perf` on top.
  return {
    success: true,
    data: state,
  };
}
