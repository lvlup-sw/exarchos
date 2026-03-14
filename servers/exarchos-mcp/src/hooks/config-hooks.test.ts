import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConfigHookRunner } from './config-hooks.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

// Mock child_process.spawn
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
const mockSpawn = vi.mocked(spawn);

describe('createConfigHookRunner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EXARCHOS_SKIP_HOOKS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('ConfigHookRunner_MatchingEvent_ExecutesCommand', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: { on: { 'workflow.transition': [{ command: 'echo test', timeout: 30000 }] } },
    };

    const runner = createConfigHookRunner(config);
    await runner({
      type: 'workflow.transition',
      data: { phase: 'plan' },
      featureId: 'test-feature',
      timestamp: new Date().toISOString(),
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'echo test'],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('ConfigHookRunner_NoMatchingHooks_Noop', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: { on: { 'gate.executed': [{ command: 'echo gate', timeout: 30000 }] } },
    };

    const runner = createConfigHookRunner(config);
    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: new Date().toISOString(),
    });

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ConfigHookRunner_StdinReceivesEventJson', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: { on: { 'task.completed': [{ command: 'cat', timeout: 30000 }] } },
    };

    const mockStdin = { write: vi.fn(), end: vi.fn() };
    mockSpawn.mockReturnValue({
      stdin: mockStdin,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as unknown as ReturnType<typeof spawn>);

    const event = {
      type: 'task.completed',
      data: { taskId: 't1' },
      featureId: 'feat-1',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const runner = createConfigHookRunner(config);
    await runner(event);

    expect(mockStdin.write).toHaveBeenCalledWith(JSON.stringify(event));
    expect(mockStdin.end).toHaveBeenCalled();
  });

  it('ConfigHookRunner_EnvVarsSet_Correctly', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: { on: { 'workflow.transition': [{ command: 'env', timeout: 30000 }] } },
    };

    const runner = createConfigHookRunner(config);
    await runner({
      type: 'workflow.transition',
      data: { phase: 'review', workflowType: 'feature' },
      featureId: 'my-feat',
      timestamp: '',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'env'],
      expect.objectContaining({
        env: expect.objectContaining({
          EXARCHOS_FEATURE_ID: 'my-feat',
          EXARCHOS_PHASE: 'review',
          EXARCHOS_EVENT_TYPE: 'workflow.transition',
          EXARCHOS_WORKFLOW_TYPE: 'feature',
        }),
      }),
    );
  });

  it('ConfigHookRunner_CommandFailure_DoesNotThrow', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: { on: { 'test.event': [{ command: 'false', timeout: 30000 }] } },
    };

    mockSpawn.mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') cb(new Error('fail'));
      }),
      kill: vi.fn(),
    } as unknown as ReturnType<typeof spawn>);

    const runner = createConfigHookRunner(config);
    // Should not throw
    await expect(
      runner({ type: 'test.event', data: {}, featureId: 'test', timestamp: '' }),
    ).resolves.not.toThrow();
  });

  it('ConfigHookRunner_MultipleHooks_AllFired', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: {
        on: {
          'workflow.transition': [
            { command: 'echo first', timeout: 30000 },
            { command: 'echo second', timeout: 30000 },
          ],
        },
      },
    };

    const runner = createConfigHookRunner(config);
    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: '',
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('ConfigHookRunner_TestEnv_SkipsExecution', async () => {
    process.env.EXARCHOS_SKIP_HOOKS = 'true';

    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      hooks: { on: { 'workflow.transition': [{ command: 'echo test', timeout: 30000 }] } },
    };

    const runner = createConfigHookRunner(config);
    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: '',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
