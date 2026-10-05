/**
 * Outcome test for the `task.*` events of a dispatch with the `task: { ttl }` augmentation.
 *
 * The dispatch core must append three events to the stream `task-store/<taskId>`. `task.created`
 * comes when dispatch creates the task, and `task.polled` comes on a `getTask` read. `task.result`
 * comes when the handler resolves. `task.created` and `task.result` must carry the `operationId` of
 * the dispatch.
 *
 * The test asserts that the events exist, not their order. Unit tests cover the shape of the task
 * result that dispatch returns.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import {
  dispatch,
  stubCompositeHandler,
  type DispatchContext,
} from '../../src/dispatch/core/dispatch.js';
import { EventSourcedTaskStore } from '../../src/projections/task-store/event-sourced-task-store.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

async function mktemp(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `outcome-1273-${label}-`));
}

/**
 * Polls the stream every 25 ms until `predicate` holds, and returns the events. It throws after
 * `timeoutMs`, so a regression cannot hang the suite. The test uses it to wait for the
 * `task.result` event that the background execution appends.
 */
async function waitForEvent(
  eventStore: EventStore,
  streamId: string,
  predicate: (events: readonly { type: string }[]) => boolean,
  timeoutMs = 2_000,
): Promise<readonly { type: string }[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await eventStore.query(streamId);
    if (predicate(events)) return events;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for predicate over stream "${streamId}"`,
  );
}

describe('Tasks dispatch-core lifecycle (#1273 / T29)', () => {
  /**
   * A stub replaces the composite handler, so the result is deterministic. The dispatch returns the
   * task at once, and the handler runs in the background. `_meta.operationId` of the response is
   * the `operationId` of the dispatch, and `task.created` and `task.result` must carry it.
   *
   * The test calls `getTask` outside a dispatch, so `task.polled` has no dispatch scope. The test
   * asserts only that the event exists.
   */
  it('DispatchCore_TaskLifecycle_EmitsCreatedPolledResult', async () => {
    const stateDir = await mktemp('lifecycle');
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const taskStore = new EventSourcedTaskStore(eventStore);

    const restore = stubCompositeHandler('exarchos_workflow', async () => ({
      success: true as const,
      data: { kind: 'composite-output', value: 42 },
    }));

    try {
      const ctx: DispatchContext = {
        stateDir,
        eventStore,
        enableTelemetry: false,
        taskStore,
      };

      const result = await dispatch(
        'exarchos_workflow',
        { action: 'describe', task: { ttl: 60_000 } },
        ctx,
      );
      expect(result.success).toBe(true);
      const taskId = (result.data as { task: { taskId: string } }).task.taskId;
      const stream = `task-store/${taskId}`;

      const polled = await taskStore.getTask(taskId);
      expect(polled).not.toBeNull();

      const events = await waitForEvent(eventStore, stream, (es) =>
        es.some((e) => e.type === 'task.result'),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain('task.created');
      expect(types).toContain('task.polled');
      expect(types).toContain('task.result');

      const dispatchOp = (result as { _meta?: { operationId?: string } })._meta
        ?.operationId;
      expect(typeof dispatchOp).toBe('string');
      expect(dispatchOp!.length).toBeGreaterThan(0);

      const opByType = new Map<string, string | undefined>();
      for (const evt of events) {
        opByType.set(evt.type, (evt as { operationId?: string }).operationId);
      }
      expect(opByType.get('task.created')).toBe(dispatchOp);
      expect(opByType.get('task.result')).toBe(dispatchOp);
      expect(opByType.has('task.polled')).toBe(true);
    } finally {
      restore();
      await rmrfAsync(stateDir);
    }
  });
});
