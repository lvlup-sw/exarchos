/**
 * Acceptance tests for the three correlation fields, from the dispatch context to the stored event.
 * `correlationId` is the same for a parent dispatch and its child dispatches, and each dispatch has its own `operationId`.
 * `causationId` on a follow-up dispatch names the upstream event, and the parent `correlationId` stays.
 * 100 independent dispatches give 100 distinct `operationId` values, and each event carries the `operationId` of its dispatch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { EventStore } from '../../src/events/store.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../src/dispatch/dispatch-context.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let eventStore: EventStore;

/** Each test gets a new temporary directory and a new `EventStore`, so correlation ids cannot leak between tests. */
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'corr-acceptance-'));
  eventStore = new EventStore(tempDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('#1291 acceptance — correlation propagation across a wave', () => {
  /**
   * The parent seeds a readable `correlationId`. Each child mints its own context with that id, as an orchestrator does for its subagents.
   * Child A uses `append` and child B uses `batchAppend`, so both stamp paths run.
   * The assertions read through `query` with a `correlationId` filter, so the full read path is part of the test.
   */
  it('Wave_OrchestratorDispatchesTwoSubagents_AllEventsShareCorrelationId', async () => {
    const parentCorrelation = 'parent-cor-1';

    const childAStream = 'wave-child-a';
    const childBStream = 'wave-child-b';

    const parentCtx = mintDispatchContext({ correlationId: parentCorrelation });

    const { childAOperationId, childBOperationId } = await runWithDispatchContext(
      parentCtx,
      async () => {
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

    const childAEvents = await eventStore.query(childAStream, {
      correlationId: parentCorrelation,
    });
    const childBEvents = await eventStore.query(childBStream, {
      correlationId: parentCorrelation,
    });

    const all = [...childAEvents, ...childBEvents];
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(childAEvents).toHaveLength(2);
    expect(childBEvents).toHaveLength(3);

    expect(all.every((e) => e.correlationId === parentCorrelation)).toBe(true);

    const aOps = new Set(childAEvents.map((e) => e.operationId));
    const bOps = new Set(childBEvents.map((e) => e.operationId));
    expect(aOps.size).toBe(1);
    expect(bOps.size).toBe(1);
    expect([...aOps][0]).toBe(childAOperationId);
    expect([...bOps][0]).toBe(childBOperationId);
    expect(childAOperationId).not.toBe(childBOperationId);
  });
});

describe('#1291 acceptance — causation chain across auto-dispatch', () => {
  /**
   * This test covers the dispatch context and the event store only. No production handler starts a follow-up dispatch from a `next_actions` hint.
   * The CLI and MCP adapters dispatch one time and return the envelope, and the caller of the tool does the follow-up.
   * Thus the test builds the second dispatch by hand, with `mintDispatchContext` and `runWithDispatchContext`.
   * A future production handler for follow-up dispatches needs its own integration test, and this test must stay.
   *
   * A `WorkflowEvent` has no `eventId` field, so the causation pointer is `<streamId>#<sequence>` of the upstream event.
   * The second dispatch has its own `operationId`. It keeps the parent `correlationId` and carries the pointer as `causationId`.
   * `Cli_OneShotDispatch_PreservesNextActionsField` in `tests/unit/adapters/cli/cli-format.test.ts` checks that the one-shot CLI pipeline keeps `next_actions`.
   */
  it('AutoDispatch_FromNextActionsHint_CarriesCausationIdReferencingUpstreamEvent', async () => {
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

    expect(upstreamEvent.correlationId).toBe(parentCorrelation);
    const upstreamEventId = `${upstreamEvent.streamId}#${upstreamEvent.sequence}`;
    expect(upstreamEventId).toBeTruthy();

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

    const byCausation = await eventStore.query(downstreamStream, {
      causationId: upstreamEventId,
    });
    expect(byCausation).toHaveLength(2);
    expect(
      byCausation.every((e) => e.causationId === upstreamEventId),
    ).toBe(true);
    expect(
      byCausation.every((e) => e.correlationId === parentCorrelation),
    ).toBe(true);

    expect(
      byCausation.every((e) => e.operationId === downstreamCtx.operationId),
    ).toBe(true);
    expect(downstreamCtx.operationId).not.toBe(upstreamCtx.operationId);
  });
});

describe('#1291 acceptance — operationId uniqueness across many dispatches', () => {
  /**
   * Each of the 100 dispatches has no incoming correlation, so each context is a chain root with a new `operationId`.
   * Each dispatch writes 1 to 3 events with `append` to its own stream, so a query of that stream returns only its events.
   * The `operationId` values must be distinct, and each stored event must carry the `operationId` of its dispatch.
   */
  it('OperationId_AcrossManyDispatches_AllUnique_AllEventsTaggedToParent', async () => {
    const DISPATCH_COUNT = 100;
    const operationIds: string[] = [];
    const dispatchToEvents = new Map<
      string,
      Array<{ streamId: string; sequence: number }>
    >();

    for (let i = 0; i < DISPATCH_COUNT; i++) {
      const ctx = mintDispatchContext();
      operationIds.push(ctx.operationId);

      const streamId = `dispatch-${randomUUID()}`;

      const eventCount = (i % 3) + 1;

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

    expect(new Set(operationIds).size).toBe(DISPATCH_COUNT);

    for (const operationId of operationIds) {
      const expectedEvents = dispatchToEvents.get(operationId);
      expect(expectedEvents).toBeDefined();
      expect(expectedEvents!.length).toBeGreaterThan(0);

      const streamId = expectedEvents![0].streamId;
      const queried = await eventStore.query(streamId);
      expect(queried).toHaveLength(expectedEvents!.length);
      expect(queried.every((e) => e.operationId === operationId)).toBe(true);
    }
  });
});
