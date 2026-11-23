import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigHookRunner } from '../../../src/hooks/config-hooks.js';
import {
  bindProjectHooks,
  HOOK_TRUST_FILENAME,
  type BoundProjectHooks,
} from '../../../src/hooks/hook-trust.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import { makeTempDir, rmrf } from '../../../tools/test-helpers/temp-dir.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

const dirs: string[] = [];

/**
 * Binds `on` for a scratch project after the test writes a matching trust record.
 * The runner gets the same bound object that production builds.
 */
function trusted(on: ResolvedProjectConfig['hooks']['on']): BoundProjectHooks {
  const stateDir = makeTempDir('hook-runner-state-');
  const projectRoot = realpathSync(makeTempDir('hook-runner-project-'));
  dirs.push(stateDir, projectRoot);
  const first = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });
  if (first.kind !== 'untrusted') throw new Error(`expected untrusted, got ${first.kind}`);
  writeFileSync(
    join(stateDir, HOOK_TRUST_FILENAME),
    JSON.stringify({ projects: { [first.projectRoot]: { hooksDigest: first.digest } } }),
  );
  const second = bindProjectHooks({ stateDir, projectRoot, hooks: { on } });
  if (second.kind !== 'trusted') throw new Error(`expected trusted, got ${second.kind}`);
  return second.hooks;
}

describe('createConfigHookRunner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSpawn.mockClear();
    process.env = { ...originalEnv };
    delete process.env.EXARCHOS_SKIP_HOOKS;
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of dirs.splice(0, dirs.length)) rmrf(dir);
  });

  it('ConfigHookRunner_MatchingEvent_ExecutesCommand', async () => {
    const hooks = trusted({ 'workflow.transition': [{ command: 'echo test', timeout: 30000 }] });

    const runner = createConfigHookRunner(hooks);
    await runner({
      type: 'workflow.transition',
      data: { phase: 'plan' },
      featureId: 'test-feature',
      timestamp: new Date().toISOString(),
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'echo',
      ['test'],
      expect.objectContaining({
        cwd: hooks.projectRoot,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('ConfigHookRunner_QuotedArgument_PassesOneArgument', async () => {
    const hooks = trusted({ 'task.completed': [{ command: './notify.sh --msg "task done"', timeout: 30000 }] });

    await createConfigHookRunner(hooks)({
      type: 'task.completed',
      data: {},
      featureId: 'f',
      timestamp: '',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      './notify.sh',
      ['--msg', 'task done'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('ConfigHookRunner_NoMatchingHooks_Noop', async () => {
    const hooks = trusted({ 'gate.executed': [{ command: 'echo gate', timeout: 30000 }] });

    const runner = createConfigHookRunner(hooks);
    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: new Date().toISOString(),
    });

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ConfigHookRunner_PrototypeEventType_Noop', async () => {
    const hooks = trusted({ 'gate.executed': [{ command: 'echo gate', timeout: 30000 }] });

    const runner = createConfigHookRunner(hooks);
    for (const type of ['constructor', 'toString', '__proto__']) {
      await runner({ type, data: {}, featureId: 'test', timestamp: '' });
    }

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ConfigHookRunner_StdinReceivesEventJson', async () => {
    const hooks = trusted({ 'task.completed': [{ command: 'cat', timeout: 30000 }] });

    const mockStdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
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
    const runner = createConfigHookRunner(hooks);
    await runner(event);

    expect(mockStdin.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockStdin.write).toHaveBeenCalledWith(JSON.stringify(event));
    expect(mockStdin.end).toHaveBeenCalled();
  });

  it('ConfigHookRunner_EnvVarsSet_Correctly', async () => {
    const hooks = trusted({ 'workflow.transition': [{ command: 'env', timeout: 30000 }] });

    const runner = createConfigHookRunner(hooks);
    await runner({
      type: 'workflow.transition',
      data: { phase: 'review', workflowType: 'feature' },
      featureId: 'my-feat',
      timestamp: '',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'env',
      [],
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
    const hooks = trusted({ 'test.event': [{ command: 'false', timeout: 30000 }] });

    mockSpawn.mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') cb(new Error('fail'));
      }),
      kill: vi.fn(),
    } as unknown as ReturnType<typeof spawn>);

    const runner = createConfigHookRunner(hooks);
    await expect(
      runner({ type: 'test.event', data: {}, featureId: 'test', timestamp: '' }),
    ).resolves.not.toThrow();
  });

  it('ConfigHookRunner_MultipleHooks_AllFired', async () => {
    const hooks = trusted({
      'workflow.transition': [
        { command: 'echo first', timeout: 30000 },
        { command: 'echo second', timeout: 30000 },
      ],
    });

    const runner = createConfigHookRunner(hooks);
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

    const hooks = trusted({ 'workflow.transition': [{ command: 'echo test', timeout: 30000 }] });

    const runner = createConfigHookRunner(hooks);
    await runner({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: '',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ConfigHookRunner_UntrustedBinding_NeverSpawns', async () => {
    const stateDir = makeTempDir('hook-runner-state-');
    const projectRoot = makeTempDir('hook-runner-project-');
    dirs.push(stateDir, projectRoot);
    const binding = bindProjectHooks({
      stateDir,
      projectRoot,
      hooks: { on: { 'workflow.transition': [{ command: 'echo test', timeout: 30000 }] } },
    });

    await createConfigHookRunner(binding.hooks)({
      type: 'workflow.transition',
      data: {},
      featureId: 'test',
      timestamp: '',
    });

    expect(binding.kind).toBe('untrusted');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
