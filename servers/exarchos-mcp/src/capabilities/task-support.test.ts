/**
 * Task-support capability gating (#1273 / C2 T32).
 *
 * Two load-bearing checks for the task-augmentation capability
 * negotiation:
 *
 *   1. CapabilityResolver_TaskSupportOptional_Declared — the MCP server
 *      adapter advertises `tasks: {}` in its declared capabilities so
 *      clients can probe support via the initialize handshake. The
 *      effective declaration is per-tool `execution.taskSupport: 'optional'`
 *      (mirrored on the Exarchos server-side resolver snapshot of the
 *      client's tasks capability — declaring presence is enough).
 *   2. Dispatch_NoTaskSupportClient_FallsBackToOneShotIgnoringTaskOption —
 *      when the client did NOT declare a `tasks` capability via the
 *      initialize handshake, even an explicit \`task: { ttl }\` in the
 *      dispatched args is gracefully ignored. The dispatch path returns
 *      the legacy one-shot envelope.
 *
 * The gating order matters: the resolver snapshot reflects what the
 * client declared on the initialize handshake; \`runTasksAugmented\`
 * checks the snapshot at synthesis time so a client that never advertised
 * tasks support cannot opt in to long-running tasks by smuggling a
 * `task` key into args. This is the structural defense-in-depth boundary
 * between "the client said it can poll" and "the server pretends a
 * background task exists for a client that will never poll for it."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { EventSourcedTaskStore } from '../projections/task-store/event-sourced-task-store.js';
import { createInMemoryResolver } from './resolver.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

  it('CapabilityResolver_TaskSupportOptional_Declared', () => {
    // Resolver snapshot of a client that advertises tasks capability
    // (per MCP spec, presence of the `tasks` object — any shape — is
    // the declaration; the SDK ClientCapabilitiesSchema allows `tasks:
    // {}` as the bare gate).
    const resolver = createInMemoryResolver([]);
    expect(resolver.isTaskSupportDeclared()).toBe(false);

    resolver.snapshot({ capabilities: { tasks: {} } });
    expect(resolver.isTaskSupportDeclared()).toBe(true);

    // A snapshot WITHOUT the tasks capability returns false.
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isTaskSupportDeclared()).toBe(false);
  });

  it('Dispatch_NoTaskSupportClient_FallsBackToOneShotIgnoringTaskOption', async () => {
    // Client did NOT declare tasks support. Even with a wired TaskStore,
    // dispatch must NOT route through the augmented branch when the
    // resolver snapshot reports `tasks` was absent from the handshake.
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
    // One-shot path: `data` MUST NOT carry the `{ task: { taskId, ... } }`
    // synthesis shape. The legacy query result is whatever exarchos_event
    // returned — explicitly without a synthesised `task` field at the
    // top level.
    const data = result.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    expect((data as { task?: unknown }).task).toBeUndefined();
  });
});
