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

import type { EventStore } from '../events/store.js';
import type { ToolResult } from '../format.js';
import type {
  WorkflowEvent,
  WorkflowRehydrated,
  WorkflowProjectionDegraded,
} from '../events/schemas.js';
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
  type RehydrationDocumentV4,
} from '../projections/rehydration/schema.js';
import { loadRehydrationDocument } from '../projections/rehydration/serialize.js';
import type { ProjectionReducer } from '../projections/types.js';
import { composePhasePlaybook } from './playbooks.js';
import { readStateFile } from './state-store.js';
import { buildValidatedEvent } from '../events/event-factory.js';
import { PROJECTION_LAG_THRESHOLD_MS } from '../projections/index.js';
import {
  PROJECTION_DEGRADED_META,
  toProjectionDegradedMeta,
} from '../projections/freshness.js';
import { planRehydrationSource } from './rehydrate-precedence.js';
import { DEFAULT_ARTIFACT_DIRS, type ArtifactDirs } from '../config/artifacts.js';

/**
 * Artifact layout of a resuming workflow (DR-9, #1581 task 020).
 *
 *   - `'unified'`      — the post-collapse flow: one `docs/specs/` artifact
 *     (design § + decomposition in one doc). The forward default — a freshly
 *     `init`'d feature with no artifacts yet is `'unified'`, so new work always
 *     uses the collapsed path.
 *   - `'two-artifact'` — an in-flight workflow authored under the pre-#1581
 *     two-phase convention: a separate `docs/designs/` design doc plus a
 *     `docs/plans/` plan. Such a workflow MUST resume and complete under the
 *     OLD path — no forced mid-flight migration to `docs/specs/`.
 */
export type ArtifactLayout = 'unified' | 'two-artifact';

/**
 * Classify a workflow's artifact layout from its recorded artifact map
 * (DR-9, task 020). Pure — reads only the projected `artifacts` record, never
 * the filesystem (a resuming workflow's path of record is the event-folded
 * artifact map, not what happens to exist on disk).
 *
 * Discrimination order (first match wins):
 *   1. Any artifact under `dirs.specDir`, or an explicit `spec` key ⇒ `'unified'`
 *      (the workflow already adopted the collapsed artifact — keep it there).
 *   2. A `design` artifact under `dirs.legacyDesignDir` ⇒ `'two-artifact'` (it
 *      started under the old convention; the new flow never produces that path,
 *      so its presence is the legacy signal — complete old-path, do not migrate).
 *   3. Otherwise ⇒ `'unified'` (the forward default: fresh features with no
 *      artifacts yet, and any future layout, use the collapsed path).
 *
 * Both prefixes arrive by injection rather than as module literals (DR-6), so a
 * project that keeps its specs elsewhere classifies against its own layout.
 * Purity survives: `dirs` is a value, not a config read. Callers that have no
 * resolved config get the built-in defaults, which is why omitting the argument
 * is byte-identical to the pre-DR-6 behaviour.
 *
 * Prefix match, not exact-dir, so nested or date-partitioned legacy layouts
 * (`docs/designs/2026-…`) still classify.
 */
export function classifyArtifactLayout(
  artifacts: Readonly<Record<string, string>>,
  dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS,
): ArtifactLayout {
  const values = Object.values(artifacts);
  const hasUnifiedSpec =
    typeof artifacts.spec === 'string' ||
    values.some((p) => p.includes(dirs.specDir));
  if (hasUnifiedSpec) return 'unified';

  const designPath = artifacts.design;
  if (typeof designPath === 'string' && designPath.includes(dirs.legacyDesignDir)) {
    return 'two-artifact';
  }

  return 'unified';
}

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
  /**
   * Artifact directories resolved from the project's `.exarchos.yml` (DR-6).
   * Optional so in-process callers (tests, embedded CLI hosts) need not plumb
   * config through; omitting it uses the built-in defaults.
   */
  readonly artifactDirs?: ArtifactDirs | undefined;
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
  _stateDir: string,
  projectionId: string,
  projectionVersion: string,
): Promise<{ state: State; lastEventSequence: number }> {
  const snapshot = readLatestSnapshot(
    eventStore.getReadBackend(),
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
    // #1325 — route through buildValidatedEvent for defense-in-depth
    // Zod validation. `featureId` is the workflow-stream identifier and
    // the audit event correlates back to it (consistent with the
    // pattern in hsm-transition-guard.ts and tools.ts emissions).
    const validatedEvent = buildValidatedEvent(featureId, 1, {
      type: 'workflow.projection_degraded',
      correlationId: featureId,
      source: 'workflow',
      data: degradedData,
    });
    await eventStore.appendValidated(featureId, validatedEvent);
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
 * snapshot-read try-block when a snapshot was returned but its `state`
 * payload fails the rehydration document schema (post-#1343 the JSONL
 * "valid record alongside malformed lines" failure mode is gone — the
 * SQLite substrate's row is either schema-valid or invisible to the
 * reader, so the only remaining corruption signal is state-shape drift).
 *
 * Not exported — it exists purely to reuse the single catch-handler path
 * for backend IO errors and post-read schema failures. Tests do not assert
 * on the class identity; the `workflow.projection_degraded` event's
 * `cause: "snapshot-corrupt"` is the observable contract.
 */
class SnapshotCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotCorruptError';
  }
}

/**
 * Rehydrate a workflow's canonical document for the given featureId.
 *
 * Empty-stream behaviour: when no snapshot and no events exist for the
 * featureId, the handler returns `reducer.initial` with `projectionSequence:
 * 0` and `success: true`. An empty stream is a legal state (the feature has
 * not been started yet) and returning initial keeps this tool usable as a
 * cold probe without callers wrapping it in try/catch. The probe is
 * side-effect-free: NO `workflow.rehydrated` event is emitted for an empty
 * stream (CB-2 — emitting one would materialize a phantom workflow), and the
 * envelope carries `_meta.workflowExists: false` so callers can distinguish
 * "never existed" from "tracked but empty" without reading the filesystem.
 * Downstream T032/T043 layer on event emission and envelope affordances.
 */
export async function handleRehydrate(
  args: RehydrateArgs,
  ctx: RehydrateContext,
): Promise<ToolResult> {
  const { featureId } = args;
  const { eventStore, stateDir, artifactDirs } = ctx;

  // T055 (DR-18) — corrupt-snapshot degradation. Scoped strictly around the
  // snapshot-read + schema-validation step. Three failure modes degrade to
  // `rebuildProjection` with `cause: "snapshot-corrupt"`:
  //
  //   1. The backend's snapshot read throws (e.g. SQLite IO error mid-read).
  //   2. The backend returned a row whose payload fails `SnapshotRecord`
  //      validation (`readLatestSnapshot` translates this to `undefined`,
  //      so the JSONL-era "valid record alongside malformed lines" mode
  //      collapses post-#1343 — the row is either valid or invisible).
  //   3. The snapshot's `state` payload deserialises but fails the
  //      `RehydrationDocumentSchema` shape check below (schema drift).
  //
  // A genuinely missing snapshot returns `undefined` and flows through the
  // normal path — that's "no snapshot yet", not "corrupt".
  //
  // Backend acquisition failures (e.g. test stubs that don't expose
  // `getReadBackend`, or partially-initialised event stores) are NOT
  // classified as snapshot corruption — they fall through to the
  // event-stream-unavailable path below, since "no backend" implies the
  // event store is not in a state to serve any reads.
  let snapshot: ReturnType<typeof readLatestSnapshot>;
  let backend: ReturnType<EventStore['getReadBackend']> | undefined;
  try {
    backend = typeof eventStore.getReadBackend === 'function'
      ? eventStore.getReadBackend()
      : undefined;
  } catch {
    backend = undefined;
  }
  try {
    snapshot = backend !== undefined
      ? readLatestSnapshot(
          backend,
          featureId,
          REHYDRATION_PROJECTION_ID,
          REHYDRATION_PROJECTION_VERSION,
        )
      : undefined;
    // Schema check on the recovered state payload — a SnapshotRecord whose
    // `state` blob drifted from the reducer's document shape counts as
    // corrupt per DR-18.
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

  // P04-06 (EFF-004) — deterministic fallback precedence. Read the durable
  // event tail (a cheap MAX(sequence)) so we can decide whether the recovered
  // snapshot may be trusted, per `REHYDRATION_SOURCE_PRECEDENCE`. A snapshot
  // whose cursor sits PAST the tail (projection-ahead — a snapshot restored over
  // a pruned/rebuilt store) must never be served silently: `planRehydrationSource`
  // routes it to a full replay from the authoritative log and flags the result
  // degraded. A snapshot that merely lags the tail is folded forward. If the
  // backend cannot answer `tailSequence` we degrade the CHECK (not the read) to
  // the historical warm-cache behaviour rather than fabricate a signal.
  let eventTail: number | undefined;
  try {
    eventTail =
      typeof eventStore.tailSequence === 'function'
        ? await eventStore.tailSequence(featureId)
        : undefined;
  } catch {
    eventTail = undefined;
  }

  const plan = planRehydrationSource({
    hasSnapshot: snapshot !== undefined,
    snapshotCursor: snapshot?.sequence ?? 0,
    eventTail,
    viewName: REHYDRATION_PROJECTION_ID,
  });

  // `sinceSequence` follows the plan: the snapshot cursor when the snapshot is
  // trusted as a baseline (fresh or behind), else 0 — a cold fold or a full
  // replay after a contradictory snapshot was discarded.
  const sinceSequence = plan.sinceSequence;
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

  // Route v:1/v:2/v:3 snapshots through the upgrade chain so the in-memory
  // document is always v:4 — handler-time `phasePlaybook` composition (T-20)
  // and the #1359 canonical task-status vocabulary both assume the v:4
  // envelope shape. Cold-start (no snapshot) seeds from the reducer's v:4
  // initial directly. Reducer.apply preserves v:4 by contract; the cast
  // below pins that for the local variable.
  //
  // P04-06 (EFF-004): only seed from the snapshot when the plan trusts it
  // (`seedFromSnapshot`). When the snapshot contradicted the durable tail
  // (projection-ahead) the plan sets `seedFromSnapshot: false` and
  // `sinceSequence: 0`, so we discard the snapshot state and re-fold the whole
  // stream from the authoritative log — never serving the stale projection.
  let document: RehydrationDocumentV4 =
    plan.seedFromSnapshot && snapshot !== undefined
      ? loadRehydrationDocument(snapshot.state)
      : (rehydrationReducer.initial as RehydrationDocumentV4);

  // Track the ISO timestamp of the last folded event so the handler can
  // surface `projectionAsOf` on the response (#1359 / PR4 T14) and
  // `_meta.projectionLag` when stale (T15). Snapshot.timestamp is the
  // most-recent-event-baked-into-the-snapshot timestamp; tail events
  // overwrite it on every successful fold. A discarded (projection-ahead)
  // snapshot contributes no baseline timestamp — `projectionAsOf` is then
  // driven purely by the re-folded events.
  let projectionAsOf: string | undefined =
    plan.seedFromSnapshot &&
    snapshot !== undefined &&
    typeof snapshot.timestamp === 'string'
      ? snapshot.timestamp
      : undefined;

  try {
    for (const ev of tailEvents) {
      document = rehydrationReducer.apply(document, ev) as RehydrationDocumentV4;
      if (typeof ev.timestamp === 'string') projectionAsOf = ev.timestamp;
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

  // T-20 — compose phasePlaybook from the L4 registry. After the fold and
  // BEFORE the `workflow.rehydrated` emission so the audit event's
  // `tokenEstimate` reflects the composed envelope. The helper returns
  // null for terminal / unregistered (workflowType, phase) pairs; we
  // surface that as `phasePlaybook: null` rather than omitting the field
  // (the v:3 schema requires its presence). Pure additive composition —
  // degraded paths (T-22) keep the reducer.initial null and are unchanged.
  document = {
    ...document,
    phasePlaybook: composePhasePlaybook(
      document.workflowState.workflowType,
      document.workflowState.phase,
    ),
  };

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

  // T-21 — surface playbook-presence flags on the audit event.
  //   `phaseHasPlaybook`     — was a playbook registered for this
  //                            (workflowType, phase) pair? (registry signal)
  //   `phasePlaybookComposed` — did the handler actually attach it to the
  //                            returned document? (handler signal)
  // On the happy path both flags collapse to `phasePlaybook !== null`.
  // T-22 (degraded paths) and T-23 (checkpoint composition) will diverge
  // them so observability can distinguish "registry had it" from
  // "this response carried it".
  const phasePlaybookPresent = document.phasePlaybook !== null;

  const rehydratedData: WorkflowRehydrated = {
    projectionSequence: document.projectionSequence,
    deliveryPath,
    tokenEstimate,
    phaseHasPlaybook: phasePlaybookPresent,
    phasePlaybookComposed: phasePlaybookPresent,
  };

  // CB-2 (RCA 2026-05-30-state-source-integrity) — a cold probe of a
  // never-`init`'d feature (no snapshot AND no events) must be side-effect-
  // free. Emitting `workflow.rehydrated` here would materialize a phantom
  // stream — a lone audit event with no `workflow.started`, no
  // `workflow_state` / `streams` row — which pollutes the store and later
  // surfaces as a phantom workflow in the pipeline view. The documented
  // cold-probe contract (success:true + reducer.initial) is preserved; only
  // the emission is suppressed, and `_meta.workflowExists` (below) carries the
  // existence signal so callers never have to infer existence from disk.
  const streamIsEmpty = snapshot === undefined && tailEvents.length === 0;

  // The observability emission must NOT turn a successful hydrate into a
  // failed call. If the event store is unhealthy at write time (sidecar
  // unwritable, sequence collision, transient IO), we've still produced
  // a valid rehydration document — degrading the read because the audit
  // event couldn't be appended would be the wrong direction. Log the
  // failure with enough context for oncall and continue. (CodeRabbit on
  // PR #1178: workflow.rehydrated emission could mask a successful
  // read.)
  if (!streamIsEmpty) {
    try {
      // #1325 — route through buildValidatedEvent for defense-in-depth
      // Zod validation. `featureId` is the workflow-stream identifier;
      // the audit event correlates back to it.
      const validatedEvent = buildValidatedEvent(featureId, 1, {
        type: 'workflow.rehydrated',
        correlationId: featureId,
        source: 'workflow',
        data: rehydratedData,
      });
      await eventStore.appendValidated(featureId, validatedEvent);
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
  }

  // #1359 / PR4 T14 + T15 — surface `projectionAsOf` and
  // `_meta.projectionLag` so agents can detect a stale projection. The
  // composite `envelopeWrap` (workflow/composite.ts) merges per-handler
  // `_meta` with its own per-call diagnostics; passing `_meta` here lets
  // the projection-lag signal flow through to the final envelope.
  //
  // We piggyback `projectionAsOf` onto `_meta` rather than the document
  // body because RehydrationDocumentSchema's volatile section is strict
  // and rejects unknown sibling keys (additional top-level fields would
  // require a schema bump; envelope metadata is the existing surface for
  // diagnostic side-channels — see ToolResult._meta in format.ts).
  //
  // `_meta.workflowExists` (CB-2) gives callers an unambiguous existence
  // signal — `true` when the stream had a snapshot or any events, `false` for
  // a cold probe of a never-started feature — so agents disambiguate "tracked
  // but empty" from "never existed" without inspecting filesystem
  // `.state.json` presence (see RCA 2026-05-30-state-source-integrity).
  // #1581 task 020 — surface the artifact layout so a resuming agent (and the
  // collapsed-flow playbook/tooling) completes an in-flight two-artifact
  // workflow under the OLD path instead of forcing a mid-flight migration to
  // `docs/specs/`. Classified from the event-folded artifact map (never disk);
  // a fresh feature with no artifacts defaults to `'unified'`, so only work
  // that genuinely started two-phase is flagged legacy. Kept on `_meta` (like
  // `workflowExists`) — no event-schema bump, forwarded verbatim by envelopeWrap.
  const meta: Record<string, unknown> = {
    workflowExists: !streamIsEmpty,
    artifactLayout: classifyArtifactLayout(document.artifacts, artifactDirs),
    // P04-06 (EFF-004) — surface the source the deterministic precedence chose
    // (`event-fold` / `summary-snapshot`) so callers can see WHICH authoritative
    // surface answered, not just that the read succeeded. Makes the declared
    // precedence observable at the envelope boundary, not just in the pure
    // planner. Forwarded verbatim by envelopeWrap alongside `workflowExists`.
    rehydrationSource: plan.source,
  };
  if (projectionAsOf !== undefined) {
    meta.projectionAsOf = projectionAsOf;
    const asOfMs = Date.parse(projectionAsOf);
    if (Number.isFinite(asOfMs)) {
      const lag = Date.now() - asOfMs;
      if (lag > PROJECTION_LAG_THRESHOLD_MS) {
        meta.projectionLag = lag;
      }
    }
  }

  // P04-06 (EFF-004) — when the cached snapshot CONTRADICTED the durable event
  // tail (projection-ahead), the plan discarded it and re-folded from the
  // authoritative log above. The returned `document` is therefore event-derived
  // and trustworthy, but the CACHE was stale/contradictory, so we stamp the
  // P01-02 freshness verdict on `_meta.projectionDegraded` — the SAME durable
  // degradation signal the view surface uses (see `views/composite.ts`) — rather
  // than inventing a second one. This guarantees a contradictory projection is
  // never silently trusted: the answer is authoritative AND explicitly flagged.
  if (plan.degraded && plan.freshness !== undefined) {
    const degradedMeta = toProjectionDegradedMeta(plan.freshness);
    if (degradedMeta !== undefined) {
      meta[PROJECTION_DEGRADED_META] = degradedMeta;
    }
  }

  return {
    success: true,
    data: document,
    _meta: meta,
  };
}
