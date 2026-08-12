import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { appendSnapshot, readLatestSnapshot } from '../projections/store.js';
import { rebuildProjection, projectAt } from '../projections/rebuild.js';
import {
  REHYDRATION_PROJECTION_ID,
  REHYDRATION_PROJECTION_VERSION,
} from '../projections/rehydration/identity.js';
import { handleInit, handleCheckpoint } from './tools.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../projections/rehydration/schema.js';
import type {
  WorkflowRehydrated,
  WorkflowProjectionDegraded,
  WorkflowEvent,
} from '../events/schemas.js';
// Importing this barrel has a side effect: it registers the rehydration
// reducer with the process-wide default registry. Import so the handler's
// registry-based resolution works during this test file.
import '../projections/rehydration/index.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import { initStateFile } from './state-store.js';

import {
  handleRehydrate,
  classifyArtifactLayout,
  hydrateFromSnapshotThenTail,
} from './rehydrate.js';

/**
 * T031 — `handleRehydrate` happy path
 *
 * Implements DR-5: the rehydrate handler loads the latest snapshot for the
 * `rehydration@v1` projection, tails events since the snapshot's sequence,
 * folds them through the rehydration reducer, and returns the canonical
 * {@link RehydrationDocument}. Envelope wrapping happens at the composite
 * boundary (see `workflow/composite.ts` — `envelopeWrap`), so the handler
 * itself returns a `ToolResult`-shaped value with `data` as the raw
 * document (matching sibling handlers like `handleInit` / `handleGet`).
 */

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'rehydrate-handler-test-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('handleRehydrate — happy path (T031, DR-5)', () => {
  it('RehydrateHandler_KnownFeatureId_ReturnsEnvelopedDocument', async () => {
    // GIVEN: a stream seeded with `workflow.started` + several task.* events
    //   and NO existing snapshot on disk (cold-cache path).
    const featureId = 'rehydrate-foundation';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T001' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T001' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T002' },
    });

    // WHEN: we invoke the handler with the featureId.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: the handler returns a successful ToolResult whose `data` is a
    //   schema-valid canonical rehydration document.
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    const parsed = RehydrationDocumentSchema.safeParse(doc);
    expect(parsed.success).toBe(true);

    expect(doc.v).toBe(4);
    // Every seeded event is handled by the rehydration reducer, so
    // `projectionSequence` must match the count of events.
    expect(doc.projectionSequence).toBe(4);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');

    // taskProgress reflects the folded task.* events. T001 is terminal
    // (completed) and T002 is still assigned — this exercises the reducer's
    // per-task upsert contract through the handler.
    expect(doc.taskProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'T001', status: 'complete' }),
        expect.objectContaining({ id: 'T002', status: 'in_progress' }),
      ]),
    );
  });

  it('RehydrateHandler_WithSnapshot_UsesSnapshotPlusTail', async () => {
    // GIVEN: a stream of 8 events, and a snapshot at sequence=5 produced by
    //   folding the first 5 events. The handler must start from the snapshot
    //   state and fold only events strictly after sequence 5.
    const featureId = 'wf-with-snapshot';

    // Prefix events (seq 1..5) — fold these manually to produce the snapshot.
    const prefixEvents = [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      { type: 'workflow.transition', data: { from: 'design', to: 'tdd' } },
      { type: 'task.assigned', data: { taskId: 'T100' } },
      { type: 'task.completed', data: { taskId: 'T100' } },
      { type: 'task.assigned', data: { taskId: 'T101' } },
    ] as const;
    for (const ev of prefixEvents) {
      await store.append(featureId, ev);
    }

    // Build the snapshot by querying and folding the prefix — avoids hand-
    // rolling a RehydrationDocument shape that would drift from the schema.
    const { rehydrationReducer } = await import(
      '../projections/rehydration/reducer.js'
    );
    const prefix = await store.query(featureId);
    let snapshotState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of prefix) {
      snapshotState = rehydrationReducer.apply(snapshotState, ev);
    }

    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 5,
      state: snapshotState,
      timestamp: new Date().toISOString(),
    });

    // Tail events (seq 6..8): three additional events that must be folded
    // over the snapshot state.
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T101' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T102' },
    });
    await store.append(featureId, {
      type: 'task.failed',
      data: { taskId: 'T102' },
    });

    // WHEN: we invoke the handler.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: the handler returns a document whose projectionSequence equals
    //   the snapshot's sequence (5) plus the 3 tail events = 8.
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.projectionSequence).toBe(8);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.phase).toBe('tdd');

    // Tail folded state: T100 stays complete; T101 promoted in_progress →
    // complete by tail; T102 added-then-failed by tail. Canonical
    // vocabulary post #1359 / PR4 T11.
    const byId = new Map(doc.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T100')).toBe('complete');
    expect(byId.get('T101')).toBe('complete');
    expect(byId.get('T102')).toBe('failed');
  });

  it('RehydrateHandler_UnknownFeatureId_ReturnsInitialDocument', async () => {
    // GIVEN: no events for this featureId and no snapshot. An empty stream
    //   is a legal state (feature hasn't been started yet) so the handler
    //   returns reducer.initial rather than raising — see completion report
    //   for rationale. This lets callers use rehydrate as a "cold read"
    //   probe without a try/catch.
    const result = await handleRehydrate(
      { featureId: 'never-existed' },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.v).toBe(4);
    expect(doc.projectionSequence).toBe(0);
    expect(doc.taskProgress).toEqual([]);
    expect(doc.blockers).toEqual([]);
    // Initial document still validates under the schema.
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

/**
 * CB-2 (RCA 2026-05-30-state-source-integrity) — a cold probe of a
 * never-`init`'d featureId must be SIDE-EFFECT-FREE.
 *
 * The documented cold-probe contract (success:true + reducer.initial) is
 * preserved, but the handler must NOT emit `workflow.rehydrated` into a
 * previously-empty stream — doing so materializes a phantom workflow (a stream
 * with a lone `workflow.rehydrated` event, no `workflow.started`, no
 * `workflow_state` / `streams` row). It must also surface
 * `_meta.workflowExists` so callers can disambiguate "tracked but empty" from
 * "never existed" without inspecting the filesystem.
 */
describe('handleRehydrate — cold probe is side-effect-free (CB-2)', () => {
  it('RehydrateHandler_ColdProbeOfNonExistentFeature_EmitsNoEventAndFlagsAbsent', async () => {
    // GIVEN: a featureId that was never init'd — no snapshot, no events.
    const featureId = 'never-init-cold-probe';

    // WHEN: an agent probes it (e.g. /exarchos:rehydrate with an inferred id).
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: success:true cold-probe contract is preserved …
    expect(result.success).toBe(true);
    // … but NO event was written to the previously-empty stream …
    const all = await store.query(featureId);
    expect(all).toHaveLength(0);
    // … and the envelope flags the feature as non-existent.
    expect(result._meta?.workflowExists).toBe(false);
  });

  it('RehydrateHandler_ProbeOfExistingFeature_FlagsPresentAndStillEmits', async () => {
    // GIVEN: a real, started workflow stream.
    const featureId = 'exists-warm-probe';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    // WHEN: we rehydrate it.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: existence is flagged true and the audit event STILL fires — the
    //   emission suppression is scoped to empty streams only.
    expect(result.success).toBe(true);
    expect(result._meta?.workflowExists).toBe(true);
    const all = await store.query(featureId);
    expect(all.filter((e) => e.type === 'workflow.rehydrated')).toHaveLength(1);
  });
});

/**
 * T032 — `handleRehydrate` emits `workflow.rehydrated`
 *
 * Implements DR-4 (new event types) and DR-5 (rehydrate MCP action). On a
 * successful rehydrate the handler must append a `workflow.rehydrated` event
 * to the stream with the canonical data payload
 *   `{ projectionSequence, deliveryPath, tokenEstimate }`
 * registered at `event-store/schemas.ts` (T008, `WorkflowRehydratedData`).
 *
 * The `deliveryPath` field (enum `direct|ndjson|snapshot`) is carried from
 * the handler args so CLI / MCP / session-start call sites can differentiate
 * transport. When the arg is omitted the handler defaults to `"direct"` —
 * the natural mode for a programmatic in-process call where the document is
 * returned by value rather than streamed or mounted from a snapshot file.
 */
describe('handleRehydrate — emits workflow.rehydrated (T032, DR-4, DR-5)', () => {
  it('RehydrateHandler_OnSuccess_EmitsRehydratedEvent', async () => {
    // GIVEN: a stream seeded with four events, matching the T031 happy-path
    //   shape. `projectionSequence` after fold should be 4.
    const featureId = 'rehydrate-emits-event';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T200' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T200' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T201' },
    });

    const deliveryPath: WorkflowRehydrated['deliveryPath'] = 'direct';

    // WHEN: we invoke the handler with an explicit deliveryPath arg.
    const result = await handleRehydrate(
      { featureId, deliveryPath },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    // THEN: querying the stream yields the four seeded events plus exactly
    //   one new `workflow.rehydrated` event carrying the correct payload.
    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);

    // Payload shape must match the registered `WorkflowRehydratedData` schema
    // verbatim — no featureId / timestamp inside `data` (streamId + envelope
    // timestamp live on the outer event). Casting through the registered
    // type keeps the assertion schema-driven.
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.projectionSequence).toBe(4);
    expect(data.deliveryPath).toBe('direct');
    expect(typeof data.tokenEstimate).toBe('number');
    expect(data.tokenEstimate).toBeGreaterThanOrEqual(0);
  });

  it('RehydrateHandler_DefaultDeliveryPath_UsesDirect', async () => {
    // GIVEN: a seeded stream and a call that omits `deliveryPath`.
    //   The handler must default to `"direct"` so callers that do not care
    //   about transport (e.g. in-process tests) still produce a schema-valid
    //   event.
    const featureId = 'rehydrate-default-delivery';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    // WHEN: we invoke without deliveryPath.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    // THEN: emitted event's deliveryPath is 'direct'.
    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.deliveryPath).toBe('direct');
    expect(data.projectionSequence).toBe(1);
  });

  it('RehydrateHandler_EmitsEvent_OnlyOnSuccess', async () => {
    // GIVEN: an eventStore whose `query` throws. This verifies the narrow
    //   but meaningful invariant: emission of `workflow.rehydrated` is
    //   conditional on the hydrate succeeding (not a post-hoc "always emit"
    //   sentinel).
    //
    //   T056 (DR-18) changed the failure mode: a throwing `query` no longer
    //   propagates out of the handler — it degrades to state-store-only and
    //   emits `workflow.projection_degraded` instead. The invariant under
    //   test here is unchanged: on the failure path, NO `workflow.rehydrated`
    //   event is emitted. The old "must reject" assertion is now a
    //   "must degrade" assertion — both encode the same contract (hydrate
    //   did not succeed, so the rehydrated signal must not fire).
    const featureId = 'rehydrate-failure-no-emit';
    // Seed the real store with one unrelated event so we can distinguish a
    // missing rehydrated event from an empty stream in the assertion below.
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    // Build a failing shim over the real store. `append` still routes to the
    // real store so that, were the handler to emit `workflow.rehydrated`
    // anyway (the bug guard), the event would be visible when we re-query
    // through `store`.
    const failingStore = {
      append: store.append.bind(store),
      query: async (): Promise<never> => {
        throw new Error('simulated query failure');
      },
    } as unknown as typeof store;

    // WHEN: handler runs. Under T056 it degrades gracefully instead of
    // rejecting.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: failingStore, stateDir },
    );
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.degraded).toBe(true);

    // THEN: no `workflow.rehydrated` event was emitted to the real store.
    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(0);
  });
});

/**
 * T054 — `handleRehydrate` degrades on reducer throw (DR-18)
 *
 * Resilience path: when the rehydration reducer throws mid-fold, the handler
 * MUST NOT propagate — instead it emits `workflow.projection_degraded` with
 * the registered payload shape `{ projectionId, cause, fallbackSource }`
 * (T010, `WorkflowProjectionDegradedData`), reads minimal state from the
 * workflow state store, and returns a degraded `ToolResult` carrying
 * `_meta.degraded: true`.
 *
 * The `workflow.rehydrated` event MUST NOT be emitted on this path — the
 * degraded envelope is orthogonal to the "rehydrate succeeded" signal.
 *
 * Injection mechanism: `vi.spyOn(rehydrationReducer, 'apply')` to throw on
 * the second call. `hydrateFromSnapshotThenTail` receives the
 * `rehydrationReducer` singleton by reference, so the spy intercepts the
 * handler's own fold without needing a module mock.
 */
describe('handleRehydrate — reducer throw degradation (T054, DR-18)', () => {
  it('Rehydrate_ReducerThrows_EmitsDegradedAndReturnsMinimalState', async () => {
    // GIVEN: a seeded state file (so the minimal-state fallback has something
    //   to read) + a seeded event stream. The reducer's `apply` is spied to
    //   throw on its second invocation — the first call folds
    //   `workflow.started` normally, then the spy fires on `task.assigned`.
    const featureId = 'rehydrate-reducer-throws';

    await initStateFile(stateDir, featureId, 'feature');

    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T900' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T900' },
    });

    const realApply = rehydrationReducer.apply.bind(rehydrationReducer);
    let callCount = 0;
    const applySpy = vi
      .spyOn(rehydrationReducer, 'apply')
      .mockImplementation((state, event) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('reducer exploded on T900');
        }
        return realApply(state, event);
      });

    try {
      // WHEN: handler runs. It must NOT throw.
      const result = await handleRehydrate(
        { featureId },
        { eventStore: store, stateDir },
      );

      // THEN (1): handler returns a successful ToolResult (no exception
      //   propagation) carrying `_meta.degraded: true`.
      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(meta?.degraded).toBe(true);
      expect(meta?.fallbackSource).toBe('state-store-only');

      // THEN (2): the returned `data` is a minimal fallback document seeded
      //   from the state-store — v:3, sequence 0, populated workflowState.
      const doc = result.data as RehydrationDocument;
      expect(doc.v).toBe(4);
      expect(doc.projectionSequence).toBe(0);
      expect(doc.workflowState.featureId).toBe(featureId);
      expect(doc.workflowState.workflowType).toBe('feature');
      expect(doc.workflowState.phase).toBeTruthy();
      expect(doc.taskProgress).toEqual([]);
      expect(doc.blockers).toEqual([]);
      // Fallback document still validates under the schema.
      expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

      // THEN (3): the event store has exactly one new
      //   `workflow.projection_degraded` event carrying the registered
      //   `WorkflowProjectionDegradedData` payload. `cause` indicates the
      //   reducer-throw path; `fallbackSource` is `state-store-only`;
      //   `projectionId` is the rehydration projection identity.
      const all = await store.query(featureId);
      const degraded = all.filter(
        (e) => e.type === 'workflow.projection_degraded',
      );
      expect(degraded).toHaveLength(1);
      const payload = degraded[0].data as WorkflowProjectionDegraded;
      expect(payload.projectionId).toBe('rehydration@v1');
      expect(payload.cause).toBe('reducer-throw');
      expect(payload.fallbackSource).toBe('state-store-only');

      // THEN (4): no `workflow.rehydrated` event was emitted on the degraded
      //   path — degradation is mutually exclusive with "hydrate succeeded".
      const rehydrated = all.filter(
        (e) => e.type === 'workflow.rehydrated',
      );
      expect(rehydrated).toHaveLength(0);
    } finally {
      applySpy.mockRestore();
    }
  });
});

/**
 * T055 — `handleRehydrate` degrades on corrupt snapshot sidecar (DR-18)
 *
 * Resilience path: when the snapshot sidecar is present but its contents fail
 * to load/parse — a malformed JSONL line, a schema-invalid state payload, or
 * any non-ENOENT IO error from the read — the handler MUST fall back to a
 * cold replay via `rebuildProjection` (T029), emit
 * `workflow.projection_degraded` with `cause: "snapshot-corrupt"` and
 * `fallbackSource: "full-replay"`, and return the rebuilt document with
 * `_meta.degraded: true`.
 *
 * Distinct from T054 (reducer-throw → state-store-only fallback): here the
 * reducer is healthy, the event log is authoritative, so we rebuild from
 * sequence 0 instead of degrading to the state store.
 *
 * Distinct from the "no snapshot yet" path (ENOENT): a missing file means
 * the projection hasn't been snapshotted yet, not that the cache is corrupt.
 */
describe('handleRehydrate — corrupt-snapshot degradation (T055, DR-18)', () => {
  it('Rehydrate_CorruptSnapshot_ReplaysFromZeroAndSucceeds', async () => {
    // GIVEN: a state directory containing a malformed `<featureId>.projections.jsonl`
    //   sidecar (first line fails JSON.parse), alongside a healthy event
    //   stream that would fold to a valid document.
    const featureId = 'rehydrate-corrupt-snapshot';

    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T500' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T500' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T501' },
    });

    // Seed a snapshot whose `state` payload fails RehydrationDocumentSchema
    // (post-#1343 the substrate stores valid SnapshotRecord rows or no rows;
    // the equivalent "corrupt" signal is state-shape drift that the handler
    // detects via post-read schema validation).
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 1,
      state: { not: 'a-valid-rehydration-document' } as unknown as RehydrationDocument,
      timestamp: new Date().toISOString(),
    });

    // WHEN: invoke the handler.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN (1): handler returns a successful ToolResult with `_meta.degraded`
    //   and `_meta.fallbackSource: "full-replay"`.
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.degraded).toBe(true);
    expect(meta?.fallbackSource).toBe('full-replay');

    // THEN (2): the returned document equals the cold-fold parity result —
    //   folding every event through the rehydration reducer from sequence 0.
    const expected = await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    );
    const doc = result.data as RehydrationDocument;
    expect(doc).toEqual(expected);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    // THEN (3): exactly one `workflow.projection_degraded` event was appended
    //   with the registered payload — `cause: "snapshot-corrupt"`,
    //   `fallbackSource: "full-replay"`, `projectionId: "rehydration@v1"`.
    const all = await store.query(featureId);
    const degraded = all.filter(
      (e) => e.type === 'workflow.projection_degraded',
    );
    expect(degraded).toHaveLength(1);
    const payload = degraded[0].data as WorkflowProjectionDegraded;
    expect(payload.projectionId).toBe('rehydration@v1');
    expect(payload.cause).toBe('snapshot-corrupt');
    expect(payload.fallbackSource).toBe('full-replay');

    // THEN (4): no `workflow.rehydrated` event — the degraded envelope is
    //   mutually exclusive with "hydrate succeeded" (same invariant as T054).
    const rehydrated = all.filter((e) => e.type === 'workflow.rehydrated');
    expect(rehydrated).toHaveLength(0);
  });
});

/**
 * T056 — `handleRehydrate` degrades on event-stream-unavailable (DR-18)
 *
 * Resilience path: when the event store's `query` raises (connection refused,
 * backing file ripped away, transient IO error, etc.), the handler MUST NOT
 * propagate — it has no authoritative event log to fold, so it falls back to
 * the workflow state store only, emits `workflow.projection_degraded` with
 * `cause: "event-stream-unavailable"` and `fallbackSource: "state-store-only"`,
 * and returns a minimal document with `_meta.degraded: true`.
 *
 * Distinct from T054 (reducer throw mid-fold): here the reducer never runs
 * because we never obtained a tail. Distinct from T055 (corrupt snapshot):
 * here the snapshot read may have succeeded, but the subsequent tail query
 * is what fails — so we still cannot trust the projection and must fall
 * back to the state store.
 *
 * Dual-failure policy: if `eventStore.append` of the degraded event also
 * throws (the event store is fully offline, not just flaky on query), the
 * handler must log a WARN and return the degraded envelope anyway — the
 * degradation path is a no-throw boundary. This test sets up the stub so
 * that `query` throws but `append` routes to the real store, exercising the
 * primary failure path and confirming the degraded event lands.
 */
describe('handleRehydrate — event-stream-unavailable degradation (T056, DR-18)', () => {
  it('Rehydrate_EventStreamUnavailable_ReturnsStateStoreOnly', async () => {
    // GIVEN: a seeded state file (so the state-store fallback has data to
    //   read) and an event-store stub whose `query` rejects. `append` is
    //   routed to the real store so the emitted degraded event is visible
    //   on re-query via the real store. This mirrors the shim pattern used
    //   in `RehydrateHandler_EmitsEvent_OnlyOnSuccess` (T032).
    const featureId = 'rehydrate-event-stream-unavailable';

    await initStateFile(stateDir, featureId, 'feature');

    const failingQueryStore = {
      append: store.append.bind(store),
      // #1325 — the degraded-path emission migrated to `appendValidated`
      // (via `buildValidatedEvent`). Bind both so the emitted degraded
      // event is observable on the real store after re-query.
      appendValidated: store.appendValidated.bind(store),
      query: (): Promise<never> =>
        Promise.reject(new Error('event store offline')),
    } as unknown as typeof store;

    // WHEN: handler runs. It MUST NOT throw.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: failingQueryStore, stateDir },
    );

    // THEN (1): handler returns a successful ToolResult carrying
    //   `_meta.degraded: true` and `_meta.fallbackSource: "state-store-only"`.
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.degraded).toBe(true);
    expect(meta?.fallbackSource).toBe('state-store-only');

    // THEN (2): the returned `data` is a minimal fallback document seeded
    //   from the state store — v:3, projectionSequence 0, populated
    //   workflowState.
    const doc = result.data as RehydrationDocument;
    expect(doc.v).toBe(4);
    expect(doc.projectionSequence).toBe(0);
    expect(doc.workflowState.featureId).toBe(featureId);
    expect(doc.workflowState.workflowType).toBe('feature');
    expect(doc.workflowState.phase).toBeTruthy();
    expect(doc.taskProgress).toEqual([]);
    expect(doc.blockers).toEqual([]);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    // THEN (3): the event store received exactly one
    //   `workflow.projection_degraded` event with the registered payload —
    //   `cause: "event-stream-unavailable"`,
    //   `fallbackSource: "state-store-only"`,
    //   `projectionId: "rehydration@v1"`.
    const all = await store.query(featureId);
    const degraded = all.filter(
      (e) => e.type === 'workflow.projection_degraded',
    );
    expect(degraded).toHaveLength(1);
    const payload = degraded[0].data as WorkflowProjectionDegraded;
    expect(payload.projectionId).toBe('rehydration@v1');
    expect(payload.cause).toBe('event-stream-unavailable');
    expect(payload.fallbackSource).toBe('state-store-only');

    // THEN (4): no `workflow.rehydrated` event — degradation is mutually
    //   exclusive with "hydrate succeeded" (same invariant as T054/T055).
    const rehydrated = all.filter((e) => e.type === 'workflow.rehydrated');
    expect(rehydrated).toHaveLength(0);
  });
});

/**
 * T-20 — `handleRehydrate` composes `phasePlaybook`
 *
 * Implements rehydration-machinery-refactor §T-20 (P2 handler composition).
 * After the projection fold completes and BEFORE `workflow.rehydrated` is
 * emitted, the handler resolves the L4 playbook via
 * `getPlaybook(workflowState.workflowType, workflowState.phase)` and:
 *   - attaches the serialized playbook to `document.phasePlaybook` when
 *     present (e.g. feature/delegate → delegation skill); OR
 *   - attaches `null` for terminal / unregistered phases.
 *
 * This is pure additive composition — degraded paths (T-22) are unchanged.
 */
describe('handleRehydrate — phasePlaybook composition (T-20)', () => {
  it('RehydrateHandler_DelegatePhase_AttachesSerializedPhasePlaybook', async () => {
    // GIVEN: a feature workflow that has transitioned into the `delegate`
    //   phase. The L4 registry has a `feature:delegate` playbook keyed to
    //   the `delegation` skill (see workflow/playbooks.ts).
    const featureId = 'rehydrate-phaseplaybook-delegate';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });

    // WHEN: we rehydrate.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: the returned document carries a populated phasePlaybook whose
    //   skill is `delegation` and whose events surface is non-empty.
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.workflowState.phase).toBe('delegate');
    expect(doc.phasePlaybook).not.toBeNull();
    // Narrow the nullable for the assertions below.
    const playbook = doc.phasePlaybook;
    if (playbook === null) {
      throw new Error('expected phasePlaybook to be non-null');
    }
    expect(playbook.skill).toBe('delegate');
    expect(playbook.events.length).toBeGreaterThan(0);

    // The composed document still validates under v:3.
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('RehydrateHandler_TerminalPhase_AttachesNullPhasePlaybook', async () => {
    // GIVEN: a feature workflow that has transitioned into a phase with no
    //   registered playbook (e.g. `shipped`). `getPlaybook` returns null
    //   and the handler must surface that as `phasePlaybook: null` rather
    //   than omitting the field (the v:3 schema requires its presence).
    const featureId = 'rehydrate-phaseplaybook-terminal';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'shipped' },
    });

    // WHEN: we rehydrate.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    // THEN: phasePlaybook is exactly null (not undefined / not omitted).
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.workflowState.phase).toBe('shipped');
    expect(doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

/**
 * T-21 — `workflow.rehydrated` event payload exposes playbook-presence flags
 *
 * Implements rehydration-machinery-refactor §T-21 (P2 emission wiring).
 * After T-20 the handler composes `document.phasePlaybook` (null for terminal
 * / unregistered phases, a serialized playbook for delegate). T-21 widens the
 * audit event so downstream observability can distinguish "phase had a
 * playbook in the registry" (`phaseHasPlaybook`) from "the handler actually
 * composed it onto this document" (`phasePlaybookComposed`). On the happy
 * path both flags equal `phasePlaybook !== null`; T-22/T-23 will diverge them
 * for degraded paths and checkpoint composition.
 *
 * The schema fields were added in T-10 (`WorkflowRehydratedData` in
 * `event-store/schemas.ts`). T-21 wires emission only.
 */
describe('handleRehydrate — workflow.rehydrated extended fields (T-21)', () => {
  it('RehydrateHandler_DelegatePhase_EmitsHasPlaybookAndComposedTrue', async () => {
    // GIVEN: a feature workflow in `delegate` phase. Per T-20 the handler
    //   composes a non-null phasePlaybook from the L4 registry.
    const featureId = 'rehydrate-t21-delegate';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });

    // WHEN: we rehydrate.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    // THEN: the emitted `workflow.rehydrated` event carries both flags as
    //   `true`, mirroring `phasePlaybook !== null` on the returned document.
    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.phaseHasPlaybook).toBe(true);
    expect(data.phasePlaybookComposed).toBe(true);
  });

  it('RehydrateHandler_TerminalPhase_EmitsHasPlaybookAndComposedFalse', async () => {
    // GIVEN: a feature workflow transitioned to a terminal phase with no
    //   registered playbook. T-20 surfaces this as `phasePlaybook: null`.
    const featureId = 'rehydrate-t21-terminal';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'shipped' },
    });

    // WHEN: we rehydrate.
    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);

    // THEN: the emitted event carries both flags as `false` — phase had no
    //   playbook and none was composed onto the document.
    const all = await store.query(featureId);
    const rehydratedEvents = all.filter(
      (e) => e.type === 'workflow.rehydrated',
    );
    expect(rehydratedEvents).toHaveLength(1);
    const data = rehydratedEvents[0].data as WorkflowRehydrated;
    expect(data.phaseHasPlaybook).toBe(false);
    expect(data.phasePlaybookComposed).toBe(false);
  });
});

/**
 * T-22 — degraded paths preserve `phasePlaybook: null`
 *
 * Implements rehydration-machinery-refactor §T-22 (P2 invariant guard).
 * Once T-20 added live playbook composition on the happy path, the degraded
 * envelopes (reducer-throw / snapshot-corrupt / event-stream-unavailable)
 * MUST continue to surface `phasePlaybook: null` — the schema-default carried
 * by `rehydrationReducer.initial`. Composition is intentionally skipped on
 * degradation: the document we return is built from the workflow state store
 * (or the cold-replay rebuilt projection for snapshot-corrupt), not from a
 * trustworthy authoritative event fold, so attaching a playbook would risk
 * mis-attributing skill guidance to a phase we can't fully trust.
 *
 * Scope: this is a contract guard. It complements T054/T055/T056 — those
 * assert the degraded envelope wiring; T-22 asserts that the playbook field
 * of the degraded document remains null across all three causes. If a future
 * change accidentally composes a non-null phasePlaybook on a degraded path,
 * these tests fail loudly.
 */
describe('handleRehydrate — degraded paths preserve phasePlaybook null (T-22)', () => {
  it('Rehydrate_ReducerThrows_DegradedDocumentHasPhasePlaybookNull', async () => {
    // GIVEN: same setup as T054 — seeded state file, seeded events, reducer
    //   spy that throws on its second invocation.
    const featureId = 'rehydrate-t22-reducer-throw';
    await initStateFile(stateDir, featureId, 'feature');
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T22-A' },
    });

    const realApply = rehydrationReducer.apply.bind(rehydrationReducer);
    let callCount = 0;
    const applySpy = vi
      .spyOn(rehydrationReducer, 'apply')
      .mockImplementation((state, event) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('reducer exploded on T22-A');
        }
        return realApply(state, event);
      });

    try {
      const result = await handleRehydrate(
        { featureId },
        { eventStore: store, stateDir },
      );

      // THEN: degraded envelope is returned and its document carries
      //   `phasePlaybook: null` — composition is skipped on degradation.
      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta?.degraded).toBe(true);
      const doc = result.data as RehydrationDocument;
      expect(doc.phasePlaybook).toBeNull();
      expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
    } finally {
      applySpy.mockRestore();
    }
  });

  it('Rehydrate_CorruptSnapshot_DegradedDocumentHasPhasePlaybookNull', async () => {
    // GIVEN: same setup as T055 — corrupt snapshot sidecar, healthy events.
    //   The snapshot-corrupt path falls back to a full cold replay, so the
    //   document is built by `rebuildProjection`, not `minimalFromStateStore`.
    //   Either way, the handler must not compose a phasePlaybook on the
    //   degraded path.
    const featureId = 'rehydrate-t22-corrupt-snapshot';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    // Drive the reducer into `delegate` so that — in a non-degraded world —
    //   composition would attach a non-null playbook. The point is that the
    //   degraded path skips composition regardless.
    await store.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });

    // Seed a snapshot with a state payload that fails RehydrationDocumentSchema
    // (post-#1343 corruption-equivalent — see T055 test for context).
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: 'rehydration@v1',
      projectionVersion: '1',
      sequence: 1,
      state: { not: 'a-valid-rehydration-document' } as unknown as RehydrationDocument,
      timestamp: new Date().toISOString(),
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.degraded).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('Rehydrate_EventStreamUnavailable_DegradedDocumentHasPhasePlaybookNull', async () => {
    // GIVEN: same setup as T056 — failing-query event store stub, seeded
    //   state file. The handler falls back to `minimalFromStateStore` and
    //   must surface `phasePlaybook: null` on the returned document.
    const featureId = 'rehydrate-t22-event-stream-unavailable';
    await initStateFile(stateDir, featureId, 'feature');

    const failingQueryStore = {
      append: store.append.bind(store),
      // #1325 — the degraded-path emission migrated to `appendValidated`
      // (via `buildValidatedEvent`). Bind both so the emitted degraded
      // event is observable on the real store after re-query.
      appendValidated: store.appendValidated.bind(store),
      query: (): Promise<never> =>
        Promise.reject(new Error('event store offline')),
    } as unknown as typeof store;

    const result = await handleRehydrate(
      { featureId },
      { eventStore: failingQueryStore, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.degraded).toBe(true);
    const doc = result.data as RehydrationDocument;
    expect(doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

// ─── #1359 / PR4 T14 + T15 — projectionAsOf + projectionLag ─────────────────

describe('handleRehydrate — projectionAsOf + projectionLag (#1359 / PR4)', () => {
  it('Rehydrate_FoldedEvents_ExposesProjectionAsOf', async () => {
    const featureId = 'pr4-asof';
    // Seed two events; their timestamps drive `projectionAsOf`.
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T001' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta?.projectionAsOf).toBe('string');
    // Sanity: parses as an ISO timestamp.
    expect(Number.isFinite(Date.parse(meta!.projectionAsOf as string))).toBe(true);
  });

  it('Rehydrate_StaleProjection_ExposesMetaProjectionLag', async () => {
    const featureId = 'pr4-lag';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    // Freeze Date.now() to far in the future so the projection appears
    // stale beyond the 5s threshold. `vi.useFakeTimers` + setSystemTime
    // is the documented vitest path for this. We don't fake `setTimeout`
    // etc. — only the wall clock.
    const futureMs = Date.now() + 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(futureMs));
    try {
      const result = await handleRehydrate(
        { featureId },
        { eventStore: store, stateDir },
      );
      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(typeof meta?.projectionLag).toBe('number');
      expect(meta?.projectionLag as number).toBeGreaterThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Rehydrate_FreshProjection_OmitsProjectionLag', async () => {
    const featureId = 'pr4-fresh';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const result = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    // Fresh projection: either no _meta at all OR _meta without
    // projectionLag. The sparse contract means agents can rely on the
    // field's presence to indicate "stale" rather than reading a 0/null.
    if (meta) {
      expect(meta.projectionLag).toBeUndefined();
    }
  });
});

// ─── DR-9 (#1581 task 020): in-flight backward-compat — no forced migration ──
//
// A workflow already holding a two-artifact (`docs/designs/` + plan) state must
// resume and complete under the OLD path; only newly-`init`'d features adopt the
// unified `docs/specs/` artifact. The rehydrate handler surfaces the layout on
// `_meta.artifactLayout` so the collapsed-flow playbook/agent completes the
// legacy workflow in place instead of migrating it mid-flight.
describe('classifyArtifactLayout (DR-9, task 020)', () => {
  it('ClassifyArtifactLayout_LegacyDesignPlusPlan_IsTwoArtifact', () => {
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/2026-06-01-feat.md',
        plan: 'docs/plans/2026-06-01-feat.md',
      }),
    ).toBe('two-artifact');
  });

  it('ClassifyArtifactLayout_UnifiedSpec_IsUnified', () => {
    expect(classifyArtifactLayout({ spec: 'docs/specs/2026-06-22-feat.md' })).toBe('unified');
    // A spec artifact recorded under a non-`spec` key still classifies by path.
    expect(classifyArtifactLayout({ design: 'docs/specs/2026-06-22-feat.md' })).toBe('unified');
  });

  it('ClassifyArtifactLayout_NoArtifacts_DefaultsUnified', () => {
    // The forward default: a fresh feature with no artifacts yet uses the
    // collapsed path — only an explicit legacy `docs/designs/` design flips it.
    expect(classifyArtifactLayout({})).toBe('unified');
  });

  it('ClassifyArtifactLayout_SpecWinsOverLegacyDesign_IsUnified', () => {
    // Mixed/ambiguous: a workflow that adopted the unified spec but still
    // carries a stale legacy design path stays `'unified'` — spec presence is
    // the stronger signal (it already migrated).
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/2026-06-01-feat.md',
        spec: 'docs/specs/2026-06-22-feat.md',
      }),
    ).toBe('unified');
  });
});

// ─── DR-18 archival boundary (task 030) ───────────────────────────────────
//
// The wave-1 debloat archival (task 030) physically moves every superseded
// dated `docs/designs/<date>.md` design doc into `docs/designs/archive/`. This
// guards the `LEGACY_DESIGN_DIR` boundary: the classifier is FILESYSTEM-BLIND —
// it discriminates on the event-folded *recorded* artifact path, never on where
// the file happens to live on disk. Archiving the physical doc therefore cannot
// change the classification, because the recorded artifact string is untouched.
//
// The forbidden edit this pins against: "helpfully" repointing
// `LEGACY_DESIGN_DIR` from `'docs/designs/'` to `'docs/designs/archive/'` during
// archival. That would make a resuming legacy workflow (whose recorded design
// path is the original `docs/designs/<date>`) classify `'unified'`, forcing the
// mid-flight migration the module explicitly forbids. So the constant MUST be
// left alone — and this test goes red the moment it is repointed.
describe('LEGACY_DESIGN_DIR archival-invariance (DR-18, task 030)', () => {
  it('Rehydrate_LegacyDesignPath_ClassificationUnchangedByArchival', () => {
    // A legacy two-artifact workflow's RECORDED design path is the original
    // `docs/designs/<date>` — archival does not rewrite it. It must still
    // classify `'two-artifact'`. (Repointing LEGACY_DESIGN_DIR to the archive
    // subtree breaks this — the recorded original no longer prefix-matches.)
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/2026-05-30-legacy-feat.md',
        plan: 'docs/plans/2026-05-30-legacy-feat.md',
      }),
    ).toBe('two-artifact');

    // Belt-and-suspenders: because the constant is a PREFIX match on
    // `docs/designs/`, a workflow whose recorded design path was itself archived
    // in place (`docs/designs/archive/<date>`) still classifies two-artifact —
    // so neither an in-place-archived record nor an untouched one is disturbed.
    expect(
      classifyArtifactLayout({
        design: 'docs/designs/archive/2026-05-30-legacy-feat.md',
      }),
    ).toBe('two-artifact');

    // The forward default is unchanged: a fresh feature (no legacy design
    // artifact) still classifies unified — archival touched neither branch.
    expect(classifyArtifactLayout({})).toBe('unified');
  });
});

describe('handleRehydrate — in-flight backward-compat (DR-9, task 020)', () => {
  it('Resume_TwoArtifactInflightWorkflow_CompletesOldPath', async () => {
    // GIVEN: an in-flight feature authored under the pre-#1581 two-phase
    //   convention — a `docs/designs/` design doc AND a `docs/plans/` plan,
    //   recorded via state.patched, now resuming mid-flight in `delegate`.
    const featureId = 'legacy-two-artifact-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: {
        patch: {
          artifacts: {
            design: 'docs/designs/2026-05-30-legacy-feat.md',
            plan: 'docs/plans/2026-05-30-legacy-feat.md',
          },
        },
      },
    });

    // WHEN: it resumes.
    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    // THEN: the handler flags the two-artifact layout so the resuming agent
    //   completes OLD-path, and it does NOT rewrite/migrate the artifacts to
    //   `docs/specs/` — the recorded legacy paths survive verbatim.
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.artifactLayout).toBe('two-artifact');

    const doc = result.data as RehydrationDocument;
    expect(doc.artifacts.design).toBe('docs/designs/2026-05-30-legacy-feat.md');
    expect(doc.artifacts.plan).toBe('docs/plans/2026-05-30-legacy-feat.md');
    // No silent migration: nothing under `docs/specs/` was synthesized.
    expect(Object.values(doc.artifacts).some((p) => p.includes('docs/specs/'))).toBe(false);
  });

  it('Resume_NewlyInitFeature_UsesUnifiedPath', async () => {
    // GIVEN: a freshly `init`'d feature with no artifacts yet (the post-collapse
    //   default). It must NOT be flagged legacy — new work uses `docs/specs/`.
    const featureId = 'fresh-unified-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.artifactLayout).toBe('unified');
  });

  it('Resume_UnifiedSpecWorkflow_StaysUnified', async () => {
    // GIVEN: a feature that already adopted the unified `docs/specs/` artifact.
    const featureId = 'unified-spec-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: { patch: { artifacts: { spec: 'docs/specs/2026-06-22-feat.md' } } },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.artifactLayout).toBe('unified');
  });
});

/**
 * Regression guard for the retirement of the global projection scope (DR-1).
 *
 * That change narrowed `ProjectionScope` to `'stream'` and deleted
 * `readProjection` / `projections/cadence.ts` / `InvalidReducerScopeError`. It
 * deliberately KEPT the `appendSnapshot` / `readLatestSnapshot` pair, whose
 * live round trip threads the checkpoint→rehydrate path:
 *
 *   `tools.ts::handleCheckpoint`  — writes the snapshot (`appendSnapshot`)
 *   `rehydrate.ts::hydrateFromSnapshotThenTail` — reads it (warm hydrate)
 *   `rehydrate.ts::handleRehydrate`             — reads it (handler path)
 *   `rebuild.ts::projectAt`                     — reads it (warm start)
 *
 * The snapshot pair sits one import away from every symbol the retirement
 * deleted, so "the deletion compiled" is not evidence the round trip still
 * works. This test pins the whole loop end-to-end through the production
 * write path.
 *
 * ## Why the tracer phase exists
 *
 * Asserting only "warm read == cold rebuild" is VACUOUS: if the snapshot were
 * silently ignored, every read path would simply cold-fold and still agree
 * with the cold rebuild. The final phase therefore bakes a tracer into the
 * snapshot state that NO event can produce. It surfaces iff the reader
 * genuinely consulted the snapshot — a positive control that separates
 * "warm-start works" from "warm-start is dead code that happens to agree".
 */
describe('rehydration snapshot round-trip survives the global-scope retirement (DR-1)', () => {
  it('RehydrationCheckpoint_AfterGlobalPathRemoval_RoundTripsUnchanged', async () => {
    const featureId = 'roundtrip-after-global-removal';

    // ── GIVEN: an initialized workflow with a seeded event prefix ───────────
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      store,
    );
    expect(initResult.success).toBe(true);

    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T001' } });
    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T001' } });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T002' } });

    // ── PHASE 1 — WRITE side: handleCheckpoint materializes a snapshot ──────
    const cpResult = await handleCheckpoint(
      { featureId, summary: 'round-trip guard checkpoint' },
      stateDir,
      store,
    );
    expect(cpResult.success).toBe(true);

    const written = readLatestSnapshot(
      store.getReadBackend(),
      featureId,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );

    // The snapshot must exist and round-trip through SnapshotRecord validation
    // (`readLatestSnapshot` returns undefined on a schema miss, so a non-
    // undefined result already proves the payload validated).
    expect(written).toBeDefined();
    expect(written!.projectionId).toBe(REHYDRATION_PROJECTION_ID);
    expect(written!.projectionVersion).toBe(REHYDRATION_PROJECTION_VERSION);

    // `snapshot.sequence` is a real stream coordinate: the sequence of the
    // `workflow.checkpoint` event, i.e. everything known as of the checkpoint
    // moment. It is NOT the post-return tip — the handler emits
    // `workflow.checkpoint_written` AFTER the snapshot write, so the log tip
    // is one past the snapshot by the time the call returns.
    const checkpointSeq = await lastSequenceOfType(store, featureId, 'workflow.checkpoint');
    expect(written!.sequence).toBe(checkpointSeq);
    expect(await tipSequence(store, featureId)).toBe(checkpointSeq + 1);

    const writtenDoc = RehydrationDocumentSchema.parse(written!.state) as RehydrationDocument;
    expect(writtenDoc.projectionSequence).toBeLessThan(written!.sequence);

    // The persisted state must equal a cold fold of the log as of the snapshot.
    const coldAtCheckpoint = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    expect(writtenDoc).toEqual(coldAtCheckpoint);

    // ── PHASE 2 — READ side: every warm path agrees with a cold replay ──────
    // Tail events land strictly after the snapshot's sequence; a reader that
    // mishandles `sinceSequence` will drop or double-apply them.
    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T002' } });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T003' } });
    await store.append(featureId, { type: 'task.failed', data: { taskId: 'T003' } });

    // Cold baseline — `rebuildProjection` never consults snapshots, so it is
    // the independent oracle for what the warm paths must reproduce (INV-1:
    // warm-start is an optimisation, never a change in observed state).
    const cold = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;

    // Sanity: the tail actually moved the projection, so the comparisons below
    // are not all agreeing on a stale snapshot's state.
    expect(cold).not.toEqual(writtenDoc);
    expect(statusById(cold)).toEqual({
      T001: 'complete',
      T002: 'complete',
      T003: 'failed',
    });

    // rehydrate.ts:171 — warm hydrate. Reads the snapshot, folds the tail.
    const warmHydrate = await hydrateFromSnapshotThenTail<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      featureId,
      stateDir,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );
    expect(warmHydrate.state).toEqual(cold);
    // The absorbed stream position must track the log tip, not the handled
    // count — a stale value here re-feeds absorbed events on the next read.
    expect(warmHydrate.lastEventSequence).toBe(await tipSequence(store, featureId));

    // rebuild.ts:243 — `projectAt` warm start (unbounded == full replay).
    const warmProjectAt = await projectAt(rehydrationReducer, store, featureId);
    expect(warmProjectAt).toEqual(cold);

    // rehydrate.ts:443 — the handler path. Compared last: it appends
    // `workflow.rehydrated` AFTER folding, so it observes the same log as the
    // reads above, but mutates the log for anything that follows.
    const handlerResult = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(handlerResult.success).toBe(true);
    const handlerDoc = handlerResult.data as RehydrationDocument;
    // `phasePlaybook` is composed live by the handler (T-20) and is not part
    // of the snapshot round trip, so it is normalized out of the comparison
    // rather than re-derived here (which would just re-assert the handler's
    // own logic against itself).
    expect(withoutPlaybook(handlerDoc)).toEqual(withoutPlaybook(cold));

    // ── PHASE 3 — the snapshot is genuinely consulted (anti-vacuity) ────────
    // Bake a tracer task into the snapshot state that no event in the stream
    // can ever produce, pinned at the current log tip. Every read path must
    // surface it; the cold rebuild must not.
    const tracerAnchor = await tipSequence(store, featureId);
    const coldAtAnchor = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    const tracerState: RehydrationDocument = {
      ...coldAtAnchor,
      taskProgress: [...coldAtAnchor.taskProgress, { id: TRACER_TASK_ID, status: 'complete' }],
    };
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: tracerAnchor,
      state: tracerState,
      timestamp: new Date().toISOString(),
    });

    // One more tail event after the tracer snapshot, so each read must BOTH
    // seed from the snapshot (tracer present) and fold the tail (T004 present).
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T004' } });

    const coldAfterTracer = (await rebuildProjection(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    // Negative control: the tracer is not reachable from the event log.
    expect(statusById(coldAfterTracer)).not.toHaveProperty(TRACER_TASK_ID);
    expect(statusById(coldAfterTracer)).toHaveProperty('T004', 'in_progress');

    // What every warm read must produce: the cold fold, plus the tracer that
    // only the snapshot can supply. Asserting `projectionSequence` alongside
    // the status map is load-bearing, NOT belt-and-braces: `task.*` folds are
    // idempotent by task id, so re-applying events the snapshot already
    // absorbed leaves every status untouched and moves only this counter. It
    // is the sole assertion here that can see a `sinceSequence` seeded from
    // the handled-event count instead of the absorbed stream coordinate —
    // the exact conflation `rebuild.ts` warns about.
    const expectedStatuses = {
      ...statusById(coldAfterTracer),
      [TRACER_TASK_ID]: 'complete',
    };

    // Positive control, once per read path.
    const tracedHydrate = await hydrateFromSnapshotThenTail<RehydrationDocument, WorkflowEvent>(
      rehydrationReducer,
      store,
      featureId,
      stateDir,
      REHYDRATION_PROJECTION_ID,
      REHYDRATION_PROJECTION_VERSION,
    );
    expect(statusById(tracedHydrate.state)).toEqual(expectedStatuses);
    expect(tracedHydrate.state.projectionSequence).toBe(coldAfterTracer.projectionSequence);

    const tracedProjectAt = (await projectAt(
      rehydrationReducer,
      store,
      featureId,
    )) as RehydrationDocument;
    expect(statusById(tracedProjectAt)).toEqual(expectedStatuses);
    expect(tracedProjectAt.projectionSequence).toBe(coldAfterTracer.projectionSequence);

    const tracedHandler = await handleRehydrate(
      { featureId },
      { eventStore: store, stateDir },
    );
    expect(tracedHandler.success).toBe(true);
    const tracedDoc = tracedHandler.data as RehydrationDocument;
    expect(statusById(tracedDoc)).toEqual(expectedStatuses);
    expect(tracedDoc.projectionSequence).toBe(coldAfterTracer.projectionSequence);
  });
});

/** Task id no event can produce — see the tracer phase above. */
const TRACER_TASK_ID = 'T-SNAPSHOT-TRACER';

/** Highest event-store sequence currently in `streamId`, or 0 when empty. */
async function tipSequence(eventStore: EventStore, streamId: string): Promise<number> {
  const events = await eventStore.query(streamId);
  return events.length > 0 ? events[events.length - 1].sequence : 0;
}

/** Sequence of the last event of `type` in `streamId`. Fails loudly if absent. */
async function lastSequenceOfType(
  eventStore: EventStore,
  streamId: string,
  type: string,
): Promise<number> {
  const matches = (await eventStore.query(streamId)).filter((e) => e.type === type);
  if (matches.length === 0) {
    throw new Error(`expected at least one '${type}' event in stream '${streamId}'`);
  }
  return matches[matches.length - 1].sequence;
}

/** `taskProgress` as an `{ [id]: status }` map for order-insensitive asserts. */
function statusById(doc: RehydrationDocument): Record<string, string> {
  return Object.fromEntries(doc.taskProgress.map((t) => [t.id, t.status]));
}

/**
 * Drop the handler-composed `phasePlaybook` so a handler document can be
 * compared against a raw reducer fold. The playbook is derived from the
 * registry at handler time, not carried through the snapshot.
 */
function withoutPlaybook(doc: RehydrationDocument): Omit<RehydrationDocument, 'phasePlaybook'> {
  const { phasePlaybook: _phasePlaybook, ...rest } = doc;
  return rest;
}

// ─── P04-06 (EFF-004): Rehydration under degradation — deterministic fallback ─
//
// Exit proof: rehydration returns the authoritative event-derived (or explicitly
// summarized) state and NEVER silently trusts stale/contradictory projection
// data. Declared precedence (see `rehydrate-precedence.ts`, unit-tested there):
// authoritative event fold > explicit summary snapshot > (never) stale
// projection. These tests pin the HANDLER's observable behaviour under each
// degradation mode via `_meta.rehydrationSource` / `_meta.projectionDegraded` —
// the latter being the SAME P01-02 durable degradation verdict the view surface
// stamps, consumed here rather than reinvented.
describe('handleRehydrate — degradation precedence (P04-06, EFF-004)', () => {
  it('Rehydrate_ProjectionUnavailable_ReturnsEventDerivedState', async () => {
    // (a) No cached snapshot (the projection cache is unavailable). The handler
    // folds the authoritative event log and reports the source as `event-fold`.
    const featureId = 'p0406-no-projection';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T001' } });
    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T001' } });

    // Precondition: there is genuinely no snapshot to trust.
    expect(
      readLatestSnapshot(
        store.getReadBackend(),
        featureId,
        REHYDRATION_PROJECTION_ID,
        REHYDRATION_PROJECTION_VERSION,
      ),
    ).toBeUndefined();

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.rehydrationSource).toBe('event-fold');
    expect(meta?.projectionDegraded).toBeUndefined();

    const doc = result.data as RehydrationDocument;
    expect(doc.projectionSequence).toBe(3);
    expect(statusById(doc)).toEqual({ T001: 'complete' });
  });

  it('Rehydrate_ProjectionContradictsEvents_EventsWin_FlaggedDegraded', async () => {
    // (b) A snapshot whose cursor sits PAST the durable tail — a snapshot
    // restored over a pruned/rebuilt store. It also carries a GHOST task that NO
    // event in the log can produce. Events must WIN: the ghost is gone, the
    // sequence reflects the real tail, and the response is flagged degraded.
    const featureId = 'p0406-ahead-contradiction';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T-REAL' } });
    const eventTail = await store.tailSequence(featureId); // 2

    // Build a contradictory snapshot: fold a fabricated stream that invents a
    // GHOST task, then persist it at a sequence far AHEAD of the real tail.
    const ghostEvents = [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      { type: 'task.assigned', data: { taskId: 'GHOST' } },
      { type: 'task.completed', data: { taskId: 'GHOST' } },
    ] as const;
    let ghostState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of ghostEvents) {
      ghostState = rehydrationReducer.apply(ghostState, ev as unknown as WorkflowEvent);
    }
    const aheadCursor = eventTail + 8;
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: aheadCursor,
      state: ghostState,
      timestamp: new Date().toISOString(),
    });
    // Sanity: the snapshot really is ahead of the durable tail and holds the ghost.
    expect(aheadCursor).toBeGreaterThan(eventTail);
    expect(statusById(ghostState)).toHaveProperty('GHOST', 'complete');

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);

    const doc = result.data as RehydrationDocument;
    // Events win: the ghost the snapshot invented is absent, and the sequence
    // reflects the real (folded) tail — NOT the snapshot's inflated cursor.
    expect(statusById(doc)).not.toHaveProperty('GHOST');
    expect(statusById(doc)).toHaveProperty('T-REAL', 'in_progress');
    expect(doc.projectionSequence).toBe(2);
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    // …and the response is EXPLICITLY flagged degraded via the P01-02 verdict
    // (projection-ahead), so no consumer mistakes it for a clean read.
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.rehydrationSource).toBe('event-fold');
    const degraded = meta?.projectionDegraded as
      | { reason?: string; eventTail?: number; projectionCursor?: number }
      | undefined;
    expect(degraded).toBeDefined();
    expect(degraded?.reason).toBe('projection-ahead');
    expect(degraded?.eventTail).toBe(eventTail);
    expect(degraded?.projectionCursor).toBe(aheadCursor);

    // The existence invariant holds: the stream has real events, so it exists.
    expect(meta?.workflowExists).toBe(true);
  });

  it('Rehydrate_StaleProjectionBehindTail_NotSilentlyTrusted', async () => {
    // (c) A snapshot that LAGS the tail with a stale task status. It must not be
    // served as-is: the tail is folded forward so the corrected event state wins.
    const featureId = 'p0406-behind-stale';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, { type: 'task.assigned', data: { taskId: 'T-STALE' } });

    // Snapshot at the current tail with T-STALE still 'in_progress'.
    const staleCursor = await store.tailSequence(featureId); // 2
    const staleEvents = await store.query(featureId);
    let staleState: RehydrationDocument = rehydrationReducer.initial;
    for (const ev of staleEvents) staleState = rehydrationReducer.apply(staleState, ev);
    appendSnapshot(store.getReadBackend(), featureId, {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: staleCursor,
      state: staleState,
      timestamp: new Date().toISOString(),
    });
    expect(statusById(staleState)).toHaveProperty('T-STALE', 'in_progress');

    // A later event completes T-STALE — the snapshot is now stale.
    await store.append(featureId, { type: 'task.completed', data: { taskId: 'T-STALE' } });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;
    // The stale 'in_progress' status is NOT trusted — the folded-forward event wins.
    expect(statusById(doc)).toHaveProperty('T-STALE', 'complete');
    expect(doc.projectionSequence).toBe(3);

    const meta = result._meta as Record<string, unknown> | undefined;
    // Folding forward self-heals a behind snapshot: event-derived, NOT degraded.
    expect(meta?.rehydrationSource).toBe('event-fold');
    expect(meta?.projectionDegraded).toBeUndefined();
  });

  it('Rehydrate_ColdProbeUnknownFeature_NoEvent_WorkflowExistsFalse', async () => {
    // (d) The existence invariant under the precedence work: a cold probe of a
    // never-init'd feature stays side-effect-free and reports absence.
    const featureId = 'p0406-cold-unknown';
    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(result.success).toBe(true);

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.workflowExists).toBe(false);
    expect(meta?.rehydrationSource).toBe('event-fold');
    expect(meta?.projectionDegraded).toBeUndefined();

    // No event was written to the previously-empty stream (no phantom workflow).
    const all = await store.query(featureId);
    expect(all).toHaveLength(0);
  });
});
