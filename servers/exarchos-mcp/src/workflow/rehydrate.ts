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
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type {
  WorkflowEvent,
  WorkflowRehydrated,
  WorkflowProjectionDegraded,
} from '../event-store/schemas.js';
import { workflowLogger } from '../logger.js';
import { rebuildProjection } from '../projections/rebuild.js';
import { readLatestSnapshot } from '../projections/store.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import {
  REHYDRATION_PROJECTION_ID,
  REHYDRATION_PROJECTION_VERSION,
} from '../projections/rehydration/identity.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../projections/rehydration/schema.js';
import { SnapshotRecord } from '../projections/snapshot-schema.js';
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
): Promise<{ state: State; lastEventSequence: number }> {
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
  // Track the highest event-store sequence the fold has absorbed — the
  // snapshot's baseline (if any) plus every tail event we apply. Callers
  // that persist a snapshot MUST record this value (not the projection's
  // internal `projectionSequence`) as the `sequence` field, otherwise a
  // later read would pass a stale `sinceSequence` to `eventStore.query`
  // and re-fetch / re-apply events the snapshot already absorbed.
  // (Sentry HIGH on PR #1178 — `projectionSequence` is a count of
  // *handled* events, but the event store sequence is monotonic over
  // ALL events, so the two values diverge whenever an unhandled event
  // type appears in the stream.)
  let lastEventSequence = sinceSequence;
  // Cast the tail through the reducer's Event type at the call boundary —
  // the event store yields `WorkflowEvent`, which is the type every registered
  // reducer narrows against. Keeping the cast here means each reducer's
  // `apply` signature drives inference inside the fold.
  for (const ev of tailEvents as unknown as Event[]) {
    state = reducer.apply(state, ev);
    const seq = (ev as unknown as { sequence?: number }).sequence;
    if (typeof seq === 'number' && seq > lastEventSequence) {
      lastEventSequence = seq;
    }
  }
  return { state, lastEventSequence };
}

/**
 * Degradation cause codes used on `workflow.projection_degraded.data.cause`.
 *
 * Centralized so T054/T055/T056 emit stable, audit-searchable enum values:
 *   - `reducer-throw`            — T054: reducer raised mid-fold (DR-18).
 *   - `snapshot-corrupt`         — T055: snapshot file failed to load/parse.
 *   - `event-stream-unavailable` — T056: eventStore.query raised.
 *
 * The wire contract is enforced by `WorkflowProjectionDegradedCause` in
 * `event-store/schemas.ts`; this union enforces the same set at the helper
 * call sites so a typo at the emission point is a compile error, not a
 * runtime Zod failure.
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
  // T056 (DR-18) — the degradation path is a hard no-throw boundary. If the
  // event store is fully offline (e.g. T056 dual-failure: both `query` AND
  // `append` fail), we still return the degraded envelope so agents retain a
  // usable document. The emission is best-effort observability; its failure
  // is logged WARN and otherwise swallowed. The handler-level `cause`
  // (event-stream-unavailable / snapshot-corrupt / reducer-throw) is the
  // authoritative diagnostic — whether it was persisted is secondary.
  try {
    await eventStore.append(featureId, {
      type: 'workflow.projection_degraded',
      data: degradedData,
    });
  } catch (err) {
    workflowLogger.warn(
      {
        featureId,
        cause,
        fallbackSource,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to append workflow.projection_degraded — continuing with degraded envelope',
    );
  }

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
 * Internal marker error for T055. Raised synthetically inside the handler's
 * snapshot-read try-block when the sidecar is present but unreadable
 * (corrupt JSON, schema-invalid record, or schema-invalid state payload).
 *
 * Not exported — it exists purely to reuse the single catch-handler path
 * for both "IO error from fs.readFileSync" and "we detected post-read that
 * the file was junk". Tests do not assert on the class identity; the
 * `workflow.projection_degraded` event's `cause: "snapshot-corrupt"` is the
 * observable contract.
 */
class SnapshotCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotCorruptError';
  }
}

/**
 * Detect whether the per-stream snapshot sidecar exists but contains any
 * unparseable JSON line or schema-invalid {@link SnapshotRecord}. Runs the
 * same read `readLatestSnapshot` does but in "strict" mode: instead of
 * skipping bad lines, we report the presence of any bad line as corruption.
 *
 * Scoped to T055's catch-boundary semantics — "corrupt" here means any of:
 *   - a JSON.parse failure on any non-empty line; OR
 *   - a SnapshotRecord schema violation on any parsed line.
 *
 * Returns `false` when the sidecar is absent (ENOENT — genuinely "no
 * snapshot yet"), when it is empty, or when every line is a valid
 * `SnapshotRecord` (in which case the "no matching projection" outcome is
 * legitimate, e.g. only older/newer projection versions exist).
 *
 * Pure except for one synchronous file read. Never throws — any unexpected
 * read failure (non-ENOENT) returns `true` so the caller still degrades.
 */
function sidecarIsCorrupt(stateDir: string, streamId: string): boolean {
  const sidecar = path.join(stateDir, `${streamId}.projections.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(sidecar, 'utf8');
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    // Any other IO error (EACCES, EIO, etc.) — treat as corrupt so the
    // caller degrades rather than crashing the rehydrate.
    return true;
  }
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return true;
    }
    if (!SnapshotRecord.safeParse(parsed).success) {
      return true;
    }
  }
  return false;
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

  // T055 (DR-18) — corrupt-snapshot degradation. The catch here is scoped
  // strictly around the snapshot-read + schema-validation step. On any
  // non-ENOENT IO error from `readLatestSnapshot`, OR detection that the
  // sidecar file has any unparseable JSON / schema-invalid records, we
  // cold-fold via `rebuildProjection` and emit `projection_degraded` with
  // `cause: "snapshot-corrupt"`, `fallbackSource: "full-replay"`.
  //
  // A TRULY missing sidecar (ENOENT) still flows through the normal path —
  // that's "no snapshot yet", not "corrupt". `readLatestSnapshot` already
  // translates ENOENT to `undefined`; a non-ENOENT IO error propagates as a
  // throw and is caught here.
  let snapshot: ReturnType<typeof readLatestSnapshot>;
  try {
    snapshot = readLatestSnapshot(
      stateDir,
      featureId,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );
    // Sidecar corruption check runs on every read, regardless of whether
    // `readLatestSnapshot` returned a usable record (CodeRabbit PR #1178).
    // The reader walks lines greedily and returns the latest valid record;
    // if a sidecar contains a mix of valid and malformed lines (truncated
    // tail, partial write, manual edit), the reader silently trusts the
    // last good line — but the file as a whole has lost the
    // append-only guarantee and a later read could surface a different
    // record depending on where the corruption falls. Detect that here and
    // degrade so the caller rebuilds from the event log instead of
    // delivering a record that may be silently superseded.
    if (sidecarIsCorrupt(stateDir, featureId)) {
      throw new SnapshotCorruptError(
        `snapshot sidecar for ${featureId} is unreadable`,
      );
    }
    // And if we DID get a snapshot, validate its state payload against the
    // rehydration schema — a schema-valid SnapshotRecord may still wrap a
    // state blob that drifted from the reducer's document shape (schema
    // mismatch counts as corrupt per DR-18).
    if (
      snapshot !== undefined &&
      !RehydrationDocumentSchema.safeParse(snapshot.state).success
    ) {
      throw new SnapshotCorruptError(
        `snapshot state for ${featureId} failed RehydrationDocumentSchema`,
      );
    }
  } catch (err) {
    workflowLogger.warn(
      {
        featureId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Snapshot read failed — degrading to full replay',
    );
    // Wrap `rebuildProjection` in its own try/catch so a failure inside
    // the cold replay (event store offline mid-rebuild, reducer throw on
    // historical event) does NOT bubble out of `handleRehydrate` and
    // crash the dispatch envelope. Falling all the way through to a
    // state-store-only response is the worst-case-but-still-actionable
    // outcome — it preserves the contract that rehydrate never throws.
    // (CodeRabbit on PR #1178: snapshot-corrupt path swallowed
    // rebuildProjection failures.)
    let rebuilt: RehydrationDocument | undefined;
    try {
      rebuilt = (await rebuildProjection(
        rehydrationReducer,
        eventStore,
        featureId,
      )) as RehydrationDocument;
    } catch (rebuildErr) {
      workflowLogger.warn(
        {
          featureId,
          err: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr),
        },
        'Full replay also failed — degrading to state-store-only',
      );
      // Both the snapshot AND the cold rebuild failed. Yield the
      // state-store-only fallback (no projection source available) and
      // record the cause as the original `snapshot-corrupt` — the
      // upstream signal — but with `fallbackSource: 'state-store-only'`
      // so observers can tell the rebuild was attempted and failed.
      return buildDegradedResponse(featureId, 'snapshot-corrupt', {
        eventStore,
        stateDir,
      });
    }
    return buildDegradedResponse(
      featureId,
      'snapshot-corrupt',
      { eventStore, stateDir },
      rebuilt,
      'full-replay',
    );
  }

  const sinceSequence = snapshot?.sequence ?? 0;
  // T056 (DR-18) — event-stream-unavailable degradation. The catch here is
  // scoped strictly around the tail query. If the event store is offline
  // (connection refused, backing file unreadable, transient IO), we have no
  // authoritative projection source, so we fall back to the workflow state
  // store only and emit `projection_degraded` with
  // `cause: "event-stream-unavailable"`, `fallbackSource: "state-store-only"`.
  // Note: the snapshot-read path (T055) stays above this try; its catch
  // boundary is disjoint from this one so a degraded snapshot does not
  // swallow a later query failure.
  let tailEvents: WorkflowEvent[];
  try {
    tailEvents = (await eventStore.query(featureId, {
      sinceSequence,
    })) as unknown as WorkflowEvent[];
  } catch (err) {
    workflowLogger.warn(
      {
        featureId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Event store query failed — degrading to state-store-only',
    );
    return buildDegradedResponse(featureId, 'event-stream-unavailable', {
      eventStore,
      stateDir,
    });
  }

  let document: RehydrationDocument =
    snapshot !== undefined
      ? (snapshot.state as RehydrationDocument)
      : rehydrationReducer.initial;

  try {
    for (const ev of tailEvents) {
      document = rehydrationReducer.apply(document, ev);
    }
  } catch (err) {
    // Log the underlying throwable BEFORE delegating so audit / oncall
    // workflows have a concrete diagnostic. The sibling
    // event-stream-unavailable + snapshot-corrupt paths log this same
    // shape; this branch was the only one swallowing the error silently
    // (CodeRabbit MEDIUM finding on PR #1178). Then delegate to the
    // shared degradation helper — `reducer-throw` is the authoritative
    // cause; `buildDegradedResponse` owns the minimalFromStateStore
    // read, the event emission, and the `_meta` wiring so T055/T056 can
    // reuse this exact shape with different causes.
    workflowLogger.warn(
      {
        featureId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Reducer threw mid-fold — degrading to state-store-only',
    );
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

  // The observability emission must NOT turn a successful hydrate into a
  // failed call. If the event store is unhealthy at write time (sidecar
  // unwritable, sequence collision, transient IO), we've still produced
  // a valid rehydration document — degrading the read because the audit
  // event couldn't be appended would be the wrong direction. Log the
  // failure with enough context for oncall and continue. (CodeRabbit on
  // PR #1178: workflow.rehydrated emission could mask a successful
  // read.)
  try {
    await eventStore.append(featureId, {
      type: 'workflow.rehydrated',
      data: rehydratedData,
    });
  } catch (err) {
    workflowLogger.warn(
      {
        featureId,
        err: err instanceof Error ? err.message : String(err),
        projectionSequence: document.projectionSequence,
        deliveryPath,
      },
      'workflow.rehydrated event append failed — read succeeds, audit gap',
    );
  }

  // The composite `envelopeWrap` (workflow/composite.ts) layers `next_actions`,
  // `_meta`, and `_perf` on top of this ToolResult at the tool boundary.
  return {
    success: true,
    data: document,
  };
}
