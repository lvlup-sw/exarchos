/**
 * The `exarchos_workflow.rehydrate` handler.
 * It hydrates the {@link RehydrationDocument} of a feature from the latest rehydration snapshot and the event tail.
 * It returns a raw {@link ToolResult}, and the composite boundary wraps the envelope.
 * A reducer throw, a corrupt snapshot, and an unavailable event stream each degrade through `buildDegradedResponse`.
 * This handler does not write snapshots.
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
 * The artifact layout of a resuming workflow.
 * - `'unified'`: one spec artifact holds the design and the decomposition. A new feature gets this layout.
 * - `'two-artifact'`: a separate design doc and plan. Such a workflow must complete under this layout, without a migration.
 */
export type ArtifactLayout = 'unified' | 'two-artifact';

/**
 * Classifies the artifact layout from the event-folded artifact map. The function never reads the filesystem.
 * An artifact path that contains `dirs.specDir`, or a `spec` key, gives `'unified'`.
 * Else a `design` path that contains `dirs.legacyDesignDir` gives `'two-artifact'`. All other maps give `'unified'`.
 *
 * The match is a substring match, so nested legacy directories also classify. `dirs` defaults to the built-in directories.
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
   * The transport mode that the `workflow.rehydrated` event records: `direct`, `ndjson` or `snapshot`.
   * The default is `direct`, so an in-process caller always produces a valid event.
   */
  readonly deliveryPath?: WorkflowRehydrated['deliveryPath'];
}

/** Resolved context supplied by the composite dispatcher. */
export interface RehydrateContext {
  readonly eventStore: EventStore;
  readonly stateDir: string;
  /** The artifact directories from `.exarchos.yml`. Without them, the built-in defaults apply. */
  readonly artifactDirs?: ArtifactDirs | undefined;
}

/**
 * Hydrates a projection from its latest snapshot and the events after the snapshot sequence.
 * Without a snapshot, the fold starts at `reducer.initial` and covers the whole stream.
 * The function casts `snapshot.state` to `State` and does not validate it. It does not write.
 *
 * `lastEventSequence` is the highest absorbed store sequence. A caller that persists a snapshot must record it as `sequence`.
 * `projectionSequence` counts only handled events. A snapshot with that value makes a later read apply events again.
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
  let lastEventSequence = sinceSequence;
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
 * The cause codes of `workflow.projection_degraded`.
 * - `reducer-throw`: the reducer threw during the fold.
 * - `snapshot-corrupt`: the snapshot read failed, or the snapshot state failed the schema.
 * - `event-stream-unavailable`: the event store query threw.
 *
 * `WorkflowProjectionDegradedCause` holds the wire contract. This union catches a typo at compile time.
 */
export type DegradationCause =
  | 'reducer-throw'
  | 'snapshot-corrupt'
  | 'event-stream-unavailable';

/**
 * The fallback source on `workflow.projection_degraded` and on `_meta.fallbackSource`.
 * - `state-store-only`: the document comes only from the workflow state file.
 * - `full-replay`: the reducer ran again from sequence 0, because the snapshot was not usable.
 */
export type DegradationFallbackSource = 'state-store-only' | 'full-replay';

/**
 * Appends `workflow.projection_degraded` and returns a degraded result.
 * Without `fallbackDocument`, a minimal document comes from the state file.
 * The result has `success: true`, because degradation is a handled outcome with less fidelity.
 * It sets `_meta.degraded` and `_meta.fallbackSource`. The function never throws.
 * When the append fails, it logs a warning and still returns the result.
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
  try {
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
 * Projects a minimal, schema-valid `RehydrationDocument` from the workflow state file.
 * On any error, it returns `reducer.initial` with the `featureId`.
 * It never throws, because the degradation path must not raise a second error.
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
 * Marks a snapshot whose `state` fails the rehydration document schema.
 * It sends that failure to the same catch path as a backend read error.
 */
class SnapshotCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotCorruptError';
  }
}

/**
 * Rehydrates the canonical document of a feature.
 * A snapshot read error, or snapshot state that fails the schema, degrades to a full replay with `snapshot-corrupt`.
 * If that replay fails too, the state file is the only source. A missing read backend means no snapshot, not corruption.
 * A failed tail query or a reducer throw also degrades to the state file only.
 *
 * A snapshot past the durable event tail is discarded. The stream is folded again, and `_meta` marks the projection degraded.
 * An empty stream gives `_meta.workflowExists: false` and appends no event.
 * Thus a cold probe creates no phantom workflow. Otherwise the handler appends `workflow.rehydrated`, and an append failure only logs.
 *
 * `_meta` carries the existence, layout, source, and freshness signals, because the document schema rejects unknown keys.
 */
export async function handleRehydrate(
  args: RehydrateArgs,
  ctx: RehydrateContext,
): Promise<ToolResult> {
  const { featureId } = args;
  const { eventStore, stateDir, artifactDirs } = ctx;

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

  const sinceSequence = plan.sinceSequence;
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

  let document: RehydrationDocumentV4 =
    plan.seedFromSnapshot && snapshot !== undefined
      ? loadRehydrationDocument(snapshot.state)
      : (rehydrationReducer.initial as RehydrationDocumentV4);

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

  document = {
    ...document,
    phasePlaybook: composePhasePlaybook(
      document.workflowState.workflowType,
      document.workflowState.phase,
    ),
  };

  const deliveryPath: WorkflowRehydrated['deliveryPath'] =
    args.deliveryPath ?? 'direct';

  const tokenEstimate = Math.ceil(JSON.stringify(document).length / 4);

  const phasePlaybookPresent = document.phasePlaybook !== null;

  const rehydratedData: WorkflowRehydrated = {
    projectionSequence: document.projectionSequence,
    deliveryPath,
    tokenEstimate,
    phaseHasPlaybook: phasePlaybookPresent,
    phasePlaybookComposed: phasePlaybookPresent,
  };

  const streamIsEmpty = snapshot === undefined && tailEvents.length === 0;

  if (!streamIsEmpty) {
    try {
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

  const meta: Record<string, unknown> = {
    workflowExists: !streamIsEmpty,
    artifactLayout: classifyArtifactLayout(document.artifacts, artifactDirs),
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
