import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { appendSnapshot } from '../projections/store.js';
import { rebuildProjection } from '../projections/rebuild.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../projections/rehydration/schema.js';
import type {
  WorkflowRehydrated,
  WorkflowProjectionDegraded,
} from '../event-store/schemas.js';
// Importing this barrel has a side effect: it registers the rehydration
// reducer with the process-wide default registry. Import so the handler's
// registry-based resolution works during this test file.
import '../projections/rehydration/index.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import { initStateFile } from './state-store.js';

import { handleRehydrate } from './rehydrate.js';

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
  await rm(tempDir, { recursive: true, force: true });
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

    expect(doc.v).toBe(1);
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
        expect.objectContaining({ id: 'T001', status: 'completed' }),
        expect.objectContaining({ id: 'T002', status: 'assigned' }),
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

    appendSnapshot(stateDir, featureId, {
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

    // Tail folded state: T100 stays completed; T101 promoted assigned→completed
    // by tail; T102 added-then-failed by tail.
    const byId = new Map(doc.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T100')).toBe('completed');
    expect(byId.get('T101')).toBe('completed');
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
    expect(doc.v).toBe(1);
    expect(doc.projectionSequence).toBe(0);
    expect(doc.taskProgress).toEqual([]);
    expect(doc.blockers).toEqual([]);
    // Initial document still validates under the schema.
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);
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
      //   from the state-store — v:1, sequence 0, populated workflowState.
      const doc = result.data as RehydrationDocument;
      expect(doc.v).toBe(1);
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

    // Corrupt the sidecar — malformed JSON that will fail parse.
    const sidecar = path.join(stateDir, `${featureId}.projections.jsonl`);
    await writeFile(sidecar, '{not-valid-json\n', 'utf8');

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
    //   from the state store — v:1, projectionSequence 0, populated
    //   workflowState.
    const doc = result.data as RehydrationDocument;
    expect(doc.v).toBe(1);
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
