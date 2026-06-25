/**
 * MCP `tools/call` handler — task-augmented branch acceptance (#1273 / C2, T30).
 *
 * Two load-bearing checks for the MCP adapter's `tools/call` surface:
 *
 *   1. McpToolsCall_WithTaskTtl_ReturnsCreateTaskResult — when the caller
 *      threads `task: { ttl: <ms> }` into `tools/call` params, the response
 *      payload carries the SDK `CreateTaskResult` shape
 *      (`{ task: { taskId, status: 'working', ttl } }`) wrapped in the
 *      Exarchos envelope. The MCP adapter MUST pass the `task` option
 *      through to dispatch-core so the augmentation routes via
 *      `runTasksAugmented` from C1.
 *   2. McpToolsCall_NoTaskTtl_ReturnsEnvelopeOneShot — without the `task`
 *      key, the response stays on the legacy one-shot envelope shape
 *      (`{ success, data, ... }`). This pins the regression guard so the
 *      new code path cannot leak Tasks shape into one-shot callers.
 *
 * The test invokes the handler module directly (not via `client.callTool`)
 * because the adapter's contract is: "given args including `task`, route
 * dispatch through the augmented surface." The end-to-end SDK round-trip
 * is covered separately by `__tests__/integration/tools-call.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { EventSourcedTaskStore } from '../task-store/event-sourced-task-store.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleToolsCall } from './tools-call-handler.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

describe('MCP tools/call handler — task augmentation (#1273 / T30)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let taskStore: EventSourcedTaskStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'tools-call-handler-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    taskStore = new EventSourcedTaskStore(eventStore);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('McpToolsCall_WithTaskTtl_ReturnsCreateTaskResult', async () => {
    // Build a context with the task substrate wired (the augmentation
    // path is gated on `ctx.taskStore` per dispatch-core's C1 contract).
    // The client capability must declare tasks support so the augmentation
    // resolves (T32 gating).
    const resolver = createInMemoryResolver([]);
    resolver.snapshot({ capabilities: { tasks: {} } });
    const ctx: DispatchContext = {
      stateDir,
      eventStore,
      enableTelemetry: false,
      taskStore,
      capabilityResolver: resolver,
    };

    const envelope = await handleToolsCall(
      'exarchos_event',
      { action: 'query', stream: 'nonexistent', task: { ttl: 60_000 } },
      ctx,
    );

    // SDK CreateTaskResult shape: { task: { taskId, status, ttl, ... } }
    // wrapped in the success envelope.
    expect(envelope.success).toBe(true);
    expect(envelope.success === true ? envelope.data : undefined).toBeDefined();
    if (!envelope.success) throw new Error('expected success envelope');
    const data = envelope.data as {
      task?: { taskId?: string; status?: string; ttl?: number | null };
    };
    expect(data.task).toBeDefined();
    expect(typeof data.task!.taskId).toBe('string');
    expect(data.task!.taskId!.length).toBeGreaterThan(0);
    expect(data.task!.status).toBe('working');
    expect(data.task!.ttl).toBe(60_000);
  });

  it('McpToolsCall_NoTaskTtl_ReturnsEnvelopeOneShot', async () => {
    const ctx: DispatchContext = {
      stateDir,
      eventStore,
      enableTelemetry: false,
      taskStore,
    };

    const envelope = await handleToolsCall(
      'exarchos_event',
      { action: 'query', stream: 'nonexistent' },
      ctx,
    );

    expect(envelope.success).toBe(true);
    if (!envelope.success) throw new Error('expected success envelope');
    // One-shot path: `data` carries the dispatched handler's own shape —
    // explicitly NOT the `{ task: { taskId, ... } }` synthesis surface.
    const data = envelope.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    expect((data as { task?: unknown }).task).toBeUndefined();
  });
});
