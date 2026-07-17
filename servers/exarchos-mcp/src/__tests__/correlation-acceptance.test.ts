// ─── #1291 acceptance trio — three-field correlation, end-to-end ───────────
//
// These three tests are the load-bearing acceptance gates that PR #1428
// deferred and that Waves 1-5 of the correlation-indexed-columns plan
// (#1437) wire up. They exercise the WHOLE stack — schema columns +
// writer-path stamping + filter API + dispatch-context propagation —
// rather than any single layer.
//
// Each test names a single property:
//
//   T16: `correlationId` survives across a parent dispatch + two child
//        dispatches in the same wave, but each dispatch mints a
//        distinct `operationId`.
//   T17: `causationId` survives the one-hop next_actions follow-up:
//        events emitted by the second dispatch carry the upstream
//        event's `eventId` AND the parent's `correlationId`.
//   T18: `operationId` uniqueness — 100 independent dispatches produce
//        100 distinct operationIds (UUID v4 collision is negligible);
//        every event emitted inside a given dispatch carries that
//        dispatch's operationId verbatim.
//
// All three are RED → GREEN-on-first-run: the entire correlation stack
// is wired by Waves 2-5, so these tests verify the wiring is correct,
// not that new production code needs to be written. If any RED, the
// failure is a real gap in the lower waves.
//
// File location: `src/__tests__/correlation-acceptance.test.ts` — under
// `__tests__/` because the test crosses module boundaries (dispatch
// context + event store + storage backend) rather than co-locating
// with one production file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { EventStore } from '../event-store/store.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../dispatch/dispatch-context.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── Shared setup ──────────────────────────────────────────────────────────
//
// Each test gets a fresh tmpdir + EventStore so cross-test correlation
// IDs can't leak through the substrate. The setup is identical across the
// three tests — keeping it in one `beforeEach` (rather than per-`describe`)
// pins them in a single suite and supports the batched-commit shape the
// task description allows.

let tempDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'corr-acceptance-'));
  eventStore = new EventStore(tempDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

// ─── Task 16 ───────────────────────────────────────────────────────────────

describe('#1291 acceptance — correlation propagation across a wave', () => {
  it('Wave_OrchestratorDispatchesTwoSubagents_AllEventsShareCorrelationId', async () => {
    // Parent dispatch — models the orchestrator boundary. The parent
    // explicitly seeds `correlationId` so the wave's anchor is a
    // recognisable string; the parent's own `operationId` is fresh per
    // mintDispatchContext (we don't assert on its value here, only on
    // the children's).
    const parentCorrelation = 'parent-cor-1';

    // Two child dispatches happen INSIDE the parent's scope. Each child
    // re-mints a dispatch context that inherits the parent's
    // `correlationId` — modelling the orchestrator handing the
    // correlation down to subagents while each subagent mints its own
    // distinct operation boundary.
    const childAStream = 'wave-child-a';
    const childBStream = 'wave-child-b';

    const parentCtx = mintDispatchContext({ correlationId: parentCorrelation });

    const { childAOperationId, childBOperationId } = await runWithDispatchContext(
      parentCtx,
      async () => {
        // Child A: mint a fresh dispatch context inheriting the parent's
        // correlationId; emit 2 events on its own stream.
        const childACtx = mintDispatchContext({ correlationId: parentCorrelation });
        await runWithDispatchContext(childACtx, async () => {
          await eventStore.append(childAStream, {
            type: 'task.assigned',
            data: { taskId: 'a-1' },
          });
          await eventStore.append(childAStream, {
            type: 'task.claimed',
            data: { taskId: 'a-1' },
          });
        });

        // Child B: same shape, separate stream, separate operationId.
        // Use batchAppend to exercise the batch path inside the same
        // wave (Wave 3 stamps both single + batch paths from the
        // dispatch context).
        const childBCtx = mintDispatchContext({ correlationId: parentCorrelation });
        await runWithDispatchContext(childBCtx, async () => {
          await eventStore.batchAppend(childBStream, [
            { type: 'task.assigned', data: { taskId: 'b-1' } },
            { type: 'task.claimed', data: { taskId: 'b-1' } },
            { type: 'task.progressed', data: { taskId: 'b-1' } },
          ]);
        });

        return {
          childAOperationId: childACtx.operationId,
          childBOperationId: childBCtx.operationId,
        };
      },
    );

    // ── Assertions ────────────────────────────────────────────────────
    //
    // Query each stream by parent correlationId. With Wave 4 wired, the
    // filter is honoured at the storage layer (SqliteBackend's indexed
    // WHERE clause) and returns ONLY the events stamped with that
    // correlation anchor — which here is every event the wave emitted.

    const childAEvents = await eventStore.query(childAStream, {
      correlationId: parentCorrelation,
    });
    const childBEvents = await eventStore.query(childBStream, {
      correlationId: parentCorrelation,
    });

    // Total events across the wave: 2 (child A) + 3 (child B) = 5.
    // Task description says "6+" as a soft floor — the design lets the
    // test author pick; we picked 5 (2+3). Adjust the floor to 5.
    const all = [...childAEvents, ...childBEvents];
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(childAEvents).toHaveLength(2);
    expect(childBEvents).toHaveLength(3);

    // Every event carries the parent's correlationId (rehydrated from
    // the persisted column, NOT the raw db row — we go through `query`
    // so the test exercises the full read path).
    expect(all.every((e) => e.correlationId === parentCorrelation)).toBe(true);

    // Child A's events share one operationId; Child B's events share
    // another; the two operationIds are distinct (each dispatch is its
    // own boundary, even when nested under the same parent).
    const aOps = new Set(childAEvents.map((e) => e.operationId));
    const bOps = new Set(childBEvents.map((e) => e.operationId));
    expect(aOps.size).toBe(1);
    expect(bOps.size).toBe(1);
    expect([...aOps][0]).toBe(childAOperationId);
    expect([...bOps][0]).toBe(childBOperationId);
    expect(childAOperationId).not.toBe(childBOperationId);
  });
});

// ─── Task 17 ───────────────────────────────────────────────────────────────

describe('#1291 acceptance — causation chain across auto-dispatch', () => {
  // T17 — substrate-only by design.
  //
  // T17 verifies the storage substrate's ability to carry `causationId`
  // across two dispatch boundaries. The second dispatch is synthesized
  // manually via `mintDispatchContext` + `runWithDispatchContext` because
  // NO PRODUCTION AUTO-DISPATCH HANDLER EXISTS to drive a follow-up from a
  // `ToolResult.next_actions[]` hint. Both `adapters/cli.ts`
  // (lines 557-596) and `adapters/mcp.ts` (lines 354-389) are strictly
  // one-shot: they dispatch once, return the envelope, and exit. No code in
  // `servers/exarchos-mcp/src/` reads `result.next_actions` and invokes a
  // follow-up dispatcher.
  //
  // The HATEOAS follow-up pattern is documented as aspirational at
  // `dispatch/dispatch-context.ts:12-19` but unimplemented. The
  // orchestrator / agent harness (Claude Code itself, for the agent-loop
  // use case) is the consumer of `next_actions`; T17's manual synthesis
  // models that caller-driven path AT THE SUBSTRATE BOUNDARY.
  //
  // If a production auto-dispatch handler is ever added (e.g., a tight
  // orchestration loop inside the MCP server), extend this file with a
  // parallel `T17_Integration_*` variant — the substrate test below
  // remains load-bearing and distinct.
  //
  // See `docs/plans/archive/2026-05-16-correlation-consumer-wiring.md` Wave 1
  // Task 3 investigation (Branch B) for the search evidence; the
  // companion field-integrity regression guard for the one-shot pipeline
  // lives in `src/adapters/cli-format.test.ts` under
  // `Cli_OneShotDispatch_PreservesNextActionsField`.
  it('AutoDispatch_FromNextActionsHint_CarriesCausationIdReferencingUpstreamEvent', async () => {
    // Phase 1 — upstream dispatch. Emit an event; capture its
    // eventId. This event is the "upstream" that a `next_actions` hint
    // would reference when the orchestrator auto-dispatches a
    // follow-up.
    const parentCorrelation = 'parent-cor-causation';
    const upstreamStream = 'upstream-stream';
    const downstreamStream = 'downstream-stream';

    const upstreamCtx = mintDispatchContext({ correlationId: parentCorrelation });
    const upstreamEvent = await runWithDispatchContext(upstreamCtx, () =>
      eventStore.append(upstreamStream, {
        type: 'workflow.started',
        data: { featureId: 'cause-feature' },
      }),
    );

    // Sanity: the upstream event carries the parent correlation. The
    // event has no first-class `eventId` field (events identify by
    // (streamId, sequence) per WorkflowEventBase), so the natural
    // upstream identifier callers thread through as causationId is the
    // synthesized `${streamId}#${sequence}` pointer — that's what a
    // next_actions hint encodes when referencing an emitted event.
    expect(upstreamEvent.correlationId).toBe(parentCorrelation);
    const upstreamEventId = `${upstreamEvent.streamId}#${upstreamEvent.sequence}`;
    expect(upstreamEventId).toBeTruthy();

    // Phase 2 — auto-dispatch follow-up. The follow-up is its own
    // dispatch boundary (own operationId) but inherits the parent's
    // correlationId AND sets causationId to the upstream event's id.
    // Emit 2 downstream events; both must carry the same causation
    // pointer (the dispatch context stamps it on every emit).
    const downstreamCtx = mintDispatchContext({
      correlationId: parentCorrelation,
      causationId: upstreamEventId,
    });
    await runWithDispatchContext(downstreamCtx, async () => {
      await eventStore.append(downstreamStream, {
        type: 'task.assigned',
        data: { taskId: 'cause-1' },
      });
      await eventStore.append(downstreamStream, {
        type: 'task.claimed',
        data: { taskId: 'cause-1' },
      });
    });

    // ── Assertions ────────────────────────────────────────────────────

    // Query the downstream by causationId — Wave 4 honours the
    // causationId filter via the dedicated `idx_events_causation`
    // index. Both downstream events must come back.
    const byCausation = await eventStore.query(downstreamStream, {
      causationId: upstreamEventId,
    });
    expect(byCausation).toHaveLength(2);
    expect(
      byCausation.every((e) => e.causationId === upstreamEventId),
    ).toBe(true);
    // Same events also carry the parent correlationId — the chain
    // anchor survives the dispatch hop.
    expect(
      byCausation.every((e) => e.correlationId === parentCorrelation),
    ).toBe(true);

    // The downstream events do NOT carry the upstream's operationId —
    // they're inside a new dispatch boundary, so their operationId is
    // `downstreamCtx.operationId`, distinct from `upstreamCtx`.
    expect(
      byCausation.every((e) => e.operationId === downstreamCtx.operationId),
    ).toBe(true);
    expect(downstreamCtx.operationId).not.toBe(upstreamCtx.operationId);
  });
});

// ─── Task 18 ───────────────────────────────────────────────────────────────

describe('#1291 acceptance — operationId uniqueness across many dispatches', () => {
  it('OperationId_AcrossManyDispatches_AllUnique_AllEventsTaggedToParent', async () => {
    // 100 fresh dispatches, each with NO incoming correlation — the
    // self-bind rule in `mintDispatchContext` ties `correlationId` to
    // the freshly-minted `operationId`. So each of the 100 contexts
    // has a unique (operationId, correlationId) pair.
    const DISPATCH_COUNT = 100;
    const operationIds: string[] = [];
    // Per-dispatch event list: operationId expected to appear on each
    // event the dispatch emitted.
    const dispatchToEvents = new Map<
      string,
      Array<{ streamId: string; sequence: number }>
    >();

    for (let i = 0; i < DISPATCH_COUNT; i++) {
      // Fresh dispatch — no incoming. operationId === correlationId
      // by the self-bind rule (dispatch-context.ts:85).
      const ctx = mintDispatchContext();
      operationIds.push(ctx.operationId);

      // Each dispatch gets its OWN stream so we can query its events
      // back without ambiguity. Streams are derived from a fresh UUID
      // to avoid any cross-dispatch overlap.
      const streamId = `dispatch-${randomUUID()}`;

      // Emit 1-3 events per dispatch (varies so the property holds
      // across uneven batch sizes). Use append (single-event) so we
      // exercise the per-event stamping path.
      const eventCount = (i % 3) + 1; // 1, 2, 3, 1, 2, 3, ...

      const persisted: Array<{ streamId: string; sequence: number }> = [];
      await runWithDispatchContext(ctx, async () => {
        for (let j = 0; j < eventCount; j++) {
          const e = await eventStore.append(streamId, {
            type: 'task.progressed',
            data: { i, j },
          });
          persisted.push({ streamId: e.streamId, sequence: e.sequence });
        }
      });

      dispatchToEvents.set(ctx.operationId, persisted);
    }

    // ── Property 1: uniqueness ────────────────────────────────────────
    //
    // 100 freshly-minted UUID v4 operationIds. Collision probability is
    // negligible (~2^-122 per pair). Cardinality must equal count.
    expect(new Set(operationIds).size).toBe(DISPATCH_COUNT);

    // ── Property 2: every event carries its dispatch's operationId ───
    //
    // For each of the 100 dispatches, query its stream and assert every
    // returned event carries that dispatch's operationId. The
    // dispatch-context stamping happens at append-time
    // (event-store/store.ts:269), so the persisted column must hold
    // the dispatch's operationId verbatim.
    for (const operationId of operationIds) {
      const expectedEvents = dispatchToEvents.get(operationId);
      expect(expectedEvents).toBeDefined();
      expect(expectedEvents!.length).toBeGreaterThan(0);

      // All events for a single dispatch land on a single stream.
      const streamId = expectedEvents![0].streamId;
      const queried = await eventStore.query(streamId);
      // The stream was created in this dispatch only — so every event
      // on it is from the same operation.
      expect(queried).toHaveLength(expectedEvents!.length);
      expect(queried.every((e) => e.operationId === operationId)).toBe(true);
    }
  });
});
