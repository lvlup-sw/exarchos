import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleEvent } from './composite.js';
import { EventStore } from './store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ConfigHookRunner } from '../hooks/config-hooks.js';

describe('handleEvent — hook runner wiring (R7)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'composite-hooks-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleEvent_AppendWithHookRunner_FiresHookAfterAppend', async () => {
    // Create a mock hook runner
    const hookRunner = vi.fn<ConfigHookRunner>();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      hookRunner,
    };

    // Append an event
    const result = await handleEvent({
      action: 'append',
      stream: 'test-feature',
      event: {
        type: 'workflow.started',
        data: { featureId: 'test-feature', workflowType: 'feature' },
      },
    }, ctx);

    expect(result.success).toBe(true);

    // Hook runner should have been called with the event info
    expect(hookRunner).toHaveBeenCalledTimes(1);
    expect(hookRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'workflow.started',
        featureId: 'test-feature',
      }),
    );
  });

  it('handleEvent_AppendWithoutHookRunner_SucceedsNormally', async () => {
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      // No hookRunner
    };

    const result = await handleEvent({
      action: 'append',
      stream: 'test-feature',
      event: {
        type: 'workflow.started',
        data: { featureId: 'test-feature', workflowType: 'feature' },
      },
    }, ctx);

    expect(result.success).toBe(true);
  });

  it('handleEvent_AppendFailure_DoesNotFireHook', async () => {
    const hookRunner = vi.fn<ConfigHookRunner>();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      hookRunner,
    };

    // Append with invalid event (no type) — should fail
    const result = await handleEvent({
      action: 'append',
      stream: 'test-feature',
      event: {},
    }, ctx);

    expect(result.success).toBe(false);
    // Hook runner should NOT have been called on failure
    expect(hookRunner).not.toHaveBeenCalled();
  });

  it('handleEvent_QueryAction_DoesNotFireHook', async () => {
    const hookRunner = vi.fn<ConfigHookRunner>();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      hookRunner,
    };

    // Query action should not fire hooks
    const result = await handleEvent({
      action: 'query',
      stream: 'test-feature',
    }, ctx);

    expect(result.success).toBe(true);
    expect(hookRunner).not.toHaveBeenCalled();
  });

  it('handleEvent_HookRunnerThrows_DoesNotAffectResult', async () => {
    const hookRunner = vi.fn<ConfigHookRunner>().mockRejectedValue(new Error('hook error'));

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      hookRunner,
    };

    // Append should still succeed even if hook throws
    const result = await handleEvent({
      action: 'append',
      stream: 'test-feature',
      event: {
        type: 'workflow.started',
        data: { featureId: 'test-feature', workflowType: 'feature' },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(hookRunner).toHaveBeenCalledTimes(1);
  });

  it('handleEvent_BatchAppendWithHookRunner_FiresHookForEachEvent', async () => {
    const hookRunner = vi.fn<ConfigHookRunner>();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      hookRunner,
    };

    const result = await handleEvent({
      action: 'batch_append',
      stream: 'test-feature',
      events: [
        { type: 'task.assigned', data: { taskId: 't1' } },
        { type: 'task.completed', data: { taskId: 't1' } },
      ],
    }, ctx);

    expect(result.success).toBe(true);

    // Hook runner should have been called once for each event in the batch
    expect(hookRunner).toHaveBeenCalledTimes(2);
    expect(hookRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.assigned',
        featureId: 'test-feature',
      }),
    );
    expect(hookRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.completed',
        featureId: 'test-feature',
      }),
    );
  });

  it('handleEvent_BatchAppendWithoutHookRunner_SucceedsNormally', async () => {
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      // No hookRunner
    };

    const result = await handleEvent({
      action: 'batch_append',
      stream: 'test-feature',
      events: [
        { type: 'task.assigned', data: { taskId: 't1' } },
      ],
    }, ctx);

    expect(result.success).toBe(true);
  });
});
