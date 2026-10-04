/**
 * Task-support capability gating.
 *
 * The resolver snapshot records whether the client declared a `tasks` capability on the initialize handshake.
 * Dispatch checks the snapshot before it calls `runTasksAugmented`.
 * A client without that declaration cannot start a background task with a `task` key in the args.
 * Dispatch ignores the key and returns the one-shot envelope, because that client does not poll for a task result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { EventSourcedTaskStore } from '../../../../src/projections/task-store/event-sourced-task-store.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('Task-support capability gating (#1273 / T32)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let taskStore: EventSourcedTaskStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'task-support-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    taskStore = new EventSourcedTaskStore(eventStore);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /** Per the MCP spec, a `tasks` object of any shape is the declaration. */
  it('CapabilityResolver_TaskSupportOptional_Declared', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isTaskSupportDeclared()).toBe(false);

    resolver.snapshot({ capabilities: { tasks: {} } });
    expect(resolver.isTaskSupportDeclared()).toBe(true);

    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isTaskSupportDeclared()).toBe(false);
  });

  /**
   * The context has a task store, but the snapshot has no `tasks` capability.
   * Dispatch must not take the augmented branch, so `data` holds no top-level `task` field.
   */
  it('Dispatch_NoTaskSupportClient_FallsBackToOneShotIgnoringTaskOption', async () => {
    const resolver = createInMemoryResolver([]);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    const ctx: DispatchContext = {
      stateDir,
      eventStore,
      enableTelemetry: false,
      taskStore,
      capabilityResolver: resolver,
    };

    const result = await dispatch(
      'exarchos_event',
      { action: 'query', stream: 'nonexistent', task: { ttl: 60_000 } },
      ctx,
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    const data = result.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    expect((data as { task?: unknown }).task).toBeUndefined();
  });
});
