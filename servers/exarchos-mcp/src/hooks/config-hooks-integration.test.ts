import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfigHookRunner } from './config-hooks.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { spawn } from 'child_process';

describe('Config Hook Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('EventStore_Append_TriggersConfigHook', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: {
        on: { 'workflow.transition': [{ command: './notify.sh', timeout: 10000 }] },
      },
    };

    const runner = createConfigHookRunner(config);

    // Simulate what would happen when EventStore appends a workflow.transition event
    const event = {
      type: 'workflow.transition',
      data: { phase: 'review', from: 'delegate', workflowType: 'feature' },
      featureId: 'ext-points',
      timestamp: new Date().toISOString(),
    };

    await runner(event);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'sh',
      ['-c', './notify.sh'],
      expect.anything(),
    );
  });

  it('EventStore_Append_NoProjectConfig_NoHooks', async () => {
    // With default config (no hooks configured), nothing fires
    const runner = createConfigHookRunner(DEFAULTS);

    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: '',
    });

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('EventStore_BatchAppend_TriggersHooksForEach', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: {
        on: { 'task.completed': [{ command: 'echo done', timeout: 30000 }] },
      },
    };

    const runner = createConfigHookRunner(config);

    // Simulate batch append of 3 events
    const events = [
      { type: 'task.completed', data: { taskId: '1' }, featureId: 'f', timestamp: '' },
      { type: 'task.completed', data: { taskId: '2' }, featureId: 'f', timestamp: '' },
      { type: 'task.completed', data: { taskId: '3' }, featureId: 'f', timestamp: '' },
    ];

    for (const event of events) {
      await runner(event);
    }

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
  });
});
