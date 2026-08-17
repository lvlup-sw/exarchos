// ─── T29 (#1273) — Tasks dispatch-core lifecycle (outcome) ──────────────────
//
// Outcome-tier pin for the Wave C / PR 1 contract: when a dispatch is
// invoked with the SDK `task: { ttl }` augmentation, the dispatch core
// MUST emit the full `task.*` lifecycle on the task's namespaced stream:
//
//   - `task.created`  — emitted synchronously inside dispatch (B3 store).
//   - `task.polled`   — emitted on every `tasksStore.getTask()` read.
//   - `task.result`   — emitted when the underlying handler resolves.
//
// All three events MUST share the parent dispatch's `operationId` (B1 /
// #1291 ALS threading) so audit queries can partition the task lifecycle
// by the dispatch that opened it. The MCP adapter (C2) and the CLI
// `--follow` loop (C3) rely on this invariant — they do NOT re-stamp
// operationId; they trust the ALS scope captured in `runTasksAugmented`.
//
// The lifecycle is the load-bearing observable. We DO NOT assert wire
// shape of the CreateTaskResult here (unit-level coverage in
// `dispatch/tasks-augmented.test.ts` and `dispatch/core/dispatch.test.ts` already
// pins that); this test pins the event-stream sequence end-to-end.

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

async function mktemp(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `outcome-1273-${label}-`));
}

/**
 * Wait for a predicate over the events on a stream to hold, polling at a
 * short interval. Bounded to avoid hanging the suite on regression. Used
 * to await the background `task.result` emission from the Tasks-augmented
 * branch's fire-and-poll execution.
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
  it('DispatchCore_TaskLifecycle_EmitsCreatedPolledResult', async () => {
    const stateDir = await mktemp('lifecycle');
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const taskStore = new EventSourcedTaskStore(eventStore);

    // Stub the underlying composite to return a deterministic ToolResult.
    // The Tasks-augmented branch wraps this as `task.result` once the
    // background promise resolves.
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

      // Dispatch with task augmentation — `task: { ttl }` triggers the
      // synthesis branch and returns a CreateTaskResult-shaped envelope
      // immediately while the underlying handler runs in the background.
      const result = await dispatch(
        'exarchos_workflow',
        { action: 'describe', task: { ttl: 60_000 } },
        ctx,
      );
      expect(result.success).toBe(true);
      const taskId = (result.data as { task: { taskId: string } }).task.taskId;
      const stream = `task-store/${taskId}`;

      // Drive a `getTask` read so `task.polled` lands. (T29 GREEN wires
      // emission inside `EventSourcedTaskStore.getTask`.)
      const polled = await taskStore.getTask(taskId);
      expect(polled).not.toBeNull();

      // Wait for the background execution to flush `task.result`.
      const events = await waitForEvent(eventStore, stream, (es) =>
        es.some((e) => e.type === 'task.result'),
      );

      // Lifecycle assertions ────────────────────────────────────────────
      const types = events.map((e) => e.type);
      expect(types).toContain('task.created');
      expect(types).toContain('task.polled');
      expect(types).toContain('task.result');

      // The dispatch operationId is surfaced on the response _meta and
      // MUST match every emitted event's operationId (ALS threading from
      // B1 — applies to the synchronous `task.created` AND the background
      // `task.result`/`task.polled` events because the synthesis surface
      // re-enters the captured ALS scope).
      const dispatchOp = (result as { _meta?: { operationId?: string } })._meta
        ?.operationId;
      expect(typeof dispatchOp).toBe('string');
      expect(dispatchOp!.length).toBeGreaterThan(0);

      // The dispatch-owned events (`task.created`, `task.result`) MUST
      // carry the parent dispatch's operationId — that is the ALS threading
      // contract from B1 / #1291 and is the load-bearing audit guarantee
      // for the C1 Tasks-augmented branch. `task.polled` is emitted from
      // wherever the caller invokes `tasksStore.getTask`; in this test we
      // call it directly outside the dispatch boundary, so its operationId
      // reflects the ambient scope (none). The MCP adapter (C2) will route
      // `tasks/get` through its own dispatch boundary, where polled events
      // inherit the poll's own operationId — that interaction is pinned in
      // C2's adapter outcome test, not here.
      const opByType = new Map<string, string | undefined>();
      for (const evt of events) {
        opByType.set(evt.type, (evt as { operationId?: string }).operationId);
      }
      expect(opByType.get('task.created')).toBe(dispatchOp);
      expect(opByType.get('task.result')).toBe(dispatchOp);
      // task.polled MUST carry an operationId when emitted inside a
      // dispatch scope; this direct-call site has no scope, so we assert
      // the event is present (above) without constraining its operationId.
      expect(opByType.has('task.polled')).toBe(true);
    } finally {
      restore();
      await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
