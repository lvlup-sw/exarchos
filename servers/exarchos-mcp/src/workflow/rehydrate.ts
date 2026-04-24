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
 * Scope boundaries still in place after T032/T054:
 *   - Does NOT register the `rehydrate` action in the `exarchos_workflow`
 *     enum — that is T033.
 *   - Does NOT write a fresh snapshot when cadence fires — that is T034/T037.
 *   - Reducer-throw degradation is wired (T054, DR-18) via
 *     `buildDegradedResponse`. The matching paths for corrupt-snapshot
 *     (T055) and event-stream-unavailable (T056) reuse that helper with
 *     their own `cause` values.
 */
import * as path from 'node:path';

import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type {
  WorkflowEvent,
  WorkflowRehydrated,
  WorkflowProjectionDegraded,
} from '../event-store/schemas.js';
import { readLatestSnapshot } from '../projections/store.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import type { RehydrationDocument } from '../projections/rehydration/schema.js';
import type { ProjectionReducer } from '../projections/types.js';
import { readStateFile } from './state-store.js';

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
 * Degradation cause codes used on `workflow.projection_degraded.data.cause`.
 *
 * Centralized so T054/T055/T056 emit stable, audit-searchable enum values:
 *   - `reducer-throw`         — T054: reducer raised mid-fold (DR-18).
 *   - `snapshot-corrupt`      — T055: snapshot file failed to load/parse.
 *   - `event-stream-unavailable` — T056: eventStore.query raised.
 *
 * `WorkflowProjectionDegradedData.cause` is `z.string().min(1)` so these
 * values are not enforced at the schema layer; keeping them as a literal
 * union on the helper boundary ensures the four call sites in this module
 * cannot silently drift.
 */
export type DegradationCause =
  | 'reducer-throw'
  | 'snapshot-corrupt'
  | 'event-stream-unavailable';

/**
 * Degradation fallback-source codes used on
 * `workflow.projection_degraded.data.fallbackSource` AND on the handler's
 * `_meta.fallbackSource` so agents can cross-reference the emitted event to
 * the returned envelope.
 *
 *   - `state-store-only` — T054/T056: no reliable projection source; the
 *     fallback document is seeded from the workflow state file alone.
 *   - `full-replay`      — T055: reducer was re-run from sequence 0 because
 *     the snapshot was unusable.
 */
export type DegradationFallbackSource = 'state-store-only' | 'full-replay';

/**
 * Build a minimal rehydration document + emit `workflow.projection_degraded`
 * and return the degraded `ToolResult` envelope.
 *
 * Extracted so T055 (corrupt snapshot → full-replay) and T056 (event-stream
 * unavailable → state-store-only with a different cause) can reuse the same
 * event-emission + `_meta.degraded` wiring without duplicating the fallback
 * document construction. The `fallbackDocument` parameter lets T055 plug a
 * rebuilt-from-zero document here while T054/T056 default to a state-store
 * derived minimal doc.
 *
 * Contract:
 *   - Emits exactly one `workflow.projection_degraded` event.
 *   - Returns `success: true` — degradation is a handled outcome, not an
 *     error. Callers that want to signal failure must set their own
 *     `success: false` envelope; DR-18 explicitly classifies degradation as
 *     a successful response with reduced fidelity.
 *   - Sets `_meta.degraded: true` and `_meta.fallbackSource` on the
 *     returned ToolResult. `envelopeWrap` in `workflow/composite.ts`
 *     forwards `_meta` verbatim, so both flags surface on the agent-facing
 *     HATEOAS envelope.
 */
export async function buildDegradedResponse(
  featureId: string,
  cause: DegradationCause,
  context: RehydrateContext,
  fallbackDocument?: RehydrationDocument,
  fallbackSource: DegradationFallbackSource = 'state-store-only',
): Promise<ToolResult> {
  const { eventStore, stateDir } = context;

  const document = fallbackDocument ?? (await minimalFromStateStore(
    featureId,
    stateDir,
  ));

  const degradedData: WorkflowProjectionDegraded = {
    projectionId: REHYDRATION_PROJECTION_ID,
    cause,
    fallbackSource,
  };
  await eventStore.append(featureId, {
    type: 'workflow.projection_degraded',
    data: degradedData,
  });

  return {
    success: true,
    data: document,
    _meta: {
      degraded: true,
      fallbackSource,
    },
  };
}

/**
 * Read the workflow state file and project a schema-valid minimal
 * `RehydrationDocument`. When no state file exists (caller hit rehydrate
 * before init) or the file is corrupt, returns `reducer.initial` with the
 * featureId stamped onto `workflowState` so the document still validates
 * under `RehydrationDocumentSchema`.
 *
 * Pure of side effects beyond the single `readStateFile` read. Never throws:
 * the degradation path must not raise a secondary error. Non-StateStoreError
 * exceptions are swallowed with the same fallback shape because DR-18 treats
 * ALL secondary failures as "state-store absent" for envelope purposes — the
 * originating `cause` (`reducer-throw`, etc.) remains the authoritative
 * diagnostic on the emitted event.
 */
async function minimalFromStateStore(
  featureId: string,
  stateDir: string,
): Promise<RehydrationDocument> {
  try {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    return {
      ...rehydrationReducer.initial,
      projectionSequence: 0,
      workflowState: {
        featureId: state.featureId,
        phase: state.phase,
        workflowType: state.workflowType,
      },
    };
  } catch (err) {
    // StateStoreError is expected (STATE_NOT_FOUND / STATE_CORRUPT); any
    // other error is unexpected but still must not propagate — DR-18's
    // degradation path is a hard no-throw boundary. The emitted event's
    // `cause` (set by the caller) remains the authoritative diagnostic.
    void err;
    return {
      ...rehydrationReducer.initial,
      workflowState: {
        ...rehydrationReducer.initial.workflowState,
        featureId,
      },
    };
  }
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

  // T054 (DR-18) — reducer-throw degradation. The catch is scoped strictly
  // around `reducer.apply(...)` inside the fold so that snapshot-read and
  // event-store-query failures still propagate (the rehydrate "emit only on
  // success" invariant asserted in T032 depends on query faults bubbling).
  // T055/T056 extend the catch boundary to the snapshot-read and the
  // eventStore.query calls respectively; this task keeps the narrower scope.
  const snapshot = readLatestSnapshot(
    stateDir,
    featureId,
    REHYDRATION_PROJECTION_ID,
    REHYDRATION_PROJECTION_VERSION,
  );
  const sinceSequence = snapshot?.sequence ?? 0;
  const tailEvents = await eventStore.query(featureId, { sinceSequence });

  let document: RehydrationDocument =
    snapshot !== undefined
      ? (snapshot.state as RehydrationDocument)
      : rehydrationReducer.initial;

  try {
    for (const ev of tailEvents as unknown as WorkflowEvent[]) {
      document = rehydrationReducer.apply(document, ev);
    }
  } catch {
    // Delegate to the shared degradation helper. `reducer-throw` is the
    // authoritative cause; `buildDegradedResponse` owns the
    // minimalFromStateStore read, the event emission, and the `_meta`
    // wiring so T055/T056 can reuse this exact shape with different causes.
    return buildDegradedResponse(featureId, 'reducer-throw', {
      eventStore,
      stateDir,
    });
  }

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
